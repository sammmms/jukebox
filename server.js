const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = '2.8.0';

const YTM_API = 'http://localhost:26538';
let isYtmConnected = false;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Persisted Data Storage
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
const PARTY_QUEUE_FILE = path.join(DATA_DIR, 'party_queue.json');
const SOCIAL_QUEUE_FILE = path.join(DATA_DIR, 'social_queue.json');
const PLAYED_HISTORY_FILE = path.join(DATA_DIR, 'played_history.json');

// --- INTERNAL MASTER QUEUE & STATE ---
let partyQueue = [];
const socialQueue = new Map();
const upvotes = new Map();

let currentSong = {
  videoId: '',
  title: 'No song playing',
  artist: '',
  thumbnail: '',
  imageSrc: '',
  songDuration: 0,
  elapsedSeconds: 0,
  isPaused: true,
  addedBy: 'Host',
  startedAt: 0
};

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

const activityLogs = [];
const knownDJs = new Set();
const playedHistory = [];
const lyricsCache = new Map();

// Quick Tunnel Management
let quickTunnelProcess = null;
let dynamicPublicUrl = process.env.PUBLIC_URL || null;

function findCloudflaredBin() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    path.join(__dirname, 'bin', binName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const cmd = isWin ? `where ${binName}` : `which ${binName}`;
    const p = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\n')[0];
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  return 'cloudflared';
}

function startQuickTunnel(port = PORT) {
  return new Promise((resolve) => {
    if (dynamicPublicUrl) return resolve(dynamicPublicUrl);

    const bin = findCloudflaredBin();
    try {
      console.log(`🌐 Memulai Cloudflare Quick Tunnel untuk port ${port}...`);
      quickTunnelProcess = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(dynamicPublicUrl);
        }
      }, 12000);

      const checkData = (data) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          dynamicPublicUrl = match[0];
          console.log(`⚡ Quick Tunnel Berhasil Dibuat! URL Publik: ${dynamicPublicUrl}`);
          broadcastUpdate();
          resolve(dynamicPublicUrl);
        }
      };

      quickTunnelProcess.stdout.on('data', checkData);
      quickTunnelProcess.stderr.on('data', checkData);

      quickTunnelProcess.on('exit', () => {
        dynamicPublicUrl = null;
        quickTunnelProcess = null;
        broadcastUpdate();
      });
    } catch (err) {
      console.warn('Gagal menjalankan Quick Tunnel:', err.message);
      resolve(null);
    }
  });
}

function stopQuickTunnel() {
  if (quickTunnelProcess) {
    try { quickTunnelProcess.kill('SIGTERM'); } catch (e) {}
    quickTunnelProcess = null;
    dynamicPublicUrl = null;
    broadcastUpdate();
  }
}

// Load persisted state
try {
  if (fs.existsSync(SOCIAL_QUEUE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SOCIAL_QUEUE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      socialQueue.set(k, v);
      if (v && v.user) knownDJs.add(v.user);
    }
  }
} catch (e) {}

try {
  if (fs.existsSync(PARTY_QUEUE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PARTY_QUEUE_FILE, 'utf8'));
    if (raw) {
      if (raw.currentSong && raw.currentSong.videoId) {
        currentSong = {
          ...raw.currentSong,
          imageSrc: raw.currentSong.thumbnail || raw.currentSong.imageSrc || '',
          isPaused: true
        };
      }
      if (Array.isArray(raw.partyQueue)) {
        partyQueue = raw.partyQueue;
        partyQueue.forEach(item => {
          if (item && item.addedBy) knownDJs.add(item.addedBy);
        });
      }
    }
  }
} catch (e) {}

if (!currentSong.videoId) {
  currentSong = { ...DEFAULT_STARTER_TRACK };
}

try {
  if (fs.existsSync(PLAYED_HISTORY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PLAYED_HISTORY_FILE, 'utf8'));
    if (Array.isArray(raw)) playedHistory.push(...raw.slice(0, 60));
  }
} catch (e) {}

function persistPartyQueue() {
  try {
    fs.writeFileSync(PARTY_QUEUE_FILE, JSON.stringify({ currentSong, partyQueue }, null, 2));
  } catch (e) {}
}

