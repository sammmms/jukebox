const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec, spawn, execFile } = require('child_process');
const https = require('https');
const qrcode = require('qrcode-terminal');

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

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = '2.14.7';

let pinyinLib = null;
try { pinyinLib = require('pinyin-pro'); } catch (e) {}
let wanakanaLib = null;
try { wanakanaLib = require('wanakana'); } catch (e) {}
let hangulRomanizer = null;
try { hangulRomanizer = require('hangul-romanization'); } catch (e) {}

let kuroshiro = null;
let isKuroshiroReady = false;
try {
  const Kuroshiro = require('kuroshiro');
  const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
  kuroshiro = new Kuroshiro();
  kuroshiro.init(new KuromojiAnalyzer()).then(() => {
    isKuroshiroReady = true;
    console.log('🗾 Kuroshiro Japanese Romanizer initialized successfully');
  }).catch(err => {
    console.warn('Kuroshiro initialization warning:', err.message);
  });
} catch (e) {
  console.warn('Kuroshiro module loading warning:', e.message);
}

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

// Persisted Data Storage (/tmp for Vercel Serverless environment, local dir otherwise)
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = IS_VERCEL ? path.join('/tmp', 'data') : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
const PARTY_QUEUE_FILE = path.join(DATA_DIR, 'party_queue.json');
const SOCIAL_QUEUE_FILE = path.join(DATA_DIR, 'social_queue.json');
const PLAYED_HISTORY_FILE = path.join(DATA_DIR, 'played_history.json');
const PARTY_HOST_FILE = path.join(DATA_DIR, 'party_host.json');
const DJ_PROFILES_FILE = path.join(DATA_DIR, 'dj_profiles.json');

const { RoomManager } = require('./roomManager');
const roomManager = new RoomManager(DATA_DIR);

// Middleware: Automatic Room Resolution for all /api endpoints
app.use('/api', async (req, res, next) => {
  try {
    if (req.path.startsWith('/rooms') || req.path.startsWith('/auth') || req.path === '/version' || req.path.startsWith('/audio/stream')) {
      return next();
    }
    const rawId = req.headers['x-room-id'] || req.query.room || req.body?.room;
    if (!rawId) {
      return res.status(400).json({ error: 'ROOM_REQUIRED', message: 'Wajib memilih atau membuat party room terlebih dahulu.' });
    }
    const roomId = String(rawId).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 6);
    req.roomId = roomId;
    const isMutation = req.method !== 'GET' && req.method !== 'HEAD';
    const forceSync = isMutation || Boolean(req.query._t || req.headers['cache-control']?.includes('no-cache'));
    const room = await roomManager.getOrHydrateRoom(roomId, null, null, forceSync);
    if (!room) {
      return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: `Party room "${roomId}" tidak ditemukan atau belum dibuat.` });
    }
    req.room = room;
    req.room.touch();
    next();
  } catch (err) {
    console.error('[API Room Middleware Error]', err);
    next();
  }
});



// Google OAuth Configuration (Loaded securely from env or local external config)
let GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
let GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

const EXTERNAL_OAUTH_FILE = '/Users/sam/Documents/Others/CLIENT SECRET OAUTH.json';
const LOCAL_OAUTH_FILE = path.join(__dirname, 'oauth-credentials.json');

try {
  const targetFile = fs.existsSync(LOCAL_OAUTH_FILE) ? LOCAL_OAUTH_FILE : (fs.existsSync(EXTERNAL_OAUTH_FILE) ? EXTERNAL_OAUTH_FILE : null);
  if (targetFile) {
    const raw = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    const cfg = raw.web || raw.installed || raw;
    if (!GOOGLE_CLIENT_ID && cfg.client_id) GOOGLE_CLIENT_ID = cfg.client_id;
    if (!GOOGLE_CLIENT_SECRET && cfg.client_secret) GOOGLE_CLIENT_SECRET = cfg.client_secret;
  }
} catch (e) {}

// --- INTERNAL MASTER QUEUE & STATE ---
let partyQueue = [];
const socialQueue = new Map();
const upvotes = new Map();
const djProfiles = new Map();

// Idle Resource Saver Mode (Standby after 15m inactivity)
let lastActiveActivityTimestamp = Date.now();
let isRoomSleeping = false;

