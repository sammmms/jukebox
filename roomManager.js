const fs = require('fs');
const path = require('path');

// Zero-dependency .env loader for local environments
['.env', '.env.local'].forEach(envFile => {
  const envPath = path.join(__dirname, envFile);
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const key = trimmed.slice(0, idx).trim();
          let val = trimmed.slice(idx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      });
    } catch (e) {}
  }
});

const IS_VERCEL = Boolean(process.env.VERCEL);
const APP_VERSION = '2.14.16';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

const DEFAULT_STARTER_TRACK = {
  videoId: 'bu7nU9Mhpyo',
  title: '告白气球 (Love Confession)',
  artist: '周杰伦 Jay Chou',
  thumbnail: 'https://i.ytimg.com/vi/bu7nU9Mhpyo/hqdefault.jpg',
  imageSrc: 'https://i.ytimg.com/vi/bu7nU9Mhpyo/hqdefault.jpg',
  songDuration: 215,
  elapsedSeconds: 0,
  isPaused: true,
  addedBy: 'Party Jukebox',
  startedAt: Date.now()
};

class Room {
  constructor(options = {}) {
    this.id = String(options.id || '').toUpperCase().slice(0, 6);
    this.code = this.id;
    this.name = options.name || (this.id ? `Party ${this.id}` : 'Private Party');
    this.creator = options.creator || 'Host';
    this.createdAt = options.createdAt || Date.now();
    this.lastActive = options.lastActive || Date.now();
    this.isRoomSleeping = Boolean(options.isRoomSleeping);

    // Connected devices & presence (Map<deviceId, { deviceId, name, baseName, email, lastHeartbeat, replaced }>)
    this.activeDevices = new Map();

    // Current Song
    this.currentSong = options.currentSong && options.currentSong.videoId ? {
      ...options.currentSong,
      songDuration: (typeof options.currentSong.songDuration === 'number' && options.currentSong.songDuration > 0) ? Math.round(options.currentSong.songDuration) : 215,
      imageSrc: options.currentSong.thumbnail || options.currentSong.imageSrc || '',
      isPaused: typeof options.currentSong.isPaused === 'boolean' ? options.currentSong.isPaused : true,
      startedAt: options.currentSong.startedAt || (options.currentSong.elapsedSeconds ? (Date.now() - Math.round(options.currentSong.elapsedSeconds * 1000)) : Date.now())
    } : { ...DEFAULT_STARTER_TRACK };

    // Queues & History
    this.partyQueue = Array.isArray(options.partyQueue) ? options.partyQueue : [];
    this.playedHistory = Array.isArray(options.playedHistory) ? options.playedHistory : [];
    this.activityLogs = Array.isArray(options.activityLogs) ? options.activityLogs : [];
    this.cleanDuplicateActivityLogs();

    // Host & DJ State
    this.partyHost = options.partyHost || {
      name: null,
      token: null,
      claimedAt: null,
      lastHeartbeat: null,
      clientType: null
    };
    this.pendingTakeover = options.pendingTakeover || null;
    this.knownDJs = new Set(Array.isArray(options.knownDJs) ? options.knownDJs : ['Host']);
    if (this.partyHost.name) this.knownDJs.add(this.partyHost.name);
    if (this.creator) this.knownDJs.add(this.creator);

    this.djProfiles = new Map(options.djProfiles ? Object.entries(options.djProfiles) : []);
    this.socialQueue = new Map();
    this.upvotes = new Map();

    // Volume & Local Audio Settings
    this.currentVolume = typeof options.currentVolume === 'number' ? options.currentVolume : 80;
    this.isMuted = Boolean(options.isMuted);

    // Playback Tracker
    this.playbackTracker = {
      videoId: this.currentSong.videoId || '',
      elapsed: this.currentSong.elapsedSeconds || 0,
      lastReportedElapsed: -1,
      isPaused: typeof this.currentSong.isPaused === 'boolean' ? this.currentSong.isPaused : true,
      songDuration: this.currentSong.songDuration || 215,
      lastUpdated: Date.now()
    };

    if (!this.playbackTracker.isPaused && this.currentSong.startedAt) {
      const wallClockElapsed = Math.max(0, (Date.now() - this.currentSong.startedAt) / 1000);
      this.playbackTracker.elapsed = wallClockElapsed;
      this.currentSong.elapsedSeconds = wallClockElapsed;
    }

    // SSE Clients listening to this room
    this.clients = new Set();
    this.lastAdvanceTime = 0;
  }