function persistSocialQueue() {
  try {
    const obj = {};
    for (const [k, v] of socialQueue.entries()) obj[k] = v;
    fs.writeFileSync(SOCIAL_QUEUE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

function persistPlayedHistory() {
  try {
    fs.writeFileSync(PLAYED_HISTORY_FILE, JSON.stringify(playedHistory.slice(0, 60), null, 2));
  } catch (e) {}
}

// Standalone Web Player Mode (Pure Web - No desktop companion needed)
isYtmConnected = false;
let preferredEngineMode = 'standalone';

function isUsingYtmDesktop() {
  return false;
}

// --- AUTO-VACANT & TAKEOVER PARTY HOST MANAGEMENT ---
// Set to 3 minutes (180s) to prevent background browser tab throttling from disconnecting the speaker host
const HOST_VACANT_TIMEOUT_MS = 180 * 1000;
let partyHost = {
  name: null,
  token: null,
  claimedAt: null,
  lastHeartbeat: null
};

let pendingTakeover = null;
let pendingTakeoverTimer = null;

function clearPendingTakeover() {
  if (pendingTakeoverTimer) {
    clearTimeout(pendingTakeoverTimer);
    pendingTakeoverTimer = null;
  }
  pendingTakeover = null;
}

function checkHostVacant() {
  if (partyHost.name) {
    if (Date.now() - partyHost.lastHeartbeat > HOST_VACANT_TIMEOUT_MS) {
      const oldHost = partyHost.name;
      partyHost = { name: null, token: null, claimedAt: null, lastHeartbeat: null };
      clearPendingTakeover();
      addActivity('System', 'vacant', `Host ${oldHost} offline. Status Host sekarang VACANT ⚠️`);
      broadcastUpdate();
      return true;
    }
  }
  return false;
}
setInterval(checkHostVacant, 10000);

function getPartyHostInfo() {
  checkHostVacant();

  let takeoverInfo = null;
  if (pendingTakeover) {
    const remainingMs = pendingTakeover.expiresAt - Date.now();
    if (remainingMs > 0) {
      takeoverInfo = {
        id: pendingTakeover.id,
        requestedBy: pendingTakeover.requestedBy,
        currentHost: pendingTakeover.currentHost,
        expiresAt: pendingTakeover.expiresAt,
        remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000))
      };
    } else {
      clearPendingTakeover();
    }
  }

  return {
    name: partyHost.name,
    isVacant: partyHost.name === null,
    claimedAt: partyHost.claimedAt,
    lastHeartbeat: partyHost.lastHeartbeat,
    timeoutMs: HOST_VACANT_TIMEOUT_MS,
    pendingTakeover: takeoverInfo
  };
}

let currentVolume = 70;
let isMuted = false;

function addPlayedHistory(track) {
  if (!track || !track.title || track.title === 'No song playing') return;
  if (playedHistory.length > 0 && (playedHistory[0].videoId === track.videoId || playedHistory[0].title === track.title)) {
    return;
  }
  playedHistory.unshift({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    videoId: track.videoId || '',
    title: track.title,
    artist: track.artist || '',
    thumbnail: track.thumbnail || track.imageSrc || '',
    addedBy: track.addedBy || 'Autoplay / Host',
    playedAt: Date.now()
  });
  if (playedHistory.length > 60) playedHistory.pop();
  persistPlayedHistory();
}

function resolveAddedBy(videoId, queue = [], title = '') {
  if (!videoId && !title) return 'Autoplay / Host';
  if (videoId && socialQueue.has(videoId)) {
    return socialQueue.get(videoId).user;
  }
  if (title) {
    const cleanT = title.trim().toLowerCase();
    for (const [k, v] of socialQueue.entries()) {
      if (v && v.title && v.title.trim().toLowerCase() === cleanT) return v.user;
    }
  }
  return 'Autoplay / Host';
}

const AUTOPLAY_FALLBACK_TRACKS = [
  { videoId: 'bu7nU9Mhpyo', title: '告白气球 (Love Confession)', artist: '周杰伦 Jay Chou', thumbnail: 'https://i.ytimg.com/vi/bu7nU9Mhpyo/hqdefault.jpg', songDuration: 215 },
  { videoId: '6ZXzn1jwtM4', title: '爱人错过 (Somewhere in time)', artist: '告五人 Accusefive', thumbnail: 'https://i.ytimg.com/vi/6ZXzn1jwtM4/hqdefault.jpg', songDuration: 298 },
  { videoId: 'LWV-f6dMN3Q', title: '修炼爱情 (Practice Love)', artist: '林俊杰 JJ Lin', thumbnail: 'https://i.ytimg.com/vi/LWV-f6dMN3Q/hqdefault.jpg', songDuration: 284 },
  { videoId: 'T4SimnaiktU', title: '光年之外 (Light Years Away)', artist: '邓紫棋 G.E.M.', thumbnail: 'https://i.ytimg.com/vi/T4SimnaiktU/hqdefault.jpg', songDuration: 235 },
  { videoId: 'Y2ge3KrdeWs', title: '怎么了 (What\'s Wrong)', artist: '周兴哲 Eric Chou', thumbnail: 'https://i.ytimg.com/vi/Y2ge3KrdeWs/hqdefault.jpg', songDuration: 321 },
  { videoId: '_MQVmPpMQEc', title: '阿拉斯加海湾 (Gulf of Alaska)', artist: '菲道尔 Firdhaus', thumbnail: 'https://i.ytimg.com/vi/_MQVmPpMQEc/hqdefault.jpg', songDuration: 247 },
  { videoId: 'dvgZkm1xWPE', title: 'Viva La Vida', artist: 'Coldplay', thumbnail: 'https://i.ytimg.com/vi/dvgZkm1xWPE/hqdefault.jpg', songDuration: 242 },
  { videoId: '34Na4j8AVgA', title: 'Starboy', artist: 'The Weeknd ft. Daft Punk', thumbnail: 'https://i.ytimg.com/vi/34Na4j8AVgA/hqdefault.jpg', songDuration: 230 },
  { videoId: 'JGwWNGJdvx8', title: 'Shape of You', artist: 'Ed Sheeran', thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg', songDuration: 233 },
  { videoId: 'ArmDp-zijuc', title: 'Super Shy', artist: 'NewJeans', thumbnail: 'https://i.ytimg.com/vi/ArmDp-zijuc/hqdefault.jpg', songDuration: 154 },
  { videoId: 'x8VYWazR5mE', title: '夜に駆ける (Racing into the Night)', artist: 'YOASOBI', thumbnail: 'https://i.ytimg.com/vi/x8VYWazR5mE/hqdefault.jpg', songDuration: 261 },
  { videoId: 'a5uQMwRMHcs', title: 'Sparkle (スパークル)', artist: 'RADWIMPS', thumbnail: 'https://i.ytimg.com/vi/a5uQMwRMHcs/hqdefault.jpg', songDuration: 410 }
];

async function getAutoplayNextTrack(prevSong) {
  const recentVideoIds = new Set(playedHistory.slice(0, 15).map(h => h.videoId));
  if (prevSong && prevSong.videoId) recentVideoIds.add(prevSong.videoId);

  // 1. Try Innertube search based on previous song's artist or title
  if (prevSong && (prevSong.artist || prevSong.title) && prevSong.title !== 'No song playing') {
    try {
      const searchKeyword = prevSong.artist ? `${prevSong.artist} popular songs` : `${prevSong.title} mix`;
      const searchResults = await searchYouTubeMusic(searchKeyword);
      const candidates = (searchResults || []).filter(r => r.videoId && !recentVideoIds.has(r.videoId));
      if (candidates.length > 0) {
        const picked = candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))];
        return {
          videoId: picked.videoId,
          title: picked.title,
          artist: picked.artist || prevSong.artist || 'YouTube Music',
          thumbnail: picked.thumbnail || '',
          songDuration: 240,
          addedBy: 'Autoplay / YouTube Algorithm'
        };
      }
    } catch (e) {
      console.warn('Autoplay search error:', e.message);
    }
  }

  // 2. Fallback to curated popular party tracks
  const availableFallback = AUTOPLAY_FALLBACK_TRACKS.filter(t => !recentVideoIds.has(t.videoId));
  const pool = availableFallback.length > 0 ? availableFallback : AUTOPLAY_FALLBACK_TRACKS;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return {
    ...picked,
    addedBy: 'Autoplay / Rekomendasi Pesta'
  };
}