function updateActivityTimestamp() {
  lastActiveActivityTimestamp = Date.now();
  if (isRoomSleeping) {
    isRoomSleeping = false;
    console.log('[Idle Saver] ⚡ Aktivitas terdeteksi. Room kembali aktif!');
    broadcastUpdate();
  }
}

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
} else if (!currentSong.songDuration || currentSong.songDuration <= 0) {
  const fallback = AUTOPLAY_FALLBACK_TRACKS.find(t => t.videoId === currentSong.videoId);
  if (fallback && fallback.songDuration) {
    currentSong.songDuration = fallback.songDuration;
  }
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
let preferredEngineMode = IS_VERCEL ? 'youtube' : 'standalone';

function isUsingYtmDesktop() {
  return false;
}

// --- AUTO-VACANT & TAKEOVER PARTY HOST MANAGEMENT ---
// Set to 1 hour (3600s) to prevent background browser tab throttling from disconnecting the speaker host
const HOST_VACANT_TIMEOUT_MS = 60 * 60 * 1000;
let partyHost = {
  name: null,
  token: null,
  claimedAt: null,
  lastHeartbeat: null
};

try {
  if (fs.existsSync(PARTY_HOST_FILE)) {
    const rawHost = JSON.parse(fs.readFileSync(PARTY_HOST_FILE, 'utf8'));
    if (rawHost && rawHost.name) {
      partyHost = {
        name: rawHost.name,
        token: rawHost.token || null,
        claimedAt: rawHost.claimedAt || Date.now(),
        lastHeartbeat: Date.now() // Refreshed on process startup
      };
      knownDJs.add(partyHost.name);
    }
  }
} catch (e) {}

function persistPartyHost() {
  try {
    fs.writeFileSync(PARTY_HOST_FILE, JSON.stringify(partyHost, null, 2));
  } catch (e) {}
}

try {
  if (fs.existsSync(DJ_PROFILES_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DJ_PROFILES_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      djProfiles.set(k, v);
      knownDJs.add(k);
    }
  }
} catch (e) {}

function persistDjProfiles() {
  try {
    const obj = Object.fromEntries(djProfiles);
    fs.writeFileSync(DJ_PROFILES_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

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
      persistPartyHost();
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
        requestedToken: pendingTakeover.requestedToken,
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
    token: partyHost.token,
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
  { videoId: '6D79CYTxvOM', title: '爱人错过 (Somewhere in time)', artist: '告五人 Accusefive', thumbnail: 'https://i.ytimg.com/vi/6D79CYTxvOM/hqdefault.jpg', songDuration: 290 },
  { videoId: 'LWV-f6dMN3Q', title: '修炼爱情 (Practice Love)', artist: '林俊杰 JJ Lin', thumbnail: 'https://i.ytimg.com/vi/LWV-f6dMN3Q/hqdefault.jpg', songDuration: 284 },
  { videoId: 'T4SimnaiktU', title: '光年之外 (Light Years Away)', artist: '邓紫棋 G.E.M.', thumbnail: 'https://i.ytimg.com/vi/T4SimnaiktU/hqdefault.jpg', songDuration: 235 },
  { videoId: 'Y2ge3KrdeWs', title: '怎么了 (What\'s Wrong)', artist: '周兴哲 Eric Chou', thumbnail: 'https://i.ytimg.com/vi/Y2ge3KrdeWs/hqdefault.jpg', songDuration: 321 },
  { videoId: '_MQVmPpMQEc', title: '阿拉斯加海湾 (Gulf of Alaska)', artist: '菲道尔 Firdhaus', thumbnail: 'https://i.ytimg.com/vi/_MQVmPpMQEc/hqdefault.jpg', songDuration: 247 },
  { videoId: 'dvgZkm1xWPE', title: 'Viva La Vida', artist: 'Coldplay', thumbnail: 'https://i.ytimg.com/vi/dvgZkm1xWPE/hqdefault.jpg', songDuration: 242 },
  { videoId: '34Na4j8AVgA', title: 'Starboy', artist: 'The Weeknd ft. Daft Punk', thumbnail: 'https://i.ytimg.com/vi/34Na4j8AVgA/hqdefault.jpg', songDuration: 230 },
  { videoId: 'JGwWNGJdvx8', title: 'Shape of You', artist: 'Ed Sheeran', thumbnail: 'https://i.ytimg.com/vi/JGwWNGJdvx8/hqdefault.jpg', songDuration: 233 },
  { videoId: 'ArmDp-zijuc', title: 'Super Shy', artist: 'NewJeans', thumbnail: 'https://i.ytimg.com/vi/ArmDp-zijuc/hqdefault.jpg', songDuration: 154 },
  { videoId: 'x8VYWazR5mE', title: '夜に駆ける (Racing into the Night)', artist: 'YOASOBI', thumbnail: 'https://i.ytimg.com/vi/x8VYWazR5mE/hqdefault.jpg', songDuration: 261 },
  { videoId: 'a2GujJZfXpg', title: 'Sparkle (スパークル)', artist: 'RADWIMPS', thumbnail: 'https://i.ytimg.com/vi/a2GujJZfXpg/hqdefault.jpg', songDuration: 410 },
  { videoId: 'DYptgVvkVLQ', title: '晴天 (Sunny Day)', artist: '周杰伦 Jay Chou', thumbnail: 'https://i.ytimg.com/vi/DYptgVvkVLQ/hqdefault.jpg', songDuration: 319 },
  { videoId: 'kvEeCLf16zM', title: '简单爱 (Simple Love)', artist: '周杰伦 Jay Chou', thumbnail: 'https://i.ytimg.com/vi/kvEeCLf16zM/hqdefault.jpg', songDuration: 271 },
  { videoId: 'KqjgLbKZ1h0', title: '那些年 (Those Bygone Years)', artist: '胡夏 Hu Xia', thumbnail: 'https://i.ytimg.com/vi/KqjgLbKZ1h0/hqdefault.jpg', songDuration: 369 },
  { videoId: 'QSWYyoF79oE', title: 'Sial', artist: 'Mahalini', thumbnail: 'https://i.ytimg.com/vi/QSWYyoF79oE/hqdefault.jpg', songDuration: 244 },
  { videoId: 'fKRtnMYMW08', title: 'Komang', artist: 'Raim Laode', thumbnail: 'https://i.ytimg.com/vi/fKRtnMYMW08/hqdefault.jpg', songDuration: 223 },
  { videoId: 'V9PVRfjEBTI', title: 'BIRDS OF A FEATHER', artist: 'Billie Eilish', thumbnail: 'https://i.ytimg.com/vi/V9PVRfjEBTI/hqdefault.jpg', songDuration: 190 },
  { videoId: 'V1Pl8CzNzCw', title: 'lovely', artist: 'Billie Eilish, Khalid', thumbnail: 'https://i.ytimg.com/vi/V1Pl8CzNzCw/hqdefault.jpg', songDuration: 200 }
];

async function getAutoplayNextTrack(prevSong, historyList = null) {
  const activeHistory = historyList || playedHistory;
  const recentVideoIds = new Set(activeHistory.slice(0, 20).map(h => h.videoId));
  if (prevSong && prevSong.videoId) recentVideoIds.add(prevSong.videoId);

  // 1. Try Innertube search based on previous song's artist or title
  if (prevSong && (prevSong.artist || prevSong.title) && prevSong.title !== 'No song playing') {
    try {
      const cleanArtist = (prevSong.artist || '').replace(/^(?:Video|Lagu)\s*•\s*/i, '').replace(/\s*•.*$/, '').trim();
      const cleanTitle = cleanSongTitle(prevSong.title, prevSong.artist);
      const searchKeyword = cleanArtist ? `${cleanArtist} popular songs` : `${cleanTitle} mix`;
      const searchData = await searchYouTubeMusic(searchKeyword);
      const searchResults = Array.isArray(searchData) ? searchData : (searchData?.results || []);
      const candidates = searchResults.filter(r => r.videoId && !recentVideoIds.has(r.videoId) && r.videoId !== prevSong?.videoId);
      if (candidates.length > 0) {
        const picked = candidates[Math.floor(Math.random() * Math.min(candidates.length, 6))];
        return {
          videoId: picked.videoId,
          title: picked.title,
          artist: picked.artist || cleanArtist || 'YouTube Music',
          thumbnail: picked.thumbnail || '',
          songDuration: 240,
          addedBy: 'Autoplay / YouTube Algorithm'
        };
      }
    } catch (e) {
      console.warn('Autoplay search error:', e.message);
    }
  }

  // 2. Fallback to curated popular party tracks (strictly excluding prevSong and recents)
  const availableFallback = AUTOPLAY_FALLBACK_TRACKS.filter(t => !recentVideoIds.has(t.videoId) && t.videoId !== prevSong?.videoId);
  const pool = availableFallback.length > 0 ? availableFallback : AUTOPLAY_FALLBACK_TRACKS.filter(t => t.videoId !== prevSong?.videoId);
  const picked = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : AUTOPLAY_FALLBACK_TRACKS[0];
  return {
    ...picked,
    addedBy: 'Autoplay / Rekomendasi Pesta'
  };
}

let lastAdvanceTime = 0;

async function advanceNextTrack(targetRoomOrSkipped = null, skippedByUser = null) {
  let targetRoom;
  let skipped;
  if (targetRoomOrSkipped && typeof targetRoomOrSkipped === 'object' && targetRoomOrSkipped.id) {
    targetRoom = targetRoomOrSkipped;
    skipped = skippedByUser;
  } else {
    targetRoom = roomManager.getRoom('main');
    skipped = targetRoomOrSkipped;
  }
  if (!targetRoom) return null;

  const now = Date.now();
  if (now - (targetRoom.lastAdvanceTime || 0) < 1500 && !skipped) {
    console.log(`[advanceNextTrack][Room ${targetRoom.id}] Ignored rapid duplicate advance within 1.5s`);
    return targetRoom.currentSong;
  }
  targetRoom.lastAdvanceTime = now;
  lastAdvanceTime = now;

  const prevSong = targetRoom.currentSong;
  if (prevSong && prevSong.videoId && prevSong.title !== 'No song playing') {
    targetRoom.addPlayedHistory(prevSong);
  }

  if (targetRoom.partyQueue.length > 0) {
    const nextItem = targetRoom.partyQueue.shift();
    let dur = nextItem.songDuration || 0;
    if (!dur) {
      const fallback = AUTOPLAY_FALLBACK_TRACKS.find(t => t.videoId === nextItem.videoId);
      if (fallback && fallback.songDuration) dur = fallback.songDuration;
    }
    if (!dur || dur <= 0) dur = 215;
    targetRoom.currentSong = {
      videoId: nextItem.videoId,
      title: nextItem.title,
      artist: nextItem.artist || '',
      thumbnail: nextItem.thumbnail || '',
      imageSrc: nextItem.thumbnail || '',
      songDuration: dur,
      elapsedSeconds: 0,
      currentElapsed: 0,
      isPaused: false,
      addedBy: nextItem.addedBy || 'Host',
      startedAt: Date.now()
    };
  } else {
    // AUTOPLAY: Queue is empty -> fetch YouTube recommendation automatically!
    const autoTrack = await getAutoplayNextTrack(prevSong, targetRoom.playedHistory);
    targetRoom.currentSong = {
      videoId: autoTrack.videoId,
      title: autoTrack.title,
      artist: autoTrack.artist || '',
      thumbnail: autoTrack.thumbnail || '',
      imageSrc: autoTrack.thumbnail || '',
      songDuration: autoTrack.songDuration || 240,
      elapsedSeconds: 0,
      currentElapsed: 0,
      isPaused: false,
      addedBy: autoTrack.addedBy || 'Autoplay / YouTube Algorithm',
      startedAt: Date.now()
    };
    targetRoom.addActivity('System', 'autoplay', `memutar "${autoTrack.title}" (Autoplay)`);
  }

  targetRoom.playbackTracker.videoId = targetRoom.currentSong.videoId;
  targetRoom.playbackTracker.elapsed = 0;
  targetRoom.playbackTracker.lastReportedElapsed = -1;
  targetRoom.playbackTracker.isPaused = targetRoom.currentSong.isPaused;
  targetRoom.playbackTracker.songDuration = targetRoom.currentSong.songDuration;
  targetRoom.playbackTracker.lastUpdated = Date.now();

  await roomManager.persistRoom(targetRoom);
  if (skipped) {
    targetRoom.addActivity(skipped, 'skip', targetRoom.currentSong.title || 'song');
  }
  targetRoom.broadcastUpdate(dynamicPublicUrl);
  setTimeout(() => prewarmUpcomingTracks(targetRoom), 500);

  // Asynchronously resolve song duration if still missing
  if ((!targetRoom.currentSong.songDuration || targetRoom.currentSong.songDuration <= 0) && targetRoom.currentSong.videoId) {
    fetchDirectAudioUrl(targetRoom.currentSong.videoId).then(async info => {
      if (info && info.duration > 0 && targetRoom.currentSong.videoId === info.videoId) {
        targetRoom.currentSong.songDuration = info.duration;
        targetRoom.playbackTracker.songDuration = info.duration;
        await roomManager.persistRoom(targetRoom);
        targetRoom.broadcastUpdate(dynamicPublicUrl);
      }
    }).catch(() => {});
  }
  return targetRoom.currentSong;
}

// Server-Side Master Autoplay & Song Completion Watchdog (Runs for standalone instances)
function checkServerPlaybackAutoplay(room = null) {
  // On Vercel Serverless, background timers freeze and thaw between HTTP invocations, creating
  // massive artificial time jumps that prematurely skip active songs. The client Host Audio Engine
  // reports /api/control/ended when songs physically complete.
  if (IS_VERCEL) return;

  const targetRoom = room || roomManager.getRoom('main');
  if (!targetRoom) return;

  // Resource Saver: Do not spin idle rooms with 0 listeners and no queue
  if (targetRoom.id !== 'main' && targetRoom.clients.size === 0 && targetRoom.partyQueue.length === 0) {
    return;
  }

  if (!targetRoom.currentSong || !targetRoom.currentSong.videoId || targetRoom.currentSong.title === 'No song playing') return;
  if (targetRoom.playbackTracker.isPaused) return;

  // If room has an active Host with recent heartbeat (< 45s), DEFER strictly to Host physical audio!
  const now = Date.now();
  if (targetRoom.partyHost.name && targetRoom.partyHost.lastHeartbeat && (now - targetRoom.partyHost.lastHeartbeat < 45000)) {
    return;
  }

  const dur = (targetRoom.currentSong.songDuration && targetRoom.currentSong.songDuration > 0) ? targetRoom.currentSong.songDuration : 240;
  const startedAt = targetRoom.currentSong.startedAt || targetRoom.playbackTracker.lastUpdated || now;
  const rawElapsed = (now - startedAt) / 1000;

  // If track has reached or exceeded its duration (+ 5s buffer to allow client to report first)
  if (rawElapsed >= dur + 5) {
    console.log(`[Autoplay Watchdog][Room ${targetRoom.id}] Track "${targetRoom.currentSong.title}" reached end (${rawElapsed.toFixed(1)}s / ${dur}s). Advancing track automatically...`);
    advanceNextTrack(targetRoom, 'Autoplay Watchdog / Server');
  }
}
setInterval(() => {
  for (const r of roomManager.getAllRooms()) {
    checkServerPlaybackAutoplay(r);
  }
}, 1000);

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
      if (text) {
        result.push({
          time,
          text,
          pinyin: ''
        });
      }
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

async function enrichLyricsLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return { lang: 'other', lines: [] };

  const fullText = lines.map(l => l.text).join(' ');
  const hasHangul = /[\uac00-\ud7af\u1100-\u11ff]/.test(fullText);
  const hasKana = /[\u3040-\u309f\u30a0-\u30ff]/.test(fullText);
  const hasHanzi = /[\u4e00-\u9fa5]/.test(fullText);

  let lang = 'other';
  if (hasHangul) lang = 'korean';
  else if (hasKana) lang = 'japanese';
  else if (hasHanzi) lang = 'chinese';

  for (const line of lines) {
    if (!line.text) {
      line.pinyin = '';
      continue;
    }
    try {
      if (lang === 'korean' && /[\uac00-\ud7af\u1100-\u11ff]/.test(line.text) && hangulRomanizer && hangulRomanizer.convert) {
        line.pinyin = hangulRomanizer.convert(line.text);
      } else if (lang === 'japanese') {
        if (isKuroshiroReady && kuroshiro) {
          line.pinyin = await kuroshiro.convert(line.text, { to: 'romaji', mode: 'spaced' });
        } else if (wanakanaLib) {
          line.pinyin = wanakanaLib.toRomaji(line.text);
        } else {
          line.pinyin = '';
        }
      } else if (lang === 'chinese' && /[\u4e00-\u9fa5]/.test(line.text) && pinyinLib) {
        line.pinyin = pinyinLib.pinyin(line.text);
      } else {
        line.pinyin = '';
      }
    } catch (e) {
      line.pinyin = '';
    }
  }

  return { lang, lines };
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
    const plainLines = (!isSynced && data.plainLyrics) ? data.plainLyrics.split('\n').map(l => ({
      text: l.trim(),
      pinyin: ''
    })).filter(l => l.text) : [];

    const rawLines = isSynced ? parsedLines : plainLines;
    const { lang, lines: enrichedLines } = await enrichLyricsLines(rawLines);

    const result = {
      hasLyrics: true,
      isSynced,
      language: lang,
      trackName: data.trackName || cleanTitle,
      artistName: data.artistName || cleanArtist,
      plain: data.plainLyrics || (isSynced ? enrichedLines.map(l => l.text).join('\n') : ''),
      lines: enrichedLines
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
    dj: user || 'Someone',
    action,
    type: action,
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
  const base = (typeof playbackTracker.elapsed === 'number' && playbackTracker.elapsed > 0)
    ? playbackTracker.elapsed
    : (currentSong.elapsedSeconds || 0);
  if (playbackTracker.isPaused) return Math.floor(base);
  const delta = (Date.now() - playbackTracker.lastUpdated) / 1000;
  const total = base + delta;
  const max = playbackTracker.songDuration > 0 ? playbackTracker.songDuration : 9999;
  return Math.floor(Math.min(total, max));
}

function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  input = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const vMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (vMatch) return vMatch[1];
  const shortMatch = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  const embedMatch = input.match(/youtube\.com\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];
  return null;
}

function isRadioOrMixPlaylist(playlistId, input = '') {
  if (!playlistId) return false;
  // YouTube Mixes & Endless Radios always start with RD (e.g. RD..., RDAMVM..., RDCLAK...) or UL (Uploads mix)
  if (/^(?:RD|UL)/i.test(playlistId)) return true;
  if (input && /[?&]start_radio=1/i.test(input)) return true;
  return false;
}

function extractPlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  input = input.trim();
  const hasVideoId = extractVideoId(input);
  const match = input.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (match) {
    const listId = match[1];
    // If it's a YouTube Mix / Radio (starts with RD, UL, or has start_radio=1):
    // It is an algorithmic radio based on that song, NOT an importable playlist!
    if (isRadioOrMixPlaylist(listId, input) || /^RD/i.test(listId)) {
      return null;
    }
    return listId;
  }
  if (/^(?:PL|OLAK5uy)[a-zA-Z0-9_-]{10,}$/.test(input)) return input;
  return null;
}

function fetchPlaylistInfo(playlistId) {
  return new Promise((resolve, reject) => {
    const ytdlBin = findYtDlpBinary();
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;
    execFile(ytdlBin, [
      '--js-runtimes', 'node',
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-items', '1-50', // Max 50 tracks for party speed and safety
      url
    ], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        return reject(new Error('Gagal membaca playlist atau playlist bersifat privat / tidak ditemukan.'));
      }
      try {
        const data = JSON.parse(stdout);
        const tracks = (data.entries || []).map((entry, idx) => {
          let thumb = '';
          if (entry.thumbnails && Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
            thumb = entry.thumbnails[entry.thumbnails.length - 1].url;
          } else if (entry.id) {
            thumb = `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
          }
          return {
            index: idx + 1,
            videoId: entry.id,
            title: entry.title || 'Unknown Title',
            artist: entry.uploader || entry.channel || entry.artist || 'YouTube Music',
            thumbnail: thumb,
            songDuration: typeof entry.duration === 'number' ? Math.round(entry.duration) : 0
          };
        }).filter(t => t.videoId && t.videoId.length === 11);

        if (tracks.length === 0) {
          return reject(new Error('Playlist tidak memiliki lagu publik yang dapat diputar.'));
        }

        resolve({
          playlistId,
          title: data.title || 'YouTube Playlist',
          author: data.uploader || data.channel || 'YouTube Music',
          totalTracks: tracks.length,
          tracks
        });
      } catch (e) {
        reject(new Error('Format data playlist tidak dapat diproses.'));
      }
    });
  });
}

function isTitleKeywordMatch(reqTitle, ytTitle) {
  if (!reqTitle || !ytTitle) return true;
  const extractWords = s => (s.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []);
  const w1 = extractWords(reqTitle);
  const w2 = new Set(extractWords(ytTitle));
  const meaningful = w1.filter(w => w.length >= 3 || /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(w));
  if (meaningful.length === 0) return true;
  return meaningful.some(w => w2.has(w));
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

// Direct YouTube Music Search via Innertube WEB_REMIX API (with Infinite Pagination & Continuation)
async function searchYouTubeMusic(query, continuationToken = null) {
  try {
    let url = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
    let body = {
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20231204.01.00',
          hl: 'id',
          gl: 'ID'
        }
      }
    };

    if (continuationToken) {
      url = `https://music.youtube.com/youtubei/v1/search?continuation=${encodeURIComponent(continuationToken)}&ctoken=${encodeURIComponent(continuationToken)}&prettyPrint=false`;
    } else {
      body.query = query;
      // Filter by Songs by default to get clean song entries + continuation tokens
      body.params = 'EgWKAQIIAWoSEAUQAxAEEAkQChAVEBAQDhAR';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000)
    });

    if (!res.ok) return { results: [], continuationToken: null, hasMore: false };
    const data = await res.json();

    const results = [];
    const seenIds = new Set();
    let nextContinuationToken = null;

    function parseDurationSec(runs, accessibilityLabel) {
      if (accessibilityLabel) {
        const minMatch = accessibilityLabel.match(/(\d+)\s*(?:menit|minutes?|min)/i);
        const secMatch = accessibilityLabel.match(/(\d+)\s*(?:detik|seconds?|sec)/i);
        if (minMatch || secMatch) {
          return (minMatch ? parseInt(minMatch[1], 10) * 60 : 0) + (secMatch ? parseInt(secMatch[1], 10) : 0);
        }
      }
      if (Array.isArray(runs)) {
        for (let i = runs.length - 1; i >= 0; i--) {
          const txt = runs[i]?.text?.trim();
          const m = txt?.match(/^(\d+):(\d+)$/) || txt?.match(/^(\d+)\.(\d+)$/);
          if (m) {
            return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          }
        }
      }
      return 0;
    }

    function addItem(item) {
      if (!item) return;
      const flex = item.flexColumns || [];
      const title = flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
      const subtitleRuns = flex[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
      const artist = subtitleRuns.map(r => r.text).join('');
      const accessLabel = flex[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.accessibility?.accessibilityData?.label || '';
      const songDuration = parseDurationSec(subtitleRuns, accessLabel);

      const videoId = item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
        || flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;

      const thumbnails = item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      const thumbnail = thumbnails[thumbnails.length - 1]?.url || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '');

      if (videoId && title && !seenIds.has(videoId)) {
        seenIds.add(videoId);
        results.push({ videoId, title, artist, thumbnail, songDuration });
      }
    }

    if (continuationToken) {
      // Continuation response
      const shelfCont = data?.continuationContents?.musicShelfContinuation;
      if (shelfCont?.contents) {
        for (const c of shelfCont.contents) {
          if (c.musicResponsiveListItemRenderer) addItem(c.musicResponsiveListItemRenderer);
        }
      }
      nextContinuationToken = shelfCont?.continuations?.[0]?.nextContinuationData?.continuation || null;
    } else {
      // Initial search response
      const tabs = data?.contents?.tabbedSearchResultsRenderer?.tabs;
      const sectionList = tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];

      for (const section of sectionList) {
        if (section.musicShelfRenderer) {
          if (section.musicShelfRenderer.contents) {
            for (const c of section.musicShelfRenderer.contents) {
              if (c.musicResponsiveListItemRenderer) addItem(c.musicResponsiveListItemRenderer);
            }
          }
          if (section.musicShelfRenderer.continuations?.[0]?.nextContinuationData?.continuation) {
            nextContinuationToken = section.musicShelfRenderer.continuations[0].nextContinuationData.continuation;
          }
        }
        if (section.itemSectionRenderer?.contents) {
          for (const c of section.itemSectionRenderer.contents) {
            if (c.musicResponsiveListItemRenderer) addItem(c.musicResponsiveListItemRenderer);
          }
        }
      }

      // If filtered search returned nothing, fallback to general search without params
      if (results.length === 0) {
        try {
          const fallbackRes = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: JSON.stringify({
              context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20231204.01.00', hl: 'id', gl: 'ID' } },
              query: query
            }),
            signal: AbortSignal.timeout(6000)
          });
          if (fallbackRes.ok) {
            const fallbackData = await fallbackRes.json();
            const fTabs = fallbackData?.contents?.tabbedSearchResultsRenderer?.tabs;
            const fSections = fTabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
            for (const section of fSections) {
              if (section.musicShelfRenderer?.contents) {
                for (const c of section.musicShelfRenderer.contents) {
                  if (c.musicResponsiveListItemRenderer) addItem(c.musicResponsiveListItemRenderer);
                }
              }
              if (section.itemSectionRenderer?.contents) {
                for (const c of section.itemSectionRenderer.contents) {
                  if (c.musicResponsiveListItemRenderer) addItem(c.musicResponsiveListItemRenderer);
                }
              }
            }
          }
        } catch (e) {}
      }
    }

    return { results, continuationToken: nextContinuationToken, hasMore: Boolean(nextContinuationToken) };
  } catch (err) {
    return { results: [], continuationToken: null, hasMore: false };
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

// --- GOOGLE OAUTH 2.0 ROUTES ---
app.get('/auth/google', (req, res) => {
  updateActivityTimestamp();
  const host = req.get('host');
  const proto = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const redirectUri = `${proto}://${host}/auth/callback`;
  const room = (req.query.room || '').trim().toUpperCase().slice(0, 6);
  const stateObj = { nonce: Math.random().toString(36).slice(2), room };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('prompt', 'select_account');
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.toString());
});

app.get('/auth/callback', async (req, res) => {
  updateActivityTimestamp();
  const { code, error, state } = req.query;
  let targetRoom = '';
  try {
    if (state) {
      const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
      if (parsed && parsed.room) targetRoom = String(parsed.room).toUpperCase().slice(0, 6);
    }
  } catch (e) {}

  if (error || !code) {
    const errParam = encodeURIComponent(error || 'Izin Google dibatalkan');
    const roomParam = targetRoom ? `&room=${encodeURIComponent(targetRoom)}` : '';
    return res.redirect(`/?auth_error=${errParam}${roomParam}`);
  }

  const host = req.get('host');
  const proto = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const redirectUri = `${proto}://${host}/auth/callback`;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[OAuth] Token exchange error:', tokenData);
      return res.redirect(`/?auth_error=${encodeURIComponent(tokenData.error_description || 'Gagal autentikasi Google')}`);
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const userData = await userRes.json();
    if (!userRes.ok || !userData.name) {
      return res.redirect('/?auth_error=Gagal+mengambil+profil+Google');
    }

    const djName = userData.name.trim().slice(0, 25);
    const djProfile = {
      name: djName,
      email: userData.email || '',
      avatar: userData.picture || '',
      googleId: userData.id || '',
      loggedInAt: Date.now()
    };

    djProfiles.set(djName, djProfile);
    knownDJs.add(djName);
    persistDjProfiles();

    addActivity(djName, 'login_google', 'masuk dengan akun Google');
    broadcastUpdate();

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Berhasil Masuk</title>
        <style>
          body { background: #0b0d14; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #131722; padding: 2rem; border-radius: 1rem; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 340px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
          .avatar { width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 1rem; border: 2px solid #ec4899; }
          h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
          p { margin: 0; font-size: 0.85rem; color: #94a3b8; }
        </style>
      </head>
      <body>
        <div class="card">
          <img src="${djProfile.avatar || 'https://via.placeholder.com/64'}" class="avatar">
          <h2>Selamat datang, ${djName}!</h2>
          <p>Mengarahkan ke Party Jukebox...</p>
        </div>
        <script>
          try {
            localStorage.setItem('jukebox_user', ${JSON.stringify(djName)});
            localStorage.setItem('jukebox_user_profile', ${JSON.stringify(JSON.stringify(djProfile))});
          } catch(e) {}
          const targetRoom = ${JSON.stringify(targetRoom)} || localStorage.getItem('jukebox_room_redirect') || '';
          setTimeout(function() {
            window.location.href = targetRoom ? '/?room=' + encodeURIComponent(targetRoom) : '/';
          }, 600);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[OAuth] Callback error:', err);
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
});

app.post('/api/auth/logout', (req, res) => {
  const { user } = req.body || {};
  if (user) {
    addActivity(user, 'logout', 'keluar dari sesi pesta');
    broadcastUpdate();
  }
  res.json({ success: true });
});

// 0. Version Endpoint

// ==========================================
// MULTI-PARTY ROOM MANAGEMENT ENDPOINTS
// ==========================================
app.get('/api/rooms/check/:code', async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!code || code.length < 2) {
    return res.status(400).json({ exists: false, error: 'Kode room minimal 2 karakter.' });
  }
  const room = await roomManager.getOrHydrateRoom(code, null, null, true);
  if (room) {
    return res.json({
      exists: true,
      room: {
        id: room.id,
        code: room.id,
        name: room.name,
        creator: room.creator,
        listeners: room.clients.size,
        activeDJsCount: room.activeDevices ? room.activeDevices.size : 0,
        queueCount: room.partyQueue.length,
        currentSong: {
          title: room.currentSong.title,
          artist: room.currentSong.artist,
          thumbnail: room.currentSong.thumbnail
        }
      }
    });
  }
  return res.json({ exists: false, error: 'Room dengan kode tersebut tidak ditemukan.' });
});

app.get('/api/rooms', async (req, res) => {
  const knownParam = req.query.known || req.headers['x-known-rooms'] || '';
  const knownIds = knownParam
    ? String(knownParam).split(',').map(s => s.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')).filter(Boolean)
    : [];
  for (const id of knownIds) {
    await roomManager.getOrHydrateRoom(id);
  }
  const roomsList = await roomManager.listRooms(Boolean(knownIds.length > 0), knownIds);
  res.json({
    success: true,
    rooms: roomsList
  });
});

app.post('/api/rooms', async (req, res) => {
  const { id, name, creator } = req.body || {};
  const inputName = (name || '').trim();
  if (!inputName) {
    return res.status(400).json({ error: 'Nama party room wajib diisi.' });
  }

  let customCode = (id || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (customCode) {
    if (customCode.length < 2 || customCode.length > 6) {
      return res.status(400).json({ error: 'Kode kustom harus antara 2 hingga 6 karakter (huruf/angka).' });
    }
    const exists = await roomManager.checkRoomExists(customCode);
    if (exists) {
      return res.status(409).json({ error: `Kode room "${customCode}" sudah digunakan. Gunakan kode lain atau kosongkan untuk kode otomatis.` });
    }
  } else {
    customCode = roomManager.generateUniqueRoomCode();
  }

  const cleanName = inputName.slice(0, 40);
  const cleanCreator = (creator || 'Host').trim().slice(0, 25);
  const room = roomManager.createRoom(customCode, cleanName, cleanCreator);

  let creatorToken = null;
  if (cleanCreator && cleanCreator !== 'Host') {
    creatorToken = 'tok_' + Math.random().toString(36).slice(2, 10);
    room.partyHost = {
      name: cleanCreator,
      token: creatorToken,
      claimedAt: Date.now(),
      lastHeartbeat: Date.now(),
      pendingTakeover: null
    };
    room.knownDJs.add(cleanCreator);
    room.addActivity(cleanCreator, 'host_claim', `membuat room dan menjadi Host 👑`);
  }
  await roomManager.persistRoom(room);

  res.json({
    success: true,
    room: {
      id: room.id,
      code: room.id,
      name: room.name,
      creator: room.creator,
      createdAt: room.createdAt,
      listeners: room.clients.size,
      queueCount: room.partyQueue.length
    },
    hostToken: creatorToken,
    partyHost: room.getPartyHostInfo()
  });
});

app.delete('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const deleted = roomManager.deleteRoom(roomId);
  res.json({ success: deleted });
});

// Device Presence & Duplicate User Endpoint
app.post('/api/room/presence', async (req, res) => {
  const { deviceId, name, email, mode } = req.body || {};
  if (!req.room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  const result = req.room.registerDevicePresence(deviceId, name, email, mode || 'check');
  await roomManager.persistRoom(req.room);
  res.json(result);
});

app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    isVercel: IS_VERCEL,
    name: 'Party Jukebox',
    playbackEngine: isUsingYtmDesktop() ? 'ytm_desktop' : (IS_VERCEL ? 'youtube' : 'standalone'),
    preferredEngineMode: IS_VERCEL ? 'youtube' : preferredEngineMode,
    ytmCompanionOnline: isYtmConnected,
    isVercel: IS_VERCEL
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
  res.json({ partyHost: req.room.getPartyHostInfo() });
});

app.post(['/api/host/claim', '/api/host/takeover/request'], async (req, res) => {
  const room = req.room;
  room.checkHostVacant();
  const { name, token, force } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Valid host name is required' });
  }
  const cleanName = name.trim().slice(0, 25);
  const hostToken = token || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  // If host is vacant, token matches existing host, or force takeover is allowed
  if (room.partyHost.name === null || room.partyHost.token === token || (room.partyHost.name.toLowerCase() === cleanName.toLowerCase() && !room.pendingTakeover) || force) {
    const prevHost = room.partyHost.name;
    room.pendingTakeover = null;
    room.partyHost = {
      name: cleanName,
      token: hostToken,
      claimedAt: Date.now(),
      lastHeartbeat: Date.now()
    };
    await roomManager.persistRoom(room);
    room.knownDJs.add(cleanName);
    room.addActivity(cleanName, 'host_claimed', prevHost && prevHost !== cleanName ? `mengambil alih kursi Host dari ${prevHost}` : 'menjadi Host Party malam ini 👑');
    room.broadcastUpdate(dynamicPublicUrl);
    return res.json({ success: true, partyHost: room.getPartyHostInfo(), token: hostToken });
  }

  // If host is occupied by someone else: Trigger takeover approval request
  room.pendingTakeover = {
    id: 'tk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    requestingDJ: cleanName,
    requestedBy: cleanName,
    requestedToken: hostToken,
    token: hostToken,
    currentHost: room.partyHost.name,
    requestedAt: Date.now(),
    expiresAt: Date.now() + 30000
  };

  room.addActivity(cleanName, 'takeover_request', `meminta izin mengambil alih kursi Host dari ${room.partyHost.name}`);
  await roomManager.persistRoom(room);
  room.broadcastUpdate(dynamicPublicUrl);

  return res.json({
    success: true,
    pendingApproval: true,
    message: `Permintaan pengalihan Host dikirim ke ${room.partyHost.name}. Menunggu persetujuan (otomatis disetujui dalam 30 detik)...`,
    partyHost: room.getPartyHostInfo(),
    token: hostToken
  });
});

app.post('/api/host/takeover/respond', async (req, res) => {
  let room = req.room;
  if (!room.pendingTakeover) {
    room = await roomManager.getOrHydrateRoom(req.roomId, null, null, true);
    req.room = room;
  }
  const { approve, token } = req.body || {};
  if (!room.pendingTakeover) {
    return res.status(400).json({ error: 'Tidak ada permintaan ambil alih yang aktif saat ini' });
  }

  // Verify that the responder is the current host
  if (room.partyHost.token && token && room.partyHost.token !== token) {
    return res.status(403).json({ error: 'Hanya Host saat ini yang dapat menyetujui atau menolak pengalihan' });
  }

  const reqUser = room.pendingTakeover.requestingDJ || room.pendingTakeover.requestedBy;
  const reqToken = room.pendingTakeover.token || room.pendingTakeover.requestedToken;
  const curHost = room.partyHost.name;

  if (approve) {
    room.pendingTakeover = null;
    room.partyHost = {
      name: reqUser,
      token: reqToken,
      claimedAt: Date.now(),
      lastHeartbeat: Date.now()
    };
    await roomManager.persistRoom(room);
    room.knownDJs.add(reqUser);
    room.addActivity(curHost, 'takeover_approved', `menyetujui pemindahan kursi Host ke ${reqUser} 👑`);
    room.broadcastUpdate(dynamicPublicUrl);
    return res.json({ success: true, approved: true, partyHost: room.getPartyHostInfo() });
  } else {
    room.pendingTakeover = null;
    room.addActivity(curHost, 'takeover_rejected', `menolak permintaan ambil alih Host dari ${reqUser}`);
    await roomManager.persistRoom(room);
    room.broadcastUpdate(dynamicPublicUrl);
    return res.json({ success: true, approved: false, partyHost: room.getPartyHostInfo() });
  }
});

app.post('/api/host/takeover/cancel', async (req, res) => {
  const room = req.room;
  const { name } = req.body || {};
  if (!room.pendingTakeover) {
    return res.json({ success: true, partyHost: room.getPartyHostInfo() });
  }

  const reqUser = room.pendingTakeover.requestingDJ || room.pendingTakeover.requestedBy;
  room.pendingTakeover = null;
  room.addActivity(name || reqUser, 'takeover_cancelled', `membatalkan permintaan ambil alih Host`);
  await roomManager.persistRoom(room);
  room.broadcastUpdate(dynamicPublicUrl);
  return res.json({ success: true, partyHost: room.getPartyHostInfo() });
});

app.post('/api/host/heartbeat', async (req, res) => {
  const room = req.room;
  const { token, name } = req.body || {};
  if (room.partyHost.name && room.partyHost.token && room.partyHost.token === token) {
    room.partyHost.lastHeartbeat = Date.now();
    await roomManager.persistRoom(room);
    return res.json({ success: true, partyHost: room.getPartyHostInfo() });
  }

  // AUTO-RESTORE: If host seat is vacant, re-attach returning user seamlessly
  if ((room.partyHost.name === null || room.partyHost.name === undefined) && token && name) {
    const cleanName = name.trim().slice(0, 25);
    console.log(`[Host Auto-Restore][Room ${room.id}] Re-attaching host session for ${cleanName}`);
    room.partyHost = {
      name: cleanName,
      token: token,
      claimedAt: Date.now(),
      lastHeartbeat: Date.now()
    };
    room.knownDJs.add(cleanName);
    await roomManager.persistRoom(room);
    room.broadcastUpdate(dynamicPublicUrl);
    return res.json({ success: true, partyHost: room.getPartyHostInfo() });
  }

  room.checkHostVacant();
  res.json({ success: false, partyHost: room.getPartyHostInfo() });
});

app.post('/api/host/release', async (req, res) => {
  const room = req.room;
  const { token } = req.body || {};
  if (room.partyHost.name && (!token || room.partyHost.token === token)) {
    const oldHost = room.partyHost.name;
    room.partyHost = { name: null, token: null, claimedAt: null, lastHeartbeat: null };
    room.pendingTakeover = null;
    await roomManager.persistRoom(room);
    room.addActivity(oldHost, 'host_released', 'melepas kursi Host. Status sekarang VACANT ⚠️');
    room.broadcastUpdate(dynamicPublicUrl);
    return res.json({ success: true, partyHost: room.getPartyHostInfo() });
  }
  res.json({ success: true, partyHost: room.getPartyHostInfo() });
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

  const room = req.room;
  room.checkHostVacant();

  const deviceId = req.headers['x-device-id'] || req.query.deviceId || '';
  const isReplaced = deviceId ? room.isDeviceReplaced(deviceId) : false;

  const currentIp = getLocalIp();
  const activePublicUrl = dynamicPublicUrl || (process.env.PUBLIC_URL || (process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'https://dj.wsnsam.my.id' : null));

  res.json({
    online: true,
    standalone: true,
    playbackEngine: 'standalone',
    preferredEngineMode: 'standalone',
    ytmCompanionOnline: false,
    version: APP_VERSION,
    isVercel: IS_VERCEL,
    isDeviceReplaced: isReplaced,
    room: {
      id: room.id,
      code: room.id,
      name: room.name,
      creator: room.creator,
      listeners: room.clients.size,
      activeDJsCount: room.activeDevices ? room.activeDevices.size : 0,
      isIdle: room.isIdle()
    },
    host: {
      ip: currentIp,
      url: `http://${currentIp}:${PORT}`,
      publicUrl: activePublicUrl,
      isTunnelActive: Boolean(dynamicPublicUrl || process.env.CLOUDFLARE_TUNNEL_TOKEN)
    },
    current: {
      ...room.currentSong,
      currentElapsed: room.getCalculatedElapsed(),
      isPaused: room.playbackTracker.isPaused,
      isAudioCached: directAudioCache.has(room.currentSong?.videoId || '')
    },
    cachedTrackIds: Array.from(directAudioCache.keys()),
    queue: room.getFormattedQueue(),
    selectedIndex: -1,
    partyHost: room.getPartyHostInfo(),
    djs: Array.from(room.knownDJs),
    djProfiles: Object.fromEntries(room.djProfiles),
    isRoomSleeping: room.isRoomSleeping,
    volume: { state: room.currentVolume, isMuted: room.isMuted },
    activity: room.activityLogs.slice(0, 30),
    history: room.playedHistory.slice(0, 30)
  });
});

// 2. Direct Search with Infinite Pagination Support
app.post('/api/search', async (req, res) => {
  const { query, continuationToken } = req.body || {};
  if (!continuationToken && (!query || typeof query !== 'string' || !query.trim())) {
    return res.json({ results: [], continuationToken: null, hasMore: false });
  }
  const data = await searchYouTubeMusic((query || '').trim(), continuationToken || null);
  res.json({
    results: data.results,
    continuationToken: data.continuationToken,
    hasMore: data.hasMore
  });
});

// 2.5 Playlist Extraction & Confirmation Endpoints
app.post('/api/playlist/info', async (req, res) => {
  const { url } = req.body || {};
  const playlistId = extractPlaylistId(url);
  if (!playlistId) {
    return res.status(400).json({ error: 'Format link playlist YouTube tidak valid. Pastikan link memiliki format list=...' });
  }

  try {
    const info = await fetchPlaylistInfo(playlistId);
    res.json({ success: true, ...info });
  } catch (err) {
    console.error('Playlist fetch error:', err.message);
    res.status(400).json({ error: err.message || 'Gagal memuat playlist' });
  }
});

app.post('/api/playlist/queue', async (req, res) => {
  let { tracks, user, playlistTitle, shuffle } = req.body || {};
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return res.status(400).json({ error: 'Tidak ada lagu yang dipilih dari playlist' });
  }

  // Cap at 100 tracks max to protect party queue
  tracks = tracks.slice(0, 100);

  if (shuffle) {
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
  }

  const effectiveUser = user || 'Guest';
  const newItems = tracks.map(t => ({
    videoId: t.videoId,
    title: t.title,
    artist: t.artist || '',
    thumbnail: t.thumbnail || `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`,
    songDuration: t.songDuration || 0,
    addedBy: effectiveUser,
    votes: 0,
    voters: []
  }));

  const room = req.room;
  room.partyQueue.push(...newItems);
  await roomManager.persistRoom(room);

  room.addActivity(effectiveUser, 'playlist', `menambahkan ${newItems.length} lagu dari playlist "${playlistTitle || 'YouTube'}"`);

  // If no song currently playing, immediately start playing first song
  if (!room.currentSong || !room.currentSong.videoId || room.currentSong.title === 'No song playing') {
    await advanceNextTrack(room, 'Playlist Auto Play');
  } else {
    room.broadcastUpdate(dynamicPublicUrl);
  }

  res.json({
    success: true,
    count: newItems.length,
    playlistTitle: playlistTitle || 'YouTube Playlist'
  });
});

// 3. Add to Queue / Transfer Song to YouTube Music
app.post('/api/queue', async (req, res) => {
  let { input, videoId: reqVideoId, user, title, artist, thumbnail, songDuration } = req.body;
  let videoId = extractVideoId(input || reqVideoId);

  if (!videoId) {
    return res.status(400).json({ error: 'Format link atau ID YouTube tidak valid.' });
  }

  let validation = await validateYouTubeMusicTrack(videoId);
  const hasMismatch = validation.valid && validation.title && validation.title !== 'Unknown Title' && title && !isTitleKeywordMatch(title, validation.title);

  if (!validation.valid || hasMismatch) {
    if (hasMismatch) {
      console.warn(`[Queue Title Mismatch] Requested "${title}" by "${artist}", but videoId ${videoId} is actually "${validation.title}". Initiating auto-recovery...`);
    }
    // SMART AUTO-RECOVERY: If video is 404/deleted/has typo/title mismatch, search YouTube Music for an active matching live track!
    if (title || artist) {
      try {
        const cleanQuery = `${title || ''} ${artist || ''}`.replace(/\([^)]*\)/g, ' ').trim();
        console.log(`[Queue Auto-Recovery] Searching YouTube Music for: "${cleanQuery}"`);
        const searchData = await searchYouTubeMusic(cleanQuery);
        const searchResults = Array.isArray(searchData) ? searchData : (searchData?.results || []);
        for (const candidate of searchResults) {
          if (candidate.videoId) {
            const candidateValidation = await validateYouTubeMusicTrack(candidate.videoId);
            if (candidateValidation.valid && (!title || isTitleKeywordMatch(title, candidateValidation.title))) {
              console.log(`[Queue Auto-Recovery] Auto-recovered matching track: ${candidate.videoId} (${candidate.title})`);
              videoId = candidate.videoId;
              validation = candidateValidation;
              if (!thumbnail || thumbnail.includes('placeholder')) {
                thumbnail = candidate.thumbnail || validation.thumbnail;
              }
              break;
            }
          }
        }
      } catch (recoveryErr) {
        console.warn('[Queue Auto-Recovery] Error during auto-search:', recoveryErr.message);
      }
    }

    if (!validation.valid) {
      return res.status(422).json({ error: validation.error });
    }
  }

  // Canonicalize song title: if title still completely disagrees with real YouTube video, adopt the true YouTube title!
  let songTitle = title || validation.title || 'Song';
  let songArtist = artist || validation.artist || '';
  if (validation.title && validation.title !== 'Unknown Title' && !isTitleKeywordMatch(songTitle, validation.title)) {
    console.log(`[Queue Title Canonicalization] Adopting true YouTube title: "${validation.title}"`);
    songTitle = validation.title;
    if (validation.artist && validation.artist !== 'YouTube') songArtist = validation.artist;
  }
  const songThumb = thumbnail || validation.thumbnail || '';
  const songUser = user || 'Anonymous';
  let duration = (typeof songDuration === 'number' && songDuration > 0) ? Math.round(songDuration) : 0;
  if (!duration) {
    const known = AUTOPLAY_FALLBACK_TRACKS.find(t => t.videoId === videoId);
    if (known && known.songDuration) duration = known.songDuration;
  }

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

  // 2. Standalone Room Queue:
  const room = req.room;
  const isStarterSong = (
    !room.currentSong.videoId ||
    room.currentSong.title === 'No song playing' ||
    (room.currentSong.addedBy === 'Party Jukebox' && (room.playbackTracker.elapsed || 0) === 0 && room.partyQueue.length === 0)
  );

  if (isStarterSong) {
    room.currentSong = {
      videoId,
      title: songTitle,
      artist: songArtist,
      thumbnail: songThumb,
      imageSrc: songThumb,
      songDuration: duration,
      elapsedSeconds: 0,
      isPaused: false,
      addedBy: songUser,
      startedAt: Date.now()
    };
    room.playbackTracker.videoId = videoId;
    room.playbackTracker.elapsed = 0;
    room.playbackTracker.lastReportedElapsed = -1;
    room.playbackTracker.isPaused = false;
    room.playbackTracker.songDuration = duration;
    room.playbackTracker.lastUpdated = Date.now();

    room.addActivity(songUser, 'add', `memutar "${songTitle}"`);
    await roomManager.persistRoom(room);
    room.broadcastUpdate(dynamicPublicUrl);

    if (!room.currentSong.songDuration || room.currentSong.songDuration <= 0) {
      fetchDirectAudioUrl(room.currentSong.videoId).then(info => {
        const dur = typeof info === 'object' ? info.duration : 0;
        if (dur > 0 && room.currentSong.videoId === videoId) {
          room.currentSong.songDuration = dur;
          room.playbackTracker.songDuration = dur;
          roomManager.persistRoom(room);
          room.broadcastUpdate(dynamicPublicUrl);
        }
      }).catch(() => {});
    }

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
    songDuration: duration,
    addedBy: songUser,
    addedAt: Date.now(),
    upvotes: 0,
    votedUsers: []
  };

  room.partyQueue.push(queueItem);
  room.addActivity(songUser, 'add', songTitle);
  await roomManager.persistRoom(room);
  room.broadcastUpdate(dynamicPublicUrl);

  // Controlled Proactive Pre-Warm via FIFO queue
  enqueuePrewarm(queueItem.videoId);

  if (!queueItem.songDuration || queueItem.songDuration <= 0) {
    fetchDirectAudioUrl(queueItem.videoId).then(info => {
      const dur = typeof info === 'object' ? info.duration : 0;
      if (dur > 0 && (!queueItem.songDuration || queueItem.songDuration <= 0)) {
        queueItem.songDuration = dur;
        roomManager.persistRoom(room);
        room.broadcastUpdate(dynamicPublicUrl);
      }
    }).catch(() => {});
  }

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

  const room = req.room;
  if (index >= 0 && index < room.partyQueue.length) {
    const removed = room.partyQueue.splice(index, 1)[0];
    await roomManager.persistRoom(room);
    room.addActivity(user, 'remove', title || removed?.title || 'a song');
    room.broadcastUpdate(dynamicPublicUrl);
    setTimeout(() => prewarmUpcomingTracks(room), 500);
    return res.json({ success: true, removedIndex: index });
  }

  res.status(400).json({ error: 'Index out of bounds' });
});

