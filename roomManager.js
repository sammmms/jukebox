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
const APP_VERSION = '2.13.8';
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

const DEFAULT_PRESET_ROOMS = [
  { id: 'main', name: 'Main Party', creator: 'System' },
  { id: 'karaoke', name: 'Karaoke Room 🎤', creator: 'System' },
  { id: 'chill', name: 'Chill & Lo-Fi Lounge ☕', creator: 'System' },
  { id: 'asian-pop', name: 'Mandarin & Asian Pop 🌸', creator: 'System' }
];

class Room {
  constructor(options = {}) {
    this.id = options.id || 'main';
    this.name = options.name || (this.id === 'main' ? 'Main Party' : `Party ${this.id}`);
    this.creator = options.creator || 'System';
    this.createdAt = options.createdAt || Date.now();
    this.lastActive = options.lastActive || Date.now();
    this.isRoomSleeping = Boolean(options.isRoomSleeping);

    // Current Song
    this.currentSong = options.currentSong && options.currentSong.videoId ? {
      ...options.currentSong,
      songDuration: (typeof options.currentSong.songDuration === 'number' && options.currentSong.songDuration > 0) ? Math.round(options.currentSong.songDuration) : 215,
      imageSrc: options.currentSong.thumbnail || options.currentSong.imageSrc || '',
      isPaused: typeof options.currentSong.isPaused === 'boolean' ? options.currentSong.isPaused : true
    } : { ...DEFAULT_STARTER_TRACK };

    // Queues & History
    this.partyQueue = Array.isArray(options.partyQueue) ? options.partyQueue : [];
    this.playedHistory = Array.isArray(options.playedHistory) ? options.playedHistory : [];
    this.activityLogs = Array.isArray(options.activityLogs) ? options.activityLogs : [];

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
    // Preset rooms are never pruned
    if (DEFAULT_PRESET_ROOMS.some(p => p.id === this.id)) return false;
    // If listeners are connected, not idle
    if (this.clients.size > 0) return false;
    // If last activity was > 30 minutes ago, considered idle
    const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
    return (Date.now() - this.lastActive) > IDLE_TIMEOUT_MS;
  }