async function advanceNextTrack(skippedByUser = null) {
  if (currentSong && currentSong.videoId && currentSong.title !== 'No song playing') {
    addPlayedHistory(currentSong);
  }

  if (partyQueue.length > 0) {
    const nextItem = partyQueue.shift();
    currentSong = {
      videoId: nextItem.videoId,
      title: nextItem.title,
      artist: nextItem.artist || '',
      thumbnail: nextItem.thumbnail || '',
      imageSrc: nextItem.thumbnail || '',
      songDuration: nextItem.songDuration || 0,
      elapsedSeconds: 0,
      isPaused: false,
      addedBy: nextItem.addedBy || 'Host',
      startedAt: Date.now()
    };
  } else {
    // AUTOPLAY: Queue is empty -> fetch YouTube recommendation automatically!
    const autoTrack = await getAutoplayNextTrack(currentSong);
    currentSong = {
      videoId: autoTrack.videoId,
      title: autoTrack.title,
      artist: autoTrack.artist || '',
      thumbnail: autoTrack.thumbnail || '',
      imageSrc: autoTrack.thumbnail || '',
      songDuration: autoTrack.songDuration || 240,
      elapsedSeconds: 0,
      isPaused: false,
      addedBy: autoTrack.addedBy || 'Autoplay / YouTube Algorithm',
      startedAt: Date.now()
    };
    addActivity('System', 'autoplay', `memutar "${autoTrack.title}" (Autoplay)`);
  }

  playbackTracker.videoId = currentSong.videoId;
  playbackTracker.elapsed = 0;
  playbackTracker.lastReportedElapsed = -1;
  playbackTracker.isPaused = currentSong.isPaused;
  playbackTracker.songDuration = currentSong.songDuration;
  playbackTracker.lastUpdated = Date.now();

  persistPartyQueue();
  if (skippedByUser) {
    addActivity(skippedByUser, 'skip', currentSong.title || 'song');
  }
  broadcastUpdate();
  return currentSong;
}

// Volume Controls
function getSystemVolume() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec('osascript -e "output volume of (get volume settings)"', (err, stdout) => {
        if (err) return resolve(currentVolume);
        const v = parseInt(stdout.trim(), 10);
        resolve(isNaN(v) ? currentVolume : v);
      });
    } else {
      resolve(currentVolume);
    }
  });
}

function setSystemVolume(vol) {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec(`osascript -e "set volume output volume ${vol}"`, (err) => resolve(!err));
    } else if (process.platform === 'linux') {
      exec(`amixer -D pulse sset Master ${vol}% 2>/dev/null || pactl set-sink-volume @DEFAULT_SINK@ ${vol}% 2>/dev/null`, () => resolve(true));
    } else {
      resolve(true);
    }
  });
}

// Clean title and lyrics parser
function cleanSongTitle(title, artist = '') {
  if (!title) return '';
  let clean = title;
  clean = clean.replace(/【(?:Official|MV|Music Video|官方|HD|4K|完整版|高畫質|片尾曲|主題曲|原聲帶|翻唱|Cover)[^】]*】/gi, '');
  const guillemetMatch = clean.match(/《([^》]+)》/);
  if (guillemetMatch) {
    clean = guillemetMatch[1];
  } else {
    const bracketMatch = clean.match(/【([^】]+)】/);
    if (bracketMatch) clean = bracketMatch[1];
  }
  clean = clean
    .replace(/\b(?:official\s*(?:video|audio|music\s*video|lyric\s*video|mv)?|music\s*video|lyric\s*video|mv|hd|4k)\b/gi, '')
    .replace(/\((?:official\s*(?:video|audio|music\s*video|lyric\s*video)?|mv|hd|4k|lyrics?)\)/gi, '')
    .replace(/\[(?:official\s*(?:video|audio|music\s*video|lyric\s*video)?|mv|hd|4k|lyrics?)\]/gi, '')
    .replace(/\((?:feat|ft)\.?\s+[^)]+\)/gi, '')
    .replace(/\[(?:feat|ft)\.?\s+[^\]]+\]/gi, '')
    .replace(/\b(?:feat|ft)\.?\s+.+$/gi, '')
    .replace(/[-–—]\s*(?:華劇|電視劇|電影|片尾曲|主題曲|插曲|OST).+$/gi, '')
    .replace(/\|.+$/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.includes(' - ')) {
    const parts = clean.split(' - ');
    if (parts.length === 2) {
      if (artist && parts[0].toLowerCase().includes(artist.toLowerCase().trim())) {
        clean = parts[1].trim();
      } else if (parts[1].length > 0 && parts[0].length > 0) {
        clean = parts[1].trim();
      }
    }
  }
  return clean || title.trim();
}