// Bulk Delete Queue Items with Checklist
app.post('/api/queue/delete-bulk', async (req, res) => {
  const { indices, videoIds, user } = req.body || {};
  let removedCount = 0;
  const room = req.room;
  const targetQueue = room ? room.partyQueue : partyQueue;

  if (Array.isArray(indices) && indices.length > 0) {
    const sorted = [...new Set(indices)].map(Number).filter(n => !isNaN(n)).sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx >= 0 && idx < targetQueue.length) {
        targetQueue.splice(idx, 1);
        removedCount++;
      }
    }
  } else if (Array.isArray(videoIds) && videoIds.length > 0) {
    const idSet = new Set(videoIds);
    const initialLen = targetQueue.length;
    const filtered = targetQueue.filter(item => !idSet.has(item.videoId));
    removedCount = initialLen - filtered.length;
    if (room) room.partyQueue = filtered;
    else partyQueue = filtered;
  }

  if (removedCount > 0) {
    if (room) {
      await roomManager.persistRoom(room);
      room.addActivity(user || 'Host', 'remove', `menghapus ${removedCount} lagu sekaligus dari antrean`);
      room.broadcastUpdate(dynamicPublicUrl);
      setTimeout(() => prewarmUpcomingTracks(room), 500);
    } else {
      persistPartyQueue();
      addActivity(user || 'Host', 'remove', `menghapus ${removedCount} lagu sekaligus dari antrean`);
      broadcastUpdate();
      setTimeout(prewarmUpcomingTracks, 500);
    }
  }

  res.json({ success: true, count: removedCount });
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

  const room = req.room;
  let targetQueue = room ? room.partyQueue : partyQueue;

  if (room && (fromIndex >= targetQueue.length || toIndex >= targetQueue.length)) {
    await roomManager.getOrHydrateRoom(req.roomId, null, null, true);
    targetQueue = room.partyQueue;
  }

  if (fromIndex >= 0 && fromIndex < targetQueue.length && toIndex >= 0 && toIndex < targetQueue.length) {
    const [movedItem] = targetQueue.splice(fromIndex, 1);
    targetQueue.splice(toIndex, 0, movedItem);
    if (room) {
      await roomManager.persistRoom(room);
      room.addActivity(user, 'move', `dragged "${title || movedItem.title || 'song'}" to #${targetPosition || (toIndex + 1)}`);
      room.broadcastUpdate(dynamicPublicUrl);
    } else {
      persistPartyQueue();
      addActivity(user, 'move', `dragged "${title || movedItem.title || 'song'}" to #${targetPosition || (toIndex + 1)}`);
      broadcastUpdate();
    }
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

  const room = req.room;
  let targetQueue = room ? room.partyQueue : partyQueue;
  let item = targetQueue.find(q => q.videoId === videoId);

  if (!item && room) {
    await roomManager.getOrHydrateRoom(req.roomId, null, null, true);
    targetQueue = room.partyQueue;
    item = targetQueue.find(q => q.videoId === videoId);
  }

  if (!item) return res.status(404).json({ error: 'Song not found in queue' });

  if (!Array.isArray(item.votedUsers)) item.votedUsers = [];
  const idx = item.votedUsers.indexOf(user);
  let hasVoted = false;
  if (idx !== -1) {
    item.votedUsers.splice(idx, 1);
    hasVoted = false;
    if (room) room.addActivity(user, 'unvote', title || item.title || 'a song');
    else addActivity(user, 'unvote', title || item.title || 'a song');
  } else {
    item.votedUsers.push(user);
    hasVoted = true;
    if (room) room.addActivity(user, 'upvote', title || item.title || 'a song');
    else addActivity(user, 'upvote', title || item.title || 'a song');
  }

  item.upvotes = item.votedUsers.length;
  targetQueue.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
  if (room) {
    await roomManager.persistRoom(room);
    room.broadcastUpdate(dynamicPublicUrl);
  } else {
    persistPartyQueue();
    broadcastUpdate();
  }
  res.json({ success: true, votes: item.upvotes, hasVoted });
});