  getCalculatedElapsed() {
    if (this.playbackTracker.isPaused) {
      return this.playbackTracker.elapsed || 0;
    }
    const now = Date.now();
    const delta = (now - this.playbackTracker.lastUpdated) / 1000;
    const dur = (this.playbackTracker.songDuration && this.playbackTracker.songDuration > 0)
      ? this.playbackTracker.songDuration
      : 99999;
    return Math.min(dur, (this.playbackTracker.elapsed || 0) + delta);
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
    const HOST_VACANT_TIMEOUT_MS = 45000;
    if (this.partyHost.name) {
      if (Date.now() - (this.partyHost.lastHeartbeat || 0) > HOST_VACANT_TIMEOUT_MS) {
        const oldHost = this.partyHost.name;
        this.partyHost = { name: null, token: null, claimedAt: null, lastHeartbeat: null, clientType: null };
        this.pendingTakeover = null;
        this.addActivity('System', 'host_vacated', `Kursi Host dikosongkan karena ${oldHost} tidak merespons (timeout 45s)`);
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

  addActivity(dj, type, details) {
    this.touch();
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
        name: this.name,
        creator: this.creator,
        listeners: this.clients.size
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
        client.write(': ping\n\n');
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
      this.currentSong = {
        ...data.currentSong,
        songDuration: (typeof data.currentSong.songDuration === 'number' && data.currentSong.songDuration > 0) ? Math.round(data.currentSong.songDuration) : 215,
        imageSrc: data.currentSong.thumbnail || data.currentSong.imageSrc || '',
        isPaused: typeof data.currentSong.isPaused === 'boolean' ? data.currentSong.isPaused : true
      };
      this.playbackTracker.videoId = this.currentSong.videoId;
      this.playbackTracker.songDuration = this.currentSong.songDuration;
      this.playbackTracker.isPaused = this.currentSong.isPaused;
      this.playbackTracker.elapsed = this.currentSong.elapsedSeconds || 0;
    }

    if (Array.isArray(data.partyQueue)) {
      this.partyQueue = data.partyQueue;
    }
    if (Array.isArray(data.playedHistory)) {
      this.playedHistory = data.playedHistory;
    }
    if (Array.isArray(data.activityLogs)) {
      this.activityLogs = data.activityLogs;
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
      knownDJs: Array.from(this.knownDJs)
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
              const room = new Room(data);
              this.rooms.set(room.id, room);
            }
          } catch (err) {
            console.warn(`[RoomManager] Failed loading room ${file}:`, err.message);
          }
        }
      }
    } catch (e) {}

    // Ensure standard preset rooms exist
    for (const preset of DEFAULT_PRESET_ROOMS) {
      if (!this.rooms.has(preset.id)) {
        let legacyData = {};
        if (preset.id === 'main') {
          try {
            const qFile = path.join(this.dataDir, 'party_queue.json');
            if (fs.existsSync(qFile)) {
              const raw = JSON.parse(fs.readFileSync(qFile, 'utf8'));
              legacyData.currentSong = raw.currentSong;
              legacyData.partyQueue = raw.partyQueue;
            }
            const hFile = path.join(this.dataDir, 'party_host.json');
            if (fs.existsSync(hFile)) {
              legacyData.partyHost = JSON.parse(fs.readFileSync(hFile, 'utf8'));
            }
            const histFile = path.join(this.dataDir, 'played_history.json');
            if (fs.existsSync(histFile)) {
              legacyData.playedHistory = JSON.parse(fs.readFileSync(histFile, 'utf8'));
            }
          } catch (e) {}
        }

        const room = new Room({
          id: preset.id,
          name: preset.name,
          creator: preset.creator,
          ...legacyData
        });
        this.rooms.set(preset.id, room);
        this.persistRoom(room);
      }
    }
  }

  async getOrHydrateRoom(id, name, creator = 'Guest', forceSync = false) {
    const normalized = String(id || 'main').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'main';
    let room = this.rooms.get(normalized);

    const now = Date.now();
    // Fast path: if recently synced within 400ms and not forcing sync, reuse memory
    if (!forceSync && room && (now - (room.lastRemoteSync || 0) < 400)) {
      return room;
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
                name: row.name || name,
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

    if (!room) {
      room = this.getOrCreateRoom(normalized, name, creator);
    }
    return room;
  }

  getRoom(id) {
    if (!id) return this.rooms.get('main');
    const normalized = String(id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'main';
    return this.rooms.get(normalized);
  }

  getOrCreateRoom(id, name, creator = 'Guest') {
    const normalized = String(id || 'main').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'main';
    let room = this.rooms.get(normalized);
    if (!room) {
      room = new Room({
        id: normalized,
        name: name || (normalized === 'main' ? 'Main Party' : `Party ${normalized}`),
        creator: creator || 'DJ'
      });
      this.rooms.set(normalized, room);
      this.persistRoom(room);
      console.log(`[RoomManager] ✨ Room baru dibuat: "${room.name}" (ID: ${room.id}) oleh ${creator}`);
    }
    return room;
  }

  async listRooms() {
    // If Supabase is available, fetch recent rooms from remote to merge
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/jukebox_rooms?select=id,name,creator,data,updated_at&order=updated_at.desc&limit=30`, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (row && row.id && !this.rooms.has(row.id)) {
                const room = new Room({
                  ...row.data,
                  id: row.id,
                  name: row.name,
                  creator: row.creator
                });
                room.lastRemoteSync = Date.now();
                this.rooms.set(row.id, room);
              }
            }
          }
        }
      } catch (e) {}
    }

    const list = [];
    for (const room of this.rooms.values()) {
      list.push({
        id: room.id,
        name: room.name,
        creator: room.creator,
        createdAt: room.createdAt,
        lastActive: room.lastActive,
        isIdle: room.isIdle(),
        isRoomSleeping: room.isRoomSleeping,
        listeners: room.clients.size,
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

    // 2. Cloud Supabase sync (Sequential write chain per room)
    if (SUPABASE_URL && SUPABASE_KEY) {
      if (!this.persistChains) this.persistChains = new Map();
      const prev = this.persistChains.get(room.id) || Promise.resolve();
      const next = prev.then(async () => {
        try {
          const payload = JSON.stringify({
            id: room.id,
            name: room.name,
            creator: room.creator,
            data: room.toJSON(),
            updated_at: new Date().toISOString()
          });
          await fetch(`${SUPABASE_URL}/rest/v1/jukebox_rooms`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            },
            body: payload
          });
        } catch (err) {
          console.warn(`[Supabase][Room ${room.id}] Persist error:`, err.message);
        }
      });
      this.persistChains.set(room.id, next);
      return next;
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