function parseLrc(lrcString) {
  if (!lrcString) return [];
  let offsetMs = 0;
  const offsetMatch = lrcString.match(/\[offset:\s*([+-]?\d+)\]/i);
  if (offsetMatch) offsetMs = parseInt(offsetMatch[1], 10) || 0;
  const offsetSec = offsetMs / 1000;

  const lines = lrcString.split('\n');
  const result = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/;

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const msStr = (match[3] || '0').padEnd(3, '0').slice(0, 3);
      const ms = parseInt(msStr, 10);
      const time = Math.max(0, min * 60 + sec + ms / 1000 + offsetSec);
      const text = match[4].trim();
      if (text) result.push({ time, text });
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

async function fetchLyrics(title, artist, duration) {
  const cleanTitle = cleanSongTitle(title, artist);
  const cleanArtist = (artist || '').replace(/\s*•.*$/, '').trim();
  const cacheKey = `${cleanTitle.toLowerCase()}---${cleanArtist.toLowerCase()}`;

  if (lyricsCache.has(cacheKey)) return lyricsCache.get(cacheKey);

  const userAgent = 'PartyJukebox/2.7.0 (https://github.com/sammmms/jukebox)';

  async function tryGet(tName, aName, dur) {
    try {
      const p = new URLSearchParams({ track_name: tName });
      if (aName) p.append('artist_name', aName);
      if (dur && dur > 0) p.append('duration', Math.round(dur));
      const res = await fetch(`https://lrclib.net/api/get?${p.toString()}`, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const d = await res.json();
        if (d && (d.syncedLyrics || d.plainLyrics)) return d;
      }
    } catch (e) {}
    return null;
  }

  try {
    let data = await tryGet(cleanTitle, cleanArtist, duration);
    if (!data && duration && duration > 0) data = await tryGet(cleanTitle, cleanArtist, 0);

    if (!data && (cleanTitle.includes(' ') || cleanTitle.includes('-') || cleanTitle.includes('/'))) {
      const segments = cleanTitle.split(/[\s\-\/]+/).filter(p => p.length >= 2);
      for (const seg of segments) {
        data = await tryGet(seg, cleanArtist, duration) || await tryGet(seg, cleanArtist, 0);
        if (data) break;
      }
    }

    if (!data) {
      try {
        const searchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + cleanArtist)}`, {
          headers: { 'User-Agent': userAgent },
          signal: AbortSignal.timeout(3500)
        });
        if (searchRes.ok) {
          const list = await searchRes.json();
          if (Array.isArray(list) && list.length > 0) {
            let best = null;
            if (duration && duration > 0) {
              best = list.find(item => item.syncedLyrics && Math.abs(item.duration - duration) <= 4)
                  || list.find(item => Math.abs(item.duration - duration) <= 4);
            }
            if (!best) {
              best = list.find(item => {
                const itemT = (item.trackName || '').toLowerCase();
                const targetT = cleanTitle.toLowerCase();
                return item.syncedLyrics && (itemT.includes(targetT) || targetT.includes(itemT));
              });
            }
            if (best) data = best;
          }
        }
      } catch (e) {}
    }

    if (!data || (!data.plainLyrics && !data.syncedLyrics)) {
      const emptyResult = { hasLyrics: false, error: 'Lirik belum tersedia untuk lagu ini.' };
      lyricsCache.set(cacheKey, emptyResult);
      return emptyResult;
    }

    const isSynced = Boolean(data.syncedLyrics);
    const parsedLines = isSynced ? parseLrc(data.syncedLyrics) : [];
    const result = {
      hasLyrics: true,
      isSynced,
      trackName: data.trackName || cleanTitle,
      artistName: data.artistName || cleanArtist,
      plain: data.plainLyrics || (isSynced ? parsedLines.map(l => l.text).join('\n') : ''),
      lines: parsedLines
    };

    lyricsCache.set(cacheKey, result);
    return result;
  } catch (err) {
    return { hasLyrics: false, error: 'Gagal mengambil lirik' };
  }
}

function addActivity(user, action, details) {
  if (user && typeof user === 'string' && user !== 'System' && user !== 'Someone' && user !== 'Anonymous' && user !== 'Autoplay / Host') {
    knownDJs.add(user.trim());
  }
  const item = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    user: user || 'Someone',
    action,
    details: details || '',
    timestamp: Date.now()
  };
  activityLogs.unshift(item);
  if (activityLogs.length > 50) activityLogs.pop();
  return item;
}

addActivity('System', 'start', 'Party Jukebox Engine active');

const playbackTracker = {
  videoId: currentSong.videoId || '',
  elapsed: 0,
  lastReportedElapsed: -1,
  isPaused: currentSong.isPaused,
  songDuration: currentSong.songDuration || 0,
  lastUpdated: Date.now()
};

function updatePlaybackTracker(freshSong) {
  if (!freshSong || !freshSong.videoId) return;
  const now = Date.now();
  const duration = freshSong.songDuration || playbackTracker.songDuration || 0;
  playbackTracker.songDuration = duration;

  if (freshSong.videoId !== playbackTracker.videoId) {
    if (playbackTracker.videoId && currentSong.title && currentSong.title !== 'No song playing') {
      addPlayedHistory({ ...currentSong, playedAt: now });
    }
    playbackTracker.videoId = freshSong.videoId;
    playbackTracker.elapsed = freshSong.elapsedSeconds || 0;
    playbackTracker.lastReportedElapsed = freshSong.elapsedSeconds ?? -1;
    playbackTracker.isPaused = freshSong.isPaused ?? false;
    playbackTracker.lastUpdated = now;
    return;
  }

  if (typeof freshSong.isPaused === 'boolean' && freshSong.isPaused !== playbackTracker.isPaused) {
    if (!playbackTracker.isPaused) {
      const delta = (now - playbackTracker.lastUpdated) / 1000;
      playbackTracker.elapsed = Math.min(playbackTracker.elapsed + delta, duration || 9999);
    }
    playbackTracker.isPaused = freshSong.isPaused;
    playbackTracker.lastUpdated = now;
    return;
  }

  if (typeof freshSong.elapsedSeconds === 'number' && freshSong.elapsedSeconds >= 0 && freshSong.elapsedSeconds !== playbackTracker.lastReportedElapsed) {
    const currentCalc = getCalculatedElapsed();
    if (Math.abs(freshSong.elapsedSeconds - currentCalc) > 3) {
      playbackTracker.elapsed = freshSong.elapsedSeconds;
      playbackTracker.lastUpdated = now;
    }
    playbackTracker.lastReportedElapsed = freshSong.elapsedSeconds;
  }
}

function getCalculatedElapsed() {
  if (playbackTracker.isPaused) return Math.floor(playbackTracker.elapsed);
  const delta = (Date.now() - playbackTracker.lastUpdated) / 1000;
  const total = playbackTracker.elapsed + delta;
  const max = playbackTracker.songDuration > 0 ? playbackTracker.songDuration : 9999;
  return Math.floor(Math.min(total, max));
}

function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const watchMatch = input.match(/(?:music\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];
  const shortMatch = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  const embedMatch = input.match(/youtube\.com\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];
  return null;
}

async function validateYouTubeMusicTrack(videoId) {
  if (!videoId || typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId.trim())) {
    return { valid: false, error: 'Format Video ID YouTube tidak valid (harus 11 karakter).' };
  }
  const cleanId = videoId.trim();
  let oembedData = null;
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${cleanId}&format=json`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(3500)
    });
    if (oembedRes.status === 404) {
      return { valid: false, error: 'Lagu/video tidak ditemukan di YouTube (404 Not Found), telah dihapus, atau disetel privat.' };
    }
    if (oembedRes.ok) oembedData = await oembedRes.json();
  } catch (err) {}

  return {
    valid: true,
    title: oembedData?.title || 'Unknown Title',
    artist: oembedData?.author_name || 'YouTube',
    thumbnail: oembedData?.thumbnail_url || `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg`
  };
}