// 7. Playback Controls
app.post('/api/control/toggle', async (req, res) => {
  const { user, elapsed } = req.body || {};

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

  const room = req.room;
  if (!room.currentSong.videoId) return res.json({ success: false, error: 'No song loaded' });

  const now = Date.now();
  if (typeof elapsed === 'number' && elapsed >= 0) {
    room.playbackTracker.elapsed = elapsed;
    room.currentSong.elapsedSeconds = elapsed;
  } else if (!room.playbackTracker.isPaused) {
    const delta = (now - room.playbackTracker.lastUpdated) / 1000;
    const dur = room.playbackTracker.songDuration || room.currentSong.songDuration || 9999;
    room.playbackTracker.elapsed = Math.min((room.playbackTracker.elapsed || 0) + delta, dur);
    room.currentSong.elapsedSeconds = room.playbackTracker.elapsed;
  }

  room.currentSong.isPaused = !room.currentSong.isPaused;
  room.playbackTracker.isPaused = room.currentSong.isPaused;
  room.playbackTracker.lastUpdated = now;
  room.addActivity(user, room.currentSong.isPaused ? 'pause' : 'play', room.currentSong.title);
  await roomManager.persistRoom(room);
  room.broadcastUpdate(dynamicPublicUrl);
  res.json({ success: true, isPaused: room.currentSong.isPaused, elapsed: room.getCalculatedElapsed() });
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

  const skipped = await advanceNextTrack(req.room, user);
  res.json({ success: true, current: skipped });
});