  touch() {
    this.lastActive = Date.now();
    if (this.isRoomSleeping) {
      this.isRoomSleeping = false;
      this.broadcastUpdate();
    }
  }

  isIdle() {
    // If listeners or active devices are connected, not idle
    if (this.clients.size > 0 || this.activeDevices.size > 0) return false;
    // If last activity was > 2 hours ago, considered idle
    const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
    return (Date.now() - this.lastActive) > IDLE_TIMEOUT_MS;
  }

  registerDevicePresence(deviceId, name, email, mode = 'check') {
    if (!deviceId) return { success: false, error: 'deviceId required' };
    const now = Date.now();
    const HEARTBEAT_TIMEOUT_MS = 45000;

    // 1. Clean stale devices (> 45s without ping)
    for (const [dId, dev] of this.activeDevices.entries()) {
      if (dId !== deviceId && (now - dev.lastHeartbeat > HEARTBEAT_TIMEOUT_MS)) {
        this.activeDevices.delete(dId);
      }
    }

    const cleanName = String(name || '').trim();
    if (!cleanName) return { success: false, error: 'name required' };
    
    // Normalize baseName by removing trailing [N]
    const baseName = cleanName.replace(/\s*\[\d+\]$/, '').trim();

    // Check if device was replaced
    const selfDevice = this.activeDevices.get(deviceId);
    if (selfDevice && selfDevice.replaced && mode !== 'takeover' && mode !== 'duplicate') {
      return { replaced: true, message: 'Sesi Anda telah dipindahkan ke perangkat lain.' };
    }

    // Find other devices with same baseName or same email
    const duplicates = [];
    for (const [dId, dev] of this.activeDevices.entries()) {
      if (dId !== deviceId && !dev.replaced) {
        const matchesName = (dev.baseName && dev.baseName.toLowerCase() === baseName.toLowerCase());
        const matchesEmail = (email && dev.email && dev.email.toLowerCase() === email.toLowerCase());
        if (matchesName || matchesEmail) {
          duplicates.push({ deviceId: dId, dev });
        }
      }
    }

    if (mode === 'check') {
      if (duplicates.length > 0) {
        return {
          isDuplicate: true,
          baseName,
          existingCount: duplicates.length,
          activeNames: duplicates.map(d => d.dev.name)
        };
      }
      const isNew = !selfDevice;
      // No duplicate, register self
      this.activeDevices.set(deviceId, {
        deviceId,
        name: baseName,
        baseName,
        email: email || '',
        lastHeartbeat: now,
        replaced: false
      });
      this.knownDJs.add(baseName);
      if (isNew) {
        this.addActivity(baseName, 'join', 'ke pesta');
      }
      this.broadcastUpdate();
      return { isDuplicate: false, finalName: baseName };
    }

    if (mode === 'takeover') {
      // Mark other duplicates as replaced (retained until stale cleanup so client receives replaced signal)
      for (const d of duplicates) {
        d.dev.replaced = true;
      }
      this.activeDevices.set(deviceId, {
        deviceId,
        name: baseName,
        baseName,
        email: email || '',
        lastHeartbeat: now,
        replaced: false
      });
      this.knownDJs.add(baseName);
      this.addActivity(baseName, 'takeover_device', `memindahkan sesi ke perangkat ini`);
      this.broadcastUpdate();
      return { success: true, finalName: baseName, isDuplicate: false };
    }

    if (mode === 'duplicate') {
      // Find highest [N] among duplicates
      let highestN = 1;
      for (const d of duplicates) {
        const match = d.dev.name.match(/\[(\d+)\]$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > highestN) highestN = num;
        }
      }
      const nextN = highestN + 1;
      const finalName = `${baseName} [${nextN}]`;
      this.activeDevices.set(deviceId, {
        deviceId,
        name: finalName,
        baseName,
        email: email || '',
        lastHeartbeat: now,
        replaced: false
      });
      this.knownDJs.add(finalName);
      this.addActivity(finalName, 'join_multi', `bergabung dari perangkat tambahan (${finalName})`);
      this.broadcastUpdate();
      return { success: true, finalName, isDuplicate: false, duplicateIndex: nextN };
    }