// Direct YouTube Music Search via Innertube WEB_REMIX API
async function searchYouTubeMusic(query) {
  try {
    const res = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20231204.01.00',
            hl: 'id',
            gl: 'ID'
          }
        },
        query: query
      }),
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) return [];
    const data = await res.json();
    const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs;
    const sectionList = tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

    const results = [];
    const seenIds = new Set();

    function addItem(item) {
      if (!item) return;
      const flex = item.flexColumns || [];
      const title = flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
      const subtitleRuns = flex[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const artist = subtitleRuns.map(r => r.text).join('');

      const videoId = item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
        || flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;

      const thumbnails = item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const thumbnail = thumbnails[thumbnails.length - 1]?.url || '';

      if (videoId && title && !seenIds.has(videoId)) {
        seenIds.add(videoId);
        results.push({ videoId, title, artist, thumbnail });
      }
    }

    for (const section of sectionList) {
      if (section.musicCardShelfRenderer) {
        const card = section.musicCardShelfRenderer;
        const title = card.title?.runs?.[0]?.text;
        const artist = card.subtitle?.runs?.map(r => r.text).join('');
        const videoId = card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId
          || card.buttons?.[0]?.buttonRenderer?.command?.watchEndpoint?.videoId;
        const thumbnails = card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        const thumbnail = thumbnails[thumbnails.length - 1]?.url || '';
        if (videoId && title && !seenIds.has(videoId)) {
          seenIds.add(videoId);
          results.push({ videoId, title, artist, thumbnail });
        }
      }
      if (section.itemSectionRenderer?.contents) {
        for (const c of section.itemSectionRenderer.contents) {
          if (c.musicResponsiveListItemRenderer) addItem(c.musicResponsiveListItemRenderer);
        }
      }
      if (section.musicShelfRenderer?.contents) {
        for (const c of section.musicShelfRenderer.contents) {
          if (c.musicResponsiveListItemRenderer) addItem(c.musicResponsiveListItemRenderer);
        }
      }
    }

    return results.slice(0, 20);
  } catch (err) {
    return [];
  }
}

// Unified Current Song Fetcher (Bridges with YouTube Music Desktop if active)
async function getUnifiedCurrentSong() {
  if (isUsingYtmDesktop()) {
    try {
      const res = await fetch(`${YTM_API}/api/v1/song`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const s = await res.json();
        const mapped = {
          title: s.title || 'Unknown Title',
          artist: s.artist || 'Unknown Artist',
          album: s.album || '',
          imageSrc: s.imageSrc || '',
          thumbnail: s.imageSrc || '',
          isPaused: s.isPaused ?? true,
          songDuration: s.songDuration || 0,
          elapsedSeconds: s.elapsedSeconds || 0,
          videoId: s.videoId || '',
          addedBy: resolveAddedBy(s.videoId, [], s.title)
        };
        updatePlaybackTracker(mapped);
        currentSong = mapped;
        return mapped;
      }
    } catch (e) {
      isYtmConnected = false;
    }
  }

  return {
    ...currentSong,
    currentElapsed: getCalculatedElapsed(),
    isPaused: playbackTracker.isPaused
  };
}

// Unified Queue Fetcher (Reads YTM Desktop Queue if active, else internal partyQueue)
async function getUnifiedQueue() {
  if (isUsingYtmDesktop()) {
    try {
      const res = await fetch(`${YTM_API}/api/v1/queue`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        const items = data.items || [];
        const queue = [];
        let selectedIndex = -1;

        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const r = item.playlistPanelVideoRenderer ||
                    item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
          if (!r) continue;

          const isSelected = r.selected === true;
          if (isSelected) selectedIndex = index;

          const videoId = r.videoId;
          const title = r.title?.runs?.[0]?.text || 'Untitled';
          const artist = r.longBylineText?.runs?.map(x => x.text).join('') ||
                         r.shortBylineText?.runs?.map(x => x.text).join('') || '';
          const thumbnails = r.thumbnail?.thumbnails || [];
          const thumbnail = thumbnails[thumbnails.length - 1]?.url || '';

          const social = socialQueue.get(videoId);
          const voters = upvotes.get(videoId);
          const voteCount = voters ? voters.size : 0;
          const votedUsers = voters ? Array.from(voters) : [];

          queue.push({
            rawIndex: index,
            videoId,
            title,
            artist,
            thumbnail,
            selected: isSelected,
            addedBy: social?.user || null,
            addedAt: social?.addedAt || null,
            upvotes: voteCount,
            votedUsers
          });
        }
        return { queue, selectedIndex };
      }
    } catch (e) {
      isYtmConnected = false;
    }
  }

  const formattedQueue = partyQueue.map((item, idx) => ({
    rawIndex: idx,
    videoId: item.videoId,
    title: item.title,
    artist: item.artist,
    thumbnail: item.thumbnail,
    selected: false,
    addedBy: item.addedBy,
    addedAt: item.addedAt,
    upvotes: item.upvotes || 0,
    votedUsers: item.votedUsers || []
  }));

  return { queue: formattedQueue, selectedIndex: -1 };
}

// --- API ROUTES ---

// 0. Version Endpoint
app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    name: 'Party Jukebox',
    playbackEngine: isUsingYtmDesktop() ? 'ytm_desktop' : 'standalone',
    preferredEngineMode,
    ytmCompanionOnline: isYtmConnected
  });
});

// 0.0 Engine Switch Endpoint (Host can toggle between Auto, YouTube Music App, and Standalone Web)
app.post('/api/host/engine', (req, res) => {
  const { mode } = req.body || {};
  if (!['auto', 'ytm_desktop', 'standalone'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be "auto", "ytm_desktop", or "standalone"' });
  }
  preferredEngineMode = mode;
  broadcastUpdate();
  res.json({
    success: true,
    preferredEngineMode,
    activeEngine: isUsingYtmDesktop() ? 'ytm_desktop' : 'standalone',
    ytmCompanionOnline: isYtmConnected
  });
});

// 0.1 Host Management Endpoints
app.get('/api/host', (req, res) => {
  res.json({ partyHost: getPartyHostInfo() });
});

app.post('/api/host/claim', (req, res) => {
  checkHostVacant();
  const { name, token, force } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Valid host name is required' });
  }
  const cleanName = name.trim().slice(0, 25);
  const hostToken = token || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  // If host is vacant, token matches existing host, or force takeover is allowed
  if (partyHost.name === null || partyHost.token === token || (partyHost.name.toLowerCase() === cleanName.toLowerCase() && !pendingTakeover) || force) {
    const prevHost = partyHost.name;
    clearPendingTakeover();
    partyHost = {
      name: cleanName,
      token: hostToken,
      claimedAt: Date.now(),
      lastHeartbeat: Date.now()
    };
    knownDJs.add(cleanName);
    addActivity(cleanName, 'host_claimed', prevHost && prevHost !== cleanName ? `mengambil alih kursi Host dari ${prevHost}` : 'menjadi Host Party malam ini 👑');
    broadcastUpdate();
    return res.json({ success: true, partyHost: getPartyHostInfo(), token: hostToken });
  }

  // If host is occupied by someone else: Trigger takeover approval request with 30s auto-approval!
  clearPendingTakeover();

  const takeoverId = 'tk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const expiresAt = Date.now() + 30000; // 30 seconds

  pendingTakeover = {
    id: takeoverId,
    requestedBy: cleanName,
    requestedToken: hostToken,
    currentHost: partyHost.name,
    expiresAt: expiresAt
  };

  // Start 30s auto-approval timer
  pendingTakeoverTimer = setTimeout(() => {
    if (pendingTakeover && pendingTakeover.id === takeoverId) {
      const newHost = pendingTakeover.requestedBy;
      const newToken = pendingTakeover.requestedToken;
      const oldHost = partyHost.name;

      partyHost = {
        name: newHost,
        token: newToken,
        claimedAt: Date.now(),
        lastHeartbeat: Date.now()
      };
      knownDJs.add(newHost);
      addActivity(newHost, 'host_claimed', `mengambil alih kursi Host dari ${oldHost} (Auto-Approve 30 detik) 👑`);
      clearPendingTakeover();
      broadcastUpdate();
    }
  }, 30000);

  addActivity(cleanName, 'takeover_request', `meminta izin mengambil alih kursi Host dari ${partyHost.name}`);
  broadcastUpdate();

  return res.json({
    success: true,
    pendingApproval: true,
    message: `Permintaan pengalihan Host dikirim ke ${partyHost.name}. Menunggu persetujuan (otomatis disetujui dalam 30 detik)...`,
    partyHost: getPartyHostInfo(),
    token: hostToken
  });
});