app.post('/api/control/ended', async (req, res) => {
  const { videoId, user } = req.body || {};
  const room = req.room;
  const now = Date.now();
  const isRoomRecent = (now - (room.lastAdvanceTime || 0) < 4000);

  if (isRoomRecent) {
    return res.json({
      success: true,
      current: room.currentSong,
      audioStreamUrl: room.currentSong && room.currentSong.videoId ? `/api/audio/stream/${room.currentSong.videoId}` : null
    });
  }

  // Only advance if the ended report matches the currently active song
  if (videoId && videoId !== room.currentSong.videoId) {
    return res.json({ success: true, current: room.currentSong });
  }

  // Premature Ended Guard: A full track cannot end within 15 seconds of starting
  const trackAgeSec = (now - (room.currentSong.startedAt || now)) / 1000;
  if (trackAgeSec < 15 && room.currentSong.songDuration > 30) {
    console.warn(`[Ended Guard][Room ${room.id}] Rejected premature ended report at ${trackAgeSec.toFixed(1)}s for track "${room.currentSong.title}" (duration: ${room.currentSong.songDuration}s)`);
    return res.json({ success: true, current: room.currentSong });
  }

  const next = await advanceNextTrack(room, user || 'Host Audio Engine');
  return res.json({
    success: true,
    current: next,
    audioStreamUrl: next && next.videoId ? `/api/audio/stream/${next.videoId}` : null
  });
});