    // Heartbeat update (Strictly silent: NEVER log join activity)
    if (mode === 'heartbeat') {
      let shouldBroadcast = false;
      if (!selfDevice) {
        this.activeDevices.set(deviceId, {
          deviceId,
          name: cleanName,
          baseName,
          email: email || '',
          lastHeartbeat: now,
          replaced: false
        });
        this.knownDJs.add(cleanName);
        shouldBroadcast = true;
      } else {
        selfDevice.lastHeartbeat = now;
        if (selfDevice.name !== cleanName) {
          selfDevice.name = cleanName;
          selfDevice.baseName = baseName;
          shouldBroadcast = true;
        }
      }
      if (shouldBroadcast) {
        this.broadcastUpdate();
      }
      return { success: true, finalName: selfDevice ? selfDevice.name : cleanName };
    }

    if (selfDevice) {
      selfDevice.lastHeartbeat = now;
      return { success: true, finalName: selfDevice.name };
    }

    return { success: false, error: 'Unknown mode' };
  }

  isDeviceReplaced(deviceId) {
    if (!deviceId) return false;
    const dev = this.activeDevices.get(deviceId);
    return Boolean(dev && dev.replaced);
  }

  unregisterDevice(deviceId) {
    return this.removeDevice(deviceId);
  }

  removeDevice(deviceId) {
    if (!deviceId) return null;
    const dev = this.activeDevices.get(deviceId);
    if (dev) {
      this.activeDevices.delete(deviceId);
      this.touch();
      this.broadcastUpdate();
      return dev;
    }
    return null;
  }

  getActiveMembers() {
    const now = Date.now();
    const HEARTBEAT_TIMEOUT_MS = 45000;
    const hostName = (this.partyHost && this.partyHost.name) ? this.partyHost.name.toLowerCase() : null;
    const active = [];
    const seenNames = new Set();

    for (const [deviceId, dev] of this.activeDevices.entries()) {
      if (dev.replaced) continue;
      if (now - dev.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.activeDevices.delete(deviceId);
        continue;
      }
      const cleanName = dev.name;
      if (!seenNames.has(cleanName.toLowerCase())) {
        seenNames.add(cleanName.toLowerCase());
        active.push({
          name: cleanName,
          email: dev.email || '',
          isHost: Boolean(hostName && cleanName.toLowerCase() === hostName),
          lastHeartbeat: dev.lastHeartbeat
        });
      }
    }

    active.sort((a, b) => {
      if (a.isHost) return -1;
      if (b.isHost) return 1;
      return a.name.localeCompare(b.name);
    });

    return active;
  }

  getCalculatedElapsed() {
    if (this.playbackTracker.isPaused) {
      return this.playbackTracker.elapsed || 0;
    }
    const dur = (this.currentSong && this.currentSong.songDuration && this.currentSong.songDuration > 0)
      ? this.currentSong.songDuration
      : (this.playbackTracker.songDuration || 99999);

    const now = Date.now();
    // Prefer startedAt for drift-free wall-clock precision across serverless instances
    if (this.currentSong && this.currentSong.startedAt && this.currentSong.startedAt > 0) {
      const elapsedWallClock = (now - this.currentSong.startedAt) / 1000;
      if (elapsedWallClock >= 0) {
        return Math.min(dur, elapsedWallClock);
      }
    }

    const delta = (now - this.playbackTracker.lastUpdated) / 1000;
    return Math.min(dur, (this.playbackTracker.elapsed || 0) + Math.max(0, delta));
  }

  getPartyHostInfo() {
    this.checkHostVacant();
    const isVacant = this.partyHost.name === null;
    let pending = null;
    if (this.pendingTakeover && this.partyHost.name) {
      const elapsed = Date.now() - this.pendingTakeover.requestedAt;
      if (elapsed < 30000) {
        pending = {
          requestingDJ: this.pendingTakeover.requestingDJ,
          remainingSeconds: Math.max(0, Math.ceil((30000 - elapsed) / 1000))
        };
      } else {
        this.pendingTakeover = null;
      }
    }
    return {
      name: this.partyHost.name,
      token: this.partyHost.token,
      isVacant,
      claimedAt: this.partyHost.claimedAt,
      lastHeartbeat: this.partyHost.lastHeartbeat,
      pendingTakeover: pending
    };
  }

  checkHostVacant() {
    const HOST_VACANT_TIMEOUT_MS = 180000; // 3 minutes (prevents false drops when tab is throttled/backgrounded)
    if (this.partyHost.name) {
      if (Date.now() - (this.partyHost.lastHeartbeat || 0) > HOST_VACANT_TIMEOUT_MS) {
        const oldHost = this.partyHost.name;
        this.partyHost = { name: null, token: null, claimedAt: null, lastHeartbeat: null, clientType: null };
        this.pendingTakeover = null;
        this.addActivity('System', 'host_vacated', `Kursi Host dikosongkan karena ${oldHost} tidak merespons (timeout 3m)`);
        this.broadcastUpdate();
      }
    }
    if (this.pendingTakeover && this.partyHost.name) {
      const elapsed = Date.now() - this.pendingTakeover.requestedAt;
      if (elapsed >= 30000) {
        const newHost = this.pendingTakeover.requestingDJ;
        const newToken = this.pendingTakeover.token;
        this.partyHost = {
          name: newHost,
          token: newToken,
          claimedAt: Date.now(),
          lastHeartbeat: Date.now()
        };
        this.pendingTakeover = null;
        this.addActivity(newHost, 'takeover_auto', `mengambil alih kursi Host (otomatis setelah 30 detik tanpa penolakan)`);
        this.broadcastUpdate();
      }
    }
  }

  cleanDuplicateActivityLogs() {
    if (!Array.isArray(this.activityLogs)) return;
    const filtered = [];
    const lastJoinTimeByUser = new Map();
    for (const log of this.activityLogs) {
      if (log.type === 'join' || log.action === 'join') {
        const u = (log.user || log.dj || '').trim().toLowerCase();
        const prevTime = lastJoinTimeByUser.get(u);
        const curTime = typeof log.timestamp === 'number' ? log.timestamp : 0;
        if (prevTime !== undefined && Math.abs(prevTime - curTime) < 15 * 60 * 1000) {
          continue; // Drop duplicate join logs within 15 minutes
        }
        lastJoinTimeByUser.set(u, curTime);
      }
      filtered.push(log);
    }
    this.activityLogs = filtered;
  }

  addActivity(dj, type, details) {
    this.touch();
    // Prevent duplicate join spam
    if (type === 'join') {
      const u = String(dj || '').toLowerCase();
      const hasRecent = this.activityLogs.some(
        log => (log.user || log.dj || '').toLowerCase() === u && (log.type === 'join' || log.action === 'join') && (Date.now() - log.timestamp < 15 * 60 * 1000)
      );
      if (hasRecent) return;
    }
    this.activityLogs.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      user: dj,
      dj,
      action: type,
      type,
      details,
      timestamp: Date.now()
    });
    if (this.activityLogs.length > 50) this.activityLogs.pop();
  }

  addPlayedHistory(song) {
    if (!song || !song.videoId || song.title === 'No song playing') return;
    this.playedHistory.unshift({
      videoId: song.videoId,
      title: song.title,
      artist: song.artist || '',
      thumbnail: song.thumbnail || song.imageSrc || '',
      playedAt: Date.now(),
      addedBy: song.addedBy || 'Host'
    });
    // Deduplicate consecutive
    const seen = new Set();
    const filtered = [];
    for (const h of this.playedHistory) {
      const key = `${h.videoId}-${Math.floor((h.playedAt || 0) / 60000)}`;
      if (!seen.has(key)) {
        seen.add(key);
        filtered.push(h);
      }
    }
    this.playedHistory = filtered.slice(0, 50);
  }

  getFormattedQueue() {
    // Stable sort: higher upvotes bubble to the top, preserving FIFO order for equal votes
    const sorted = [...this.partyQueue].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
    return sorted.map((item, idx) => ({
      rawIndex: idx,
      videoId: item.videoId,
      title: item.title,
      artist: item.artist,
      thumbnail: item.thumbnail,
      songDuration: item.songDuration,
      duration: item.songDuration,
      selected: false,
      addedBy: item.addedBy,
      addedAt: item.addedAt,
      upvotes: item.upvotes || 0,
      votedUsers: item.votedUsers || []
    }));
  }

  getFullSsePayload(activePublicUrl = null) {
    const elapsed = this.getCalculatedElapsed();
    return `data: ${JSON.stringify({
      version: APP_VERSION,
      isVercel: IS_VERCEL,
      room: {
        id: this.id,
        code: this.id,
        name: this.name,
        creator: this.creator,
        listeners: this.clients.size,
        activeDJsCount: this.activeDevices ? this.activeDevices.size : 0
      },
      current: {
        ...this.currentSong,
        currentElapsed: elapsed,
        isPaused: this.playbackTracker.isPaused
      },
      queue: this.getFormattedQueue(),
      selectedIndex: -1,
      standalone: true,
      playbackEngine: IS_VERCEL ? 'youtube' : 'standalone',
      preferredEngineMode: IS_VERCEL ? 'youtube' : 'standalone',
      ytmCompanionOnline: false,
      host: {
        publicUrl: activePublicUrl,
        isTunnelActive: false
      },
      partyHost: this.getPartyHostInfo(),
      djs: Array.from(this.knownDJs),
      djProfiles: Object.fromEntries(this.djProfiles),
      activeMembers: this.getActiveMembers(),
      isRoomSleeping: this.isRoomSleeping,
      volume: { state: this.currentVolume, isMuted: this.isMuted },
      activity: this.activityLogs.slice(0, 30),
      history: this.playedHistory.slice(0, 30)
    })}\n\n`;
  }

  broadcastUpdate(activePublicUrl = null) {
    if (this.clients.size === 0) return;
    try {
      const payload = this.getFullSsePayload(activePublicUrl);
      for (const client of this.clients) {
        try {
          client.write(payload);
        } catch (e) {
          this.clients.delete(client);
        }
      }
    } catch (err) {
      console.error(`[SSE][Room ${this.id}] Broadcast error:`, err.message);
    }
  }

  sendPing() {
    if (this.clients.size === 0) return;
    for (const client of this.clients) {
      try {
        client.write('data: {"type":"ping"}\n\n');
      } catch (e) {
        this.clients.delete(client);
      }
    }
  }

  hydrateFrom(data) {
    if (!data) return;
    if (data.name) this.name = data.name;
    if (data.creator) this.creator = data.creator;
    if (data.createdAt) this.createdAt = data.createdAt;
    if (data.lastActive) this.lastActive = data.lastActive;
    if (typeof data.isRoomSleeping === 'boolean') this.isRoomSleeping = data.isRoomSleeping;

    if (data.currentSong && data.currentSong.videoId) {
      // Conflict Guard: If this instance advanced the track locally within 15 seconds,
      // do not let stale remote data revert the newly advanced song!
      const isLocalRecentAdvance = (Date.now() - (this.lastAdvanceTime || 0) < 15000);
      if (!isLocalRecentAdvance || data.currentSong.videoId === this.currentSong?.videoId) {
        this.currentSong = {
          ...data.currentSong,
          songDuration: (typeof data.currentSong.songDuration === 'number' && data.currentSong.songDuration > 0) ? Math.round(data.currentSong.songDuration) : 215,
          imageSrc: data.currentSong.thumbnail || data.currentSong.imageSrc || '',
          isPaused: typeof data.currentSong.isPaused === 'boolean' ? data.currentSong.isPaused : true,
          startedAt: data.currentSong.startedAt || (data.currentSong.elapsedSeconds ? (Date.now() - Math.round(data.currentSong.elapsedSeconds * 1000)) : Date.now())
        };
        this.playbackTracker.videoId = this.currentSong.videoId;
        this.playbackTracker.songDuration = this.currentSong.songDuration;
        this.playbackTracker.isPaused = this.currentSong.isPaused;
        this.playbackTracker.lastUpdated = Date.now();

        if (this.currentSong.isPaused) {
          this.playbackTracker.elapsed = this.currentSong.elapsedSeconds || 0;
        } else {
          const wallClockElapsed = Math.max(0, (Date.now() - this.currentSong.startedAt) / 1000);
          this.playbackTracker.elapsed = wallClockElapsed;
          this.currentSong.elapsedSeconds = wallClockElapsed;
        }
      }
    }

    if (Array.isArray(data.partyQueue)) {
      const isLocalRecentAdvance = (Date.now() - (this.lastAdvanceTime || 0) < 15000);
      if (!isLocalRecentAdvance) {
        this.partyQueue = data.partyQueue;
      }
    }
    if (Array.isArray(data.playedHistory)) {
      this.playedHistory = data.playedHistory;
    }
    if (Array.isArray(data.activityLogs)) {
      this.activityLogs = data.activityLogs;
      this.cleanDuplicateActivityLogs();
    }
    if (data.partyHost) {
      this.partyHost = data.partyHost;
    }
    if (data.pendingTakeover !== undefined) {
      this.pendingTakeover = data.pendingTakeover;
    }
    if (typeof data.currentVolume === 'number') {
      this.currentVolume = data.currentVolume;
    }
    if (typeof data.isMuted === 'boolean') {
      this.isMuted = data.isMuted;
    }
    if (Array.isArray(data.knownDJs)) {
      for (const dj of data.knownDJs) {
        this.knownDJs.add(dj);
      }
    }
    if (Array.isArray(data.activeDevices)) {
      const now = Date.now();
      for (const dev of data.activeDevices) {
        if (dev && dev.deviceId && (now - (dev.lastHeartbeat || 0) < 60000)) {
          this.activeDevices.set(dev.deviceId, {
            deviceId: dev.deviceId,
            name: dev.name,
            baseName: dev.baseName || dev.name,
            email: dev.email || '',
            lastHeartbeat: dev.lastHeartbeat || now,
            replaced: Boolean(dev.replaced)
          });
        }
      }
    }
    this.lastRemoteSync = Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      creator: this.creator,
      createdAt: this.createdAt,
      lastActive: this.lastActive,
      isRoomSleeping: this.isRoomSleeping,
      currentSong: this.currentSong,
      partyQueue: this.partyQueue,
      playedHistory: this.playedHistory,
      activityLogs: this.activityLogs,
      partyHost: this.partyHost,
      pendingTakeover: this.pendingTakeover,
      currentVolume: this.currentVolume,
      isMuted: this.isMuted,
      knownDJs: Array.from(this.knownDJs),
      activeDevices: Array.from(this.activeDevices.values()).map(v => ({
        deviceId: v.deviceId,
        name: v.name,
        baseName: v.baseName,
        email: v.email,
        lastHeartbeat: v.lastHeartbeat,
        replaced: v.replaced
      }))
    };
  }
}

class RoomManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.roomsDir = path.join(dataDir, 'rooms');
    this.rooms = new Map();
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(this.roomsDir)) {
        fs.mkdirSync(this.roomsDir, { recursive: true });
      }
    } catch (e) {}

    // Load existing rooms from roomsDir
    try {
      const files = fs.readdirSync(this.roomsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(this.roomsDir, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (data && data.id) {
              const code = String(data.id).toUpperCase().slice(0, 6);
              const room = new Room({ ...data, id: code });
              this.rooms.set(code, room);
            }
          } catch (err) {
            console.warn(`[RoomManager] Failed loading room ${file}:`, err.message);
          }
        }
      }
    } catch (e) {}
  }

  generateUniqueRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 unambiguous chars
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    return `RM${Date.now().toString(36).slice(-4).toUpperCase()}`;
  }

  async checkRoomExists(code) {
    if (!code) return false;
    const normalized = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 6);
    if (!normalized) return false;
    if (this.rooms.has(normalized)) return true;

    // Check disk
    try {
      const filePath = path.join(this.roomsDir, `${normalized}.json`);
      if (fs.existsSync(filePath)) return true;
    } catch (e) {}

    // Check Supabase if configured
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/jukebox_rooms?id=eq.${encodeURIComponent(normalized)}&select=id`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (res.ok) {
          const rows = await res.json();
          return Array.isArray(rows) && rows.length > 0;
        }
      } catch (e) {}
    }
    return false;
  }

  async getOrHydrateRoom(id, name, creator = 'Host', forceSync = false) {
    if (!id) return null;
    const normalized = String(id).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 6);
    if (!normalized) return null;
    let room = this.rooms.get(normalized);

    const now = Date.now();
    // Fast path:
    // 1. In long-running Node server (!IS_VERCEL), in-memory room is canonical living state.
    // 2. In serverless (IS_VERCEL): If forceSync is requested (all mutations), NEVER use memory; fetch fresh from Supabase.
    //    If !forceSync, only reuse in-memory if synced within 150ms during the same burst.
    if (!forceSync && room) {
      if (!IS_VERCEL) return room;
      if (now - (room.lastRemoteSync || 0) < 150) {
        return room;
      }
    }

    // Attempt remote hydration from Supabase
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1800);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/jukebox_rooms?id=eq.${encodeURIComponent(normalized)}&select=id,name,creator,data,updated_at`, {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0 && rows[0].data) {
            const row = rows[0];
            if (room) {
              room.hydrateFrom(row.data);
            } else {
              room = new Room({
                ...row.data,
                id: normalized,
                name: row.name || name || `Party ${normalized}`,
                creator: row.creator || creator
              });
              this.rooms.set(normalized, room);
            }
            room.lastRemoteSync = Date.now();
            return room;
          }
        }
      } catch (err) {
        // Fall back to memory / local file on any network or timeout error
      }
    }

    return room || null;
  }

  getRoom(id) {
    if (!id) return null;
    const normalized = String(id).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 6);
    return this.rooms.get(normalized) || null;
  }

  createRoom(id, name, creator = 'Host') {
    let cleanCode = (id || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!cleanCode) {
      cleanCode = this.generateUniqueRoomCode();
    }
    const cleanName = (name || `Party ${cleanCode}`).trim().slice(0, 40);
    const cleanCreator = (creator || 'Host').trim().slice(0, 25);

    const room = new Room({
      id: cleanCode,
      name: cleanName,
      creator: cleanCreator,
      createdAt: Date.now()
    });
    this.rooms.set(cleanCode, room);
    this.persistRoom(room);
    console.log(`[RoomManager] ✨ Room baru dibuat: "${room.name}" (Kode: ${room.id}) oleh ${cleanCreator}`);
    return room;
  }

  getOrCreateRoom(id, name, creator = 'Host') {
    if (!id) return this.createRoom(null, name, creator);
    const cleanCode = String(id).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    let room = this.rooms.get(cleanCode);
    if (!room) {
      room = this.createRoom(cleanCode, name, creator);
    }
    return room;
  }

  async listRooms(onlyKnown = false, knownList = []) {
    const list = [];
    const normalizedKnown = new Set((knownList || []).map(k => String(k).toUpperCase().slice(0, 6)));

    for (const room of this.rooms.values()) {
      if (onlyKnown && !normalizedKnown.has(room.id)) {
        continue;
      }
      list.push({
        id: room.id,
        code: room.id,
        name: room.name,
        creator: room.creator,
        createdAt: room.createdAt,
        lastActive: room.lastActive,
        isIdle: room.isIdle(),
        isRoomSleeping: room.isRoomSleeping,
        listeners: room.clients.size,
        activeDJsCount: room.activeDevices ? room.activeDevices.size : 0,
        queueCount: room.partyQueue.length,
        currentSong: {
          title: room.currentSong.title,
          artist: room.currentSong.artist,
          thumbnail: room.currentSong.thumbnail,
          isPaused: room.playbackTracker.isPaused
        }
      });
    }
    return list;
  }

  persistRoom(room) {
    if (!room) return Promise.resolve();
    room.lastLocalMutation = Date.now();

    // 1. Local disk write
    try {
      if (!fs.existsSync(this.roomsDir)) {
        fs.mkdirSync(this.roomsDir, { recursive: true });
      }
      const filePath = path.join(this.roomsDir, `${room.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(room.toJSON(), null, 2));
    } catch (e) {
      console.warn(`[RoomManager] Failed saving room ${room.id}:`, e.message);
    }

    // 2. Cloud Supabase sync
    if (SUPABASE_URL && SUPABASE_KEY) {
      const payload = JSON.stringify({
        id: room.id,
        name: room.name,
        creator: room.creator,
        data: room.toJSON(),
        updated_at: new Date().toISOString()
      });
      return fetch(`${SUPABASE_URL}/rest/v1/jukebox_rooms`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: payload
      }).then(() => {
        room.lastRemoteSync = Date.now();
      }).catch(err => {
        console.warn(`[Supabase][Room ${room.id}] Persist error:`, err.message);
      });
    }
    return Promise.resolve();
  }

  deleteRoom(id) {
    if (id === 'main') return false;
    const room = this.rooms.get(id);
    if (!room) return false;

    // Disconnect clients
    for (const client of room.clients) {
      try {
        client.write('event: room_closed\ndata: {"closed":true}\n\n');
        client.end();
      } catch (e) {}
    }
    room.clients.clear();

    // Delete file
    try {
      const filePath = path.join(this.roomsDir, `${id}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {}

    this.rooms.delete(id);

    // Delete from Supabase
    if (SUPABASE_URL && SUPABASE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/jukebox_rooms?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }).catch(err => {
        console.warn(`[Supabase][Room ${id}] Delete error:`, err.message);
      });
    }

    console.log(`[RoomManager] 🗑️ Room "${id}" telah dibersihkan / dimatikan.`);
    return true;
  }

  cleanIdleRooms() {
    for (const [id, room] of this.rooms.entries()) {
      if (id === 'main') continue;
      if (room.isIdle()) {
        console.log(`[RoomManager] 💤 Auto-Cleanup: Mematikan idle room "${room.name}" (ID: ${id}) untuk menghemat resource.`);
        this.deleteRoom(id);
      }
    }
  }

  getAllRooms() {
    return Array.from(this.rooms.values());
  }
}

module.exports = {
  Room,
  RoomManager,
  DEFAULT_STARTER_TRACK
};