app.post('/api/host/takeover/respond', (req, res) => {
  const { approve, token } = req.body || {};
  if (!pendingTakeover) {
    return res.status(400).json({ error: 'Tidak ada permintaan ambil alih yang aktif saat ini' });
  }

  // Verify that the responder is the current host
  if (partyHost.token && token && partyHost.token !== token) {
    return res.status(403).json({ error: 'Hanya Host saat ini yang dapat menyetujui atau menolak pengalihan' });
  }

  const reqUser = pendingTakeover.requestedBy;
  const reqToken = pendingTakeover.requestedToken;
  const curHost = partyHost.name;

  if (approve) {
    clearPendingTakeover();
    partyHost = {
      name: reqUser,
      token: reqToken,
      claimedAt: Date.now(),
      lastHeartbeat: Date.now()
    };
    knownDJs.add(reqUser);
    addActivity(curHost, 'takeover_approved', `menyetujui pemindahan kursi Host ke ${reqUser} 👑`);
    broadcastUpdate();
    return res.json({ success: true, approved: true, partyHost: getPartyHostInfo() });
  } else {
    clearPendingTakeover();
    addActivity(curHost, 'takeover_rejected', `menolak permintaan ambil alih Host dari ${reqUser}`);
    broadcastUpdate();
    return res.json({ success: true, approved: false, partyHost: getPartyHostInfo() });
  }
});

app.post('/api/host/heartbeat', (req, res) => {
  const { token } = req.body || {};
  if (partyHost.name && partyHost.token && partyHost.token === token) {
    partyHost.lastHeartbeat = Date.now();
    return res.json({ success: true, partyHost: getPartyHostInfo() });
  }
  checkHostVacant();
  res.json({ success: false, partyHost: getPartyHostInfo() });
});

app.post('/api/host/release', (req, res) => {
  const { token } = req.body || {};
  if (partyHost.name && (!token || partyHost.token === token)) {
    const oldHost = partyHost.name;
    partyHost = { name: null, token: null, claimedAt: null, lastHeartbeat: null };
    addActivity(oldHost, 'host_released', 'melepas kursi Host. Status sekarang VACANT ⚠️');
    broadcastUpdate();
    return res.json({ success: true, partyHost: getPartyHostInfo() });
  }
  res.json({ success: true, partyHost: getPartyHostInfo() });
});

// Dynamic Public Tunnel Toggles
app.post('/api/host/tunnel/start', async (req, res) => {
  const url = await startQuickTunnel(PORT);
  res.json({ success: Boolean(url), publicUrl: url });
});

app.post('/api/host/tunnel/stop', (req, res) => {
  stopQuickTunnel();
  res.json({ success: true, publicUrl: null });
});

// 0.2 Register / Join as Dynamic DJ / Guest
app.post('/api/dj/join', (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Valid DJ name is required' });
  }
  const cleanName = name.trim().slice(0, 20);
  const isNew = !knownDJs.has(cleanName);
  knownDJs.add(cleanName);
  if (isNew) {
    addActivity(cleanName, 'join', 'bergabung ke pesta');
    broadcastUpdate();
  }
  res.json({ success: true, name: cleanName, djs: Array.from(knownDJs), partyHost: getPartyHostInfo() });
});

// 1. Status
app.get('/api/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const [liveCurrent, { queue, selectedIndex }, sysVol] = await Promise.all([
    getUnifiedCurrentSong(),
    getUnifiedQueue(),
    getSystemVolume()
  ]);

  currentVolume = sysVol;
  const currentIp = getLocalIp();

  // Determine active public address
  const activePublicUrl = dynamicPublicUrl || (process.env.PUBLIC_URL || (process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'https://dj.wsnsam.my.id' : null));

  res.json({
    online: true,
    standalone: !isUsingYtmDesktop(),
    playbackEngine: isUsingYtmDesktop() ? 'ytm_desktop' : 'standalone',
    preferredEngineMode,
    ytmCompanionOnline: isYtmConnected,
    version: APP_VERSION,
    host: {
      ip: currentIp,
      url: `http://${currentIp}:${PORT}`,
      publicUrl: activePublicUrl,
      isTunnelActive: Boolean(dynamicPublicUrl || process.env.CLOUDFLARE_TUNNEL_TOKEN)
    },
    current: {
      ...liveCurrent,
      currentElapsed: getCalculatedElapsed(),
      isPaused: playbackTracker.isPaused
    },
    queue,
    selectedIndex,
    partyHost: getPartyHostInfo(),
    djs: Array.from(knownDJs),
    volume: { state: currentVolume, isMuted },
    activity: activityLogs.slice(0, 30),
    history: playedHistory.slice(0, 30)
  });
});

// 2. Direct Search
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query is required' });
  }
  const results = await searchYouTubeMusic(query.trim());
  res.json({ results });
});