let serverVolumeDebounce = null;
let lastVolumeActivityLogTime = 0;

app.post('/api/control/volume', async (req, res) => {
  const { volume, user } = req.body;
  if (typeof volume !== 'number') return res.status(400).json({ error: 'volume number is required' });

  const vol = Math.max(0, Math.min(100, Math.round(volume)));
  currentVolume = vol;
  req.room.currentVolume = vol;
  await roomManager.persistRoom(req.room);

  // Immediate ACK to client with updated volume
  res.json({ success: true, volume: vol });

  // Debounce osascript system volume and SSE broadcast to prevent event-loop freezing and desync jitter
  clearTimeout(serverVolumeDebounce);
  serverVolumeDebounce = setTimeout(async () => {
    await setSystemVolume(vol);

    if (isUsingYtmDesktop()) {
      fetch(`${YTM_API}/api/v1/volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volume: vol })
      }).catch(() => {});
    }

    const now = Date.now();
    if (now - lastVolumeActivityLogTime > 3000) {
      lastVolumeActivityLogTime = now;
      addActivity(user, 'volume', `set volume to ${vol}%`);
    }
    req.room.broadcastUpdate(dynamicPublicUrl);
  }, 120);
});

app.post('/api/player/sync', async (req, res) => {
  const { videoId, elapsed, duration, token } = req.body || {};
  const room = req.room;
  if (room.partyHost.name && room.partyHost.token && token && token !== room.partyHost.token) {
    return res.status(403).json({ error: 'Stale host session ignored' });
  }
  if (videoId && room.currentSong.videoId === videoId) {
    if (typeof elapsed === 'number' && elapsed >= 0) {
      const trackAgeSec = (Date.now() - (room.currentSong.startedAt || Date.now())) / 1000;
      // Stale track guard: only reject if track started less than 3s ago and elapsed reported is > 10s
      if (trackAgeSec < 3 && elapsed > 10) {
        return res.json({ success: true, rejected: 'stale_track_elapsed' });
      }
      room.playbackTracker.elapsed = elapsed;
      room.currentSong.elapsedSeconds = elapsed;
      // Calibrate startedAt so all serverless instances compute wall-clock elapsed accurately
      room.currentSong.startedAt = Date.now() - Math.round(elapsed * 1000);
      room.playbackTracker.lastUpdated = Date.now();
    }
    if (typeof duration === 'number' && duration > 0) {
      room.currentSong.songDuration = duration;
      room.playbackTracker.songDuration = duration;
    }
    // Throttle remote database persist to at most once every 10s to avoid high write traffic
    if (!room._lastSyncPersist || (Date.now() - room._lastSyncPersist > 10000)) {
      room._lastSyncPersist = Date.now();
      await roomManager.persistRoom(room);
    }
  }
  res.json({ success: true });
});

// --- NATIVE AUDIO STREAMING (FOR 100% BACKGROUND PLAYBACK ON IOS SAFARI & ANDROID) ---
const directAudioCache = new Map();
const inFlightDirectAudio = new Map();

function findYtDlpBinary() {
  const localBin = path.join(__dirname, 'bin', 'yt-dlp');
  if (fs.existsSync(localBin)) return localBin;
  const brewBin = '/opt/homebrew/bin/yt-dlp';
  if (fs.existsSync(brewBin)) return brewBin;
  return 'yt-dlp';
}

function extractDurationFromGoogleUrl(url) {
  try {
    const parsed = new URL(url);
    const durParam = parsed.searchParams.get('dur');
    if (durParam) {
      const durSec = Math.round(parseFloat(durParam));
      if (durSec > 0) return durSec;
    }
  } catch (e) {}
  return 0;
}

function fetchDirectAudioUrl(videoId, forceFresh = false) {
  if (!forceFresh) {
    const cached = directAudioCache.get(videoId);
    if (cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached);
    }
    // Deduplicate concurrent in-flight requests for the exact same track
    if (inFlightDirectAudio.has(videoId)) {
      return inFlightDirectAudio.get(videoId);
    }
  }

  const p = new Promise((resolve, reject) => {
    const ytdlBin = findYtDlpBinary();
    execFile(ytdlBin, [
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:player_client=visionos',
      '-g',
      '-f', 'ba[ext=m4a]/ba',
      '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`
    ], { timeout: 45000 }, (err, stdout, stderr) => {
      inFlightDirectAudio.delete(videoId);
      if (err) {
        console.error('yt-dlp error fetching audio URL:', err.message);
        return reject(err);
      }
      const rawUrl = stdout.trim().split('\n')[0];
      if (!rawUrl || !rawUrl.startsWith('http')) {
        return reject(new Error('Invalid audio stream URL returned by yt-dlp'));
      }
      const duration = extractDurationFromGoogleUrl(rawUrl);
      const entry = {
        videoId,
        url: rawUrl,
        duration,
        expiresAt: Date.now() + (45 * 60 * 1000) // 45m cache TTL to prevent 403 CDN token expirations
      };
      directAudioCache.set(videoId, entry);
      resolve(entry);
    });
  });

  inFlightDirectAudio.set(videoId, p);
  return p;
}

// Background Pre-Warming FIFO Queue with Strict Concurrency = 1
// Ensures speculative hover pre-warming NEVER floods the CPU or starves live audio playback!
const prewarmQueue = [];
let isPrewarmWorkerActive = false;
const MAX_PREWARM_QUEUE = 3;

function enqueuePrewarm(videoId) {
  if (!videoId || typeof videoId !== 'string') return;
  const cleanId = videoId.trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(cleanId)) return;
  if (directAudioCache.has(cleanId) || inFlightDirectAudio.has(cleanId)) return;
  if (prewarmQueue.includes(cleanId)) return;

  // Drop older speculative items to keep queue small and responsive
  if (prewarmQueue.length >= MAX_PREWARM_QUEUE) {
    prewarmQueue.shift();
  }
  prewarmQueue.push(cleanId);
  processNextPrewarm();
}