// 3. Add to Queue / Transfer Song to YouTube Music
app.post('/api/queue', async (req, res) => {
  const { input, user, title, artist, thumbnail } = req.body;
  const videoId = extractVideoId(input);

  if (!videoId) {
    return res.status(400).json({ error: 'Format link atau ID YouTube tidak valid.' });
  }

  const validation = await validateYouTubeMusicTrack(videoId);
  if (!validation.valid) {
    return res.status(422).json({ error: validation.error });
  }

  const songTitle = title || validation.title || 'Song';
  const songArtist = artist || validation.artist || '';
  const songThumb = thumbnail || validation.thumbnail || '';
  const songUser = user || 'Anonymous';

  // 1. If YouTube Music Desktop mode is active: Transfer song directly into YouTube Music app!
  if (isUsingYtmDesktop()) {
    try {
      const qRes = await fetch(`${YTM_API}/api/v1/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, insertPosition: 'INSERT_AT_END' })
      });

      if (qRes.ok || qRes.status === 204) {
        socialQueue.set(videoId, {
          user: songUser,
          addedAt: Date.now(),
          title: songTitle,
          artist: songArtist,
          thumbnail: songThumb
        });
        persistSocialQueue();
        addActivity(songUser, 'add', `transfer "${songTitle}" ke YouTube Music`);
        broadcastUpdate();
        return res.json({
          success: true,
          videoId,
          title: songTitle,
          user: songUser,
          transferredToYTM: true
        });
      }
    } catch (e) {
      console.warn('YTM queue transfer failed, falling back to standalone queue:', e.message);
    }
  }

  // 2. Standalone Queue:
  if (!currentSong.videoId || currentSong.title === 'No song playing') {
    currentSong = {
      videoId,
      title: songTitle,
      artist: songArtist,
      thumbnail: songThumb,
      imageSrc: songThumb,
      songDuration: 0,
      elapsedSeconds: 0,
      isPaused: false,
      addedBy: songUser,
      startedAt: Date.now()
    };
    playbackTracker.videoId = videoId;
    playbackTracker.elapsed = 0;
    playbackTracker.lastReportedElapsed = -1;
    playbackTracker.isPaused = false;
    playbackTracker.lastUpdated = Date.now();

    addActivity(songUser, 'add', `memutar "${songTitle}"`);
    persistPartyQueue();
    broadcastUpdate();

    return res.json({
      success: true,
      videoId,
      title: songTitle,
      user: songUser,
      isPlayingNow: true
    });
  }

  const queueItem = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    videoId,
    title: songTitle,
    artist: songArtist,
    thumbnail: songThumb,
    songDuration: 0,
    addedBy: songUser,
    addedAt: Date.now(),
    upvotes: 0,
    votedUsers: []
  };

  partyQueue.push(queueItem);
  addActivity(songUser, 'add', songTitle);
  persistPartyQueue();
  broadcastUpdate();

  res.json({
    success: true,
    videoId,
    title: songTitle,
    user: songUser,
    isPlayingNow: false
  });
});

// 4. Remove from Queue
app.delete('/api/queue/:index', async (req, res) => {
  const index = Number(req.params.index);
  const { user, title } = req.body || {};

  if (isNaN(index)) return res.status(400).json({ error: 'Invalid queue index' });

  if (isUsingYtmDesktop()) {
    try {
      await fetch(`${YTM_API}/api/v1/queue/${index}`, { method: 'DELETE' });
      addActivity(user, 'remove', title || 'a song');
      setTimeout(broadcastUpdate, 250);
      return res.json({ success: true, removedIndex: index });
    } catch (e) {}
  }

  if (index >= 0 && index < partyQueue.length) {
    const removed = partyQueue.splice(index, 1)[0];
    persistPartyQueue();
    addActivity(user, 'remove', title || removed?.title || 'a song');
    broadcastUpdate();
    return res.json({ success: true, removedIndex: index });
  }

  res.status(400).json({ error: 'Index out of bounds' });
});

// 5. Move Queue Item
app.patch('/api/queue/move', async (req, res) => {
  const { fromIndex, toIndex, user, title, targetPosition } = req.body;

  if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
    return res.status(400).json({ error: 'fromIndex and toIndex are required' });
  }

  if (isUsingYtmDesktop()) {
    try {
      await fetch(`${YTM_API}/api/v1/queue/${fromIndex}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toIndex })
      });
      addActivity(user, 'move', `dragged "${title || 'song'}" to #${targetPosition || (toIndex + 1)}`);
      setTimeout(broadcastUpdate, 250);
      return res.json({ success: true });
    } catch (e) {}
  }

  if (fromIndex >= 0 && fromIndex < partyQueue.length && toIndex >= 0 && toIndex < partyQueue.length) {
    const [movedItem] = partyQueue.splice(fromIndex, 1);
    partyQueue.splice(toIndex, 0, movedItem);
    persistPartyQueue();
    addActivity(user, 'move', `dragged "${title || movedItem.title || 'song'}" to #${targetPosition || (toIndex + 1)}`);
    broadcastUpdate();
    return res.json({ success: true });
  }

  res.status(400).json({ error: 'Index out of bounds' });
});

// 6. Upvote a Song
app.post('/api/upvote', async (req, res) => {
  const { videoId, user, title } = req.body;
  if (!videoId || !user) return res.status(400).json({ error: 'videoId and user are required' });

  if (isUsingYtmDesktop()) {
    if (!upvotes.has(videoId)) upvotes.set(videoId, new Set());
    const votes = upvotes.get(videoId);
    let hasVoted = false;
    if (votes.has(user)) {
      votes.delete(user);
      hasVoted = false;
      addActivity(user, 'unvote', title || 'a song');
    } else {
      votes.add(user);
      hasVoted = true;
      addActivity(user, 'upvote', title || 'a song');
    }
    broadcastUpdate();
    return res.json({ success: true, votes: votes.size, hasVoted });
  }

  const item = partyQueue.find(q => q.videoId === videoId);
  if (!item) return res.status(404).json({ error: 'Song not found in queue' });

  if (!Array.isArray(item.votedUsers)) item.votedUsers = [];
  const idx = item.votedUsers.indexOf(user);
  let hasVoted = false;
  if (idx !== -1) {
    item.votedUsers.splice(idx, 1);
    hasVoted = false;
    addActivity(user, 'unvote', title || item.title || 'a song');
  } else {
    item.votedUsers.push(user);
    hasVoted = true;
    addActivity(user, 'upvote', title || item.title || 'a song');
  }

  item.upvotes = item.votedUsers.length;
  partyQueue.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
  persistPartyQueue();
  broadcastUpdate();
  res.json({ success: true, votes: item.upvotes, hasVoted });
});