async function processNextPrewarm() {
  if (isPrewarmWorkerActive || prewarmQueue.length === 0) return;
  isPrewarmWorkerActive = true;
  const nextVideoId = prewarmQueue.shift();

  try {
    if (!directAudioCache.has(nextVideoId)) {
      console.log(`[PreWarm Worker] Resolving stream for: ${nextVideoId}...`);
      await fetchDirectAudioUrl(nextVideoId);
    }
  } catch (e) {
    // Ignore pre-warm failures silently
  } finally {
    isPrewarmWorkerActive = false;
    // Small delay between pre-warm jobs to guarantee CPU stays idle for other tasks
    setTimeout(processNextPrewarm, 200);
  }
}

// Background Proactive Audio Stream Pre-Warming for Upcoming Tracks
async function prewarmUpcomingTracks(room = null) {
  const targetRoom = room || roomManager.getRoom('main');
  if (!targetRoom || targetRoom.partyQueue.length === 0) return;
  const nextItem = targetRoom.partyQueue[0];
  
  if (nextItem && nextItem.videoId && !directAudioCache.has(nextItem.videoId)) {
    enqueuePrewarm(nextItem.videoId);
  }
  if (targetRoom.partyQueue.length > 1) {
    const nextItem2 = targetRoom.partyQueue[1];
    if (nextItem2 && nextItem2.videoId && !directAudioCache.has(nextItem2.videoId)) {
      enqueuePrewarm(nextItem2.videoId);
    }
  }
}
setInterval(prewarmUpcomingTracks, 25000);