// 7. Playback Controls
app.post('/api/control/toggle', async (req, res) => {
  const { user } = req.body;

  if (isUsingYtmDesktop()) {
    try {
      await fetch(`${YTM_API}/api/v1/toggle-play`, { method: 'POST' });
      playbackTracker.isPaused = !playbackTracker.isPaused;
      playbackTracker.lastUpdated = Date.now();
      addActivity(user, playbackTracker.isPaused ? 'pause' : 'play', currentSong.title);
      setTimeout(broadcastUpdate, 200);
      return res.json({ success: true, isPaused: playbackTracker.isPaused });
    } catch (e) {}
  }

  if (!currentSong.videoId) return res.json({ success: false, error: 'No song loaded' });
  currentSong.isPaused = !currentSong.isPaused;
  playbackTracker.isPaused = currentSong.isPaused;
  playbackTracker.lastUpdated = Date.now();
  addActivity(user, currentSong.isPaused ? 'pause' : 'play', currentSong.title);
  persistPartyQueue();
  broadcastUpdate();
  res.json({ success: true, isPaused: currentSong.isPaused });
});

app.post('/api/control/next', async (req, res) => {
  const { user } = req.body;

  if (isUsingYtmDesktop()) {
    try {
      await fetch(`${YTM_API}/api/v1/next`, { method: 'POST' });
      addActivity(user, 'skip', currentSong.title || 'song');
      playbackTracker.elapsed = 0;
      playbackTracker.lastReportedElapsed = -1;
      playbackTracker.lastUpdated = Date.now();
      setTimeout(broadcastUpdate, 350);
      return res.json({ success: true, engine: 'ytm_desktop' });
    } catch (e) {}
  }

  const skipped = await advanceNextTrack(user);
  res.json({ success: true, current: skipped });
});

app.post('/api/control/ended', async (req, res) => {
  const { videoId, user } = req.body || {};
  if (!videoId || videoId === currentSong.videoId) {
    const next = await advanceNextTrack(user || 'Host Audio Engine');
    return res.json({ success: true, current: next });
  }
  res.json({ success: false, reason: 'Track mismatch' });
});

app.post('/api/control/volume', async (req, res) => {
  const { volume, user } = req.body;
  if (typeof volume !== 'number') return res.status(400).json({ error: 'volume number is required' });

  const vol = Math.max(0, Math.min(100, Math.round(volume)));
  currentVolume = vol;

  await setSystemVolume(vol);

  if (isUsingYtmDesktop()) {
    fetch(`${YTM_API}/api/v1/volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: vol })
    }).catch(() => {});
  }

  addActivity(user, 'volume', `set volume to ${vol}%`);
  broadcastUpdate();
  res.json({ success: true, volume: vol });
});

app.post('/api/player/sync', (req, res) => {
  const { videoId, elapsed, duration, isPaused } = req.body || {};
  if (videoId && currentSong.videoId === videoId) {
    if (typeof elapsed === 'number' && elapsed >= 0) {
      playbackTracker.elapsed = elapsed;
      currentSong.elapsedSeconds = elapsed;
      playbackTracker.lastUpdated = Date.now();
    }
    if (typeof duration === 'number' && duration > 0) {
      currentSong.songDuration = duration;
      playbackTracker.songDuration = duration;
    }
    if (typeof isPaused === 'boolean') {
      currentSong.isPaused = isPaused;
      playbackTracker.isPaused = isPaused;
    }
  }
  res.json({ success: true });
});

// 8. Lyrics Endpoint
app.get('/api/lyrics', async (req, res) => {
  const title = req.query.title || currentSong.title;
  const artist = req.query.artist || currentSong.artist;
  const duration = Number(req.query.duration) || currentSong.songDuration;

  if (!title || title === 'No song playing') {
    return res.json({ hasLyrics: false, error: 'Tidak ada lagu yang sedang diputar' });
  }

  const lyrics = await fetchLyrics(title, artist, duration);
  res.json(lyrics);
});

// 9. Played History
app.get('/api/history', (req, res) => {
  res.json({ history: playedHistory });
});

// 10. Server-Sent Events
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

async function broadcastUpdate() {
  if (clients.size === 0) return;

  const [liveCurrent, { queue, selectedIndex }] = await Promise.all([
    getUnifiedCurrentSong(),
    getUnifiedQueue()
  ]);

  const activePublicUrl = dynamicPublicUrl || (process.env.PUBLIC_URL || (process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'https://dj.wsnsam.my.id' : null));

  const payload = `data: ${JSON.stringify({
    current: {
      ...liveCurrent,
      currentElapsed: getCalculatedElapsed(),
      isPaused: playbackTracker.isPaused
    },
    queue,
    selectedIndex,
    standalone: !isUsingYtmDesktop(),
    playbackEngine: isUsingYtmDesktop() ? 'ytm_desktop' : 'standalone',
    preferredEngineMode,
    ytmCompanionOnline: isYtmConnected,
    host: {
      ip: localIp,
      url: `http://${localIp}:${PORT}`,
      publicUrl: activePublicUrl,
      isTunnelActive: Boolean(dynamicPublicUrl || process.env.CLOUDFLARE_TUNNEL_TOKEN)
    },
    partyHost: getPartyHostInfo(),
    djs: Array.from(knownDJs),
    volume: { state: currentVolume, isMuted },
    activity: activityLogs.slice(0, 30),
    history: playedHistory.slice(0, 30)
  })}\n\n`;

  for (const client of clients) {
    try {
      client.write(payload);
    } catch (e) {
      clients.delete(client);
    }
  }
}

// Background periodic cleanup / sync
setInterval(() => {
  checkHostVacant();
}, 5000);

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'wlan0', 'eth0']) {
    if (interfaces[name]) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();

getSystemVolume().then(v => {
  currentVolume = v;
});

app.listen(PORT, '0.0.0.0', () => {
  const localUrl = `http://${localIp}:${PORT}`;
  console.log('\n======================================================');
  console.log('🎵  PARTY JUKEBOX STANDALONE (DUAL ENGINE & MULTI-ROOM)!');
  console.log('======================================================');
  console.log(`📡 Local Network / Hotspot: ${localUrl}`);
  console.log(`💻 Host URL:                http://localhost:${PORT}`);
  if (dynamicPublicUrl) {
    console.log(`🌐 Public Tunnel URL:      ${dynamicPublicUrl}`);
  }
  console.log('======================================================');
  console.log('📲 SCAN WITH PHONE TO OPEN:');
  qrcode.generate(dynamicPublicUrl || localUrl, { small: true });
  console.log('======================================================\n');
});