// Fast Pre-warm Endpoint (Triggered on search/recommendation hover or click)
app.post('/api/audio/prewarm/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    const isAlreadyCached = directAudioCache.has(videoId);
    if (!isAlreadyCached) {
      enqueuePrewarm(videoId);
    }
    return res.json({ success: true, videoId, cached: isAlreadyCached });
  }
  res.status(400).json({ error: 'Invalid videoId' });
});

app.get('/api/audio/stream/:videoId', async (req, res) => {
  if (IS_VERCEL) {
    return res.status(404).json({ error: 'Audio stream proxy is disabled in Vercel serverless mode. Please use YouTube Web Player.' });
  }
  const { videoId } = req.params;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid videoId');
  }

  const pipeStreamFromUrl = (audioUrl, durSec, isRetry = false) => {
    try {
      const parsedUrl = new URL(audioUrl);
      const rangeHeader = req.headers.range;
      const reqHeaders = {};
      if (rangeHeader) {
        reqHeaders['Range'] = rangeHeader;
      }

      const proxyReq = https.request({
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: reqHeaders
      }, (proxyRes) => {
        const statusCode = proxyRes.statusCode || 200;

        // Redirect Handling (e.g. Google CDN moves audio stream to a regional cache server)
        if ([301, 302, 303, 307, 308].includes(statusCode) && proxyRes.headers.location) {
          console.log(`[AudioStream] Google CDN redirected (${statusCode}) for ${videoId}. Following location...`);
          proxyRes.resume();
          return pipeStreamFromUrl(proxyRes.headers.location, durSec, isRetry);
        }

        // Auto-Recovery: If Google CDN returns any non-success status (302 without location, 403, 404, 410, 500), invalidate cache and fetch fresh URL
        if (statusCode !== 200 && statusCode !== 206 && !isRetry) {
          console.warn(`[AudioStream] Google CDN returned non-success ${statusCode} for ${videoId}. Invalidating cache and retrying with fresh direct URL...`);
          directAudioCache.delete(videoId);
          proxyRes.resume();

          fetchDirectAudioUrl(videoId, true /* forceFresh */)
            .then(freshInfo => {
              const freshUrl = typeof freshInfo === 'object' && freshInfo.url ? freshInfo.url : freshInfo;
              const freshDur = typeof freshInfo === 'object' && freshInfo.duration ? freshInfo.duration : durSec;
              pipeStreamFromUrl(freshUrl, freshDur, true /* isRetry */);
            })
            .catch(err => {
              console.error(`[AudioStream] Retry failed for ${videoId}:`, err.message);
              if (!res.headersSent) res.status(502).send('Audio stream error');
            });
          return;
        }

        const resHeaders = {
          'Content-Type': proxyRes.headers['content-type'] || 'audio/mp4',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*'
        };

        if (proxyRes.headers['content-range']) {
          resHeaders['Content-Range'] = proxyRes.headers['content-range'];
        }
        if (proxyRes.headers['content-length']) {
          resHeaders['Content-Length'] = proxyRes.headers['content-length'];
        }

        res.writeHead(statusCode, resHeaders);
        if (req.method === 'HEAD') {
          return res.end();
        }
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('Audio stream proxy error:', err.message);
        if (!res.headersSent) {
          res.status(502).send('Audio stream proxy error');
        }
      });

      req.on('close', () => {
        proxyReq.destroy();
      });

      proxyReq.end();
    } catch (e) {
      console.error('Pipe stream error:', e.message);
      if (!res.headersSent) res.status(500).send('Internal stream error');
    }
  };

  try {
    const isClientRetry = Boolean(req.query.retry) || req.headers['cache-control'] === 'no-cache';
    if (isClientRetry) {
      console.log(`[AudioStream] Client requested fresh stream (retry=${req.query.retry}) for ${videoId}. Invalidating cache...`);
      directAudioCache.delete(videoId);
    }

    const audioInfo = await fetchDirectAudioUrl(videoId, isClientRetry);
    const audioUrl = typeof audioInfo === 'object' && audioInfo.url ? audioInfo.url : audioInfo;
    const durSec = typeof audioInfo === 'object' && audioInfo.duration ? audioInfo.duration : extractDurationFromGoogleUrl(audioUrl);

    if (durSec > 0 && currentSong && currentSong.videoId === videoId && (!currentSong.songDuration || currentSong.songDuration === 0)) {
      currentSong.songDuration = durSec;
      playbackTracker.songDuration = durSec;
      persistPartyQueue();
      setTimeout(broadcastUpdate, 50);
    }

    pipeStreamFromUrl(audioUrl, durSec, false);
  } catch (err) {
    console.error('Failed to resolve audio stream for', videoId, ':', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not resolve audio stream' });
    }
  }
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
  res.json({ history: req.room.playedHistory });
});

// 10. Server-Sent Events (Resilient Real-Time Protocol with Active Cloudflare Heartbeat)
const clients = new Set();

async function getFullSsePayload() {
  const [liveCurrent, { queue, selectedIndex }] = await Promise.all([
    getUnifiedCurrentSong(),
    getUnifiedQueue()
  ]);

  const activePublicUrl = dynamicPublicUrl || (process.env.PUBLIC_URL || (process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'https://dj.wsnsam.my.id' : null));

  return `data: ${JSON.stringify({
    current: {
      ...liveCurrent,
      currentElapsed: getCalculatedElapsed(),
      isPaused: playbackTracker.isPaused,
      isAudioCached: directAudioCache.has(liveCurrent?.videoId || '')
    },
    cachedTrackIds: Array.from(directAudioCache.keys()),
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
    djProfiles: Object.fromEntries(djProfiles),
    isRoomSleeping,
    volume: { state: currentVolume, isMuted },
    activity: activityLogs.slice(0, 30),
    history: playedHistory.slice(0, 30)
  })}\n\n`;
}

app.get('/api/events', async (req, res) => {
  // Required SSE headers: no-transform is critical for Cloudflare to prevent buffering/compressing chunks
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const room = req.room;
  room.clients.add(res);
  room.touch();

  // Send immediate connected ping
  res.write(': connected\n\n');

  // Immediately push fresh state snapshot to newly connected client
  try {
    const activePublicUrl = dynamicPublicUrl || (process.env.PUBLIC_URL || (process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'https://dj.wsnsam.my.id' : null));
    res.write(room.getFullSsePayload(activePublicUrl));
  } catch (err) {
    console.warn(`[SSE][Room ${room.id}] Error sending initial payload:`, err.message);
  }

  req.on('close', () => room.clients.delete(res));
});

// Periodic SSE Keep-Alive Ping every 15s across all rooms
setInterval(() => {
  for (const r of roomManager.getAllRooms()) {
    r.sendPing();
  }
}, 15000);

// Auto-cleanup idle rooms every 60s
setInterval(() => {
  roomManager.cleanIdleRooms();
}, 60000);

async function broadcastUpdate(room = null) {
  const activePublicUrl = dynamicPublicUrl || (process.env.PUBLIC_URL || (process.env.CLOUDFLARE_TUNNEL_TOKEN ? 'https://dj.wsnsam.my.id' : null));
  if (room && room.id) {
    room.broadcastUpdate(activePublicUrl);
    return;
  }
  for (const r of roomManager.getAllRooms()) {
    r.broadcastUpdate(activePublicUrl);
  }
}

// Background periodic cleanup / sync
setInterval(() => {
  for (const r of roomManager.getAllRooms()) {
    r.checkHostVacant();
  }
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

if (require.main === module) {
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
}

module.exports = app;
