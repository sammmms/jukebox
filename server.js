const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const YTM_API = 'http://localhost:26538';
const YTM_WS = 'ws://localhost:26538/api/v1/ws';

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

// Persisted Data Storage (data/social_queue.json & data/played_history.json)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
const SOCIAL_QUEUE_FILE = path.join(DATA_DIR, 'social_queue.json');
const PLAYED_HISTORY_FILE = path.join(DATA_DIR, 'played_history.json');

// In-memory social tracking for queued tracks: videoId -> { user, addedAt, title, artist, thumbnail }
const socialQueue = new Map();
// Upvotes: videoId -> Set of users who voted
const upvotes = new Map();
// Activity Feed / History Log: Array of { id, user, action, details, timestamp }
const activityLogs = [];
// Dynamic DJ Profiles Registry: Set of all active/known party DJs
const knownDJs = new Set();
// Previously Played Songs History
const playedHistory = [];
// In-memory lyrics cache
const lyricsCache = new Map();

// Load persisted social queue & history on boot
try {
  if (fs.existsSync(SOCIAL_QUEUE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SOCIAL_QUEUE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      socialQueue.set(k, v);
      if (v && v.user) knownDJs.add(v.user);
    }
  }
} catch (e) {
  console.warn('Could not load persisted social queue:', e.message);
}

try {
  if (fs.existsSync(PLAYED_HISTORY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PLAYED_HISTORY_FILE, 'utf8'));
    if (Array.isArray(raw)) playedHistory.push(...raw.slice(0, 60));
  }
} catch (e) {
  console.warn('Could not load persisted history:', e.message);
}

function persistSocialQueue() {
  try {
    const obj = {};
    for (const [k, v] of socialQueue.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(SOCIAL_QUEUE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

function persistPlayedHistory() {
  try {
    fs.writeFileSync(PLAYED_HISTORY_FILE, JSON.stringify(playedHistory.slice(0, 60), null, 2));
  } catch (e) {}
}

// --- AUTO-VACANT PARTY HOST MANAGEMENT (v2.3.0) ---
const HOST_VACANT_TIMEOUT_MS = 60 * 1000; // 60s without heartbeat -> Auto-Vacant
let partyHost = {
  name: null,          // e.g. "DJ Sam" or null (Vacant)
  token: null,         // Session token for host device ownership verification
  claimedAt: null,
  lastHeartbeat: null
};

function checkHostVacant() {
  if (partyHost.name) {
    if (Date.now() - partyHost.lastHeartbeat > HOST_VACANT_TIMEOUT_MS) {
      const oldHost = partyHost.name;
      partyHost = { name: null, token: null, claimedAt: null, lastHeartbeat: null };
      addActivity('System', 'vacant', `Host ${oldHost} offline. Status Host sekarang VACANT ⚠️`);
      broadcastUpdate();
      return true;
    }
  }
  return false;
}

// Periodically check for host vacancy every 10 seconds
setInterval(checkHostVacant, 10000);

function getPartyHostInfo() {
  checkHostVacant();
  return {
    name: partyHost.name,
    isVacant: partyHost.name === null,
    claimedAt: partyHost.claimedAt,
    lastHeartbeat: partyHost.lastHeartbeat,
    timeoutMs: HOST_VACANT_TIMEOUT_MS
  };
}

let currentVolume = 70;
let isMuted = false;
let userExplicitlyPaused = false;
let lastAutoResumeTime = 0;

function addPlayedHistory(track) {
  if (!track || !track.title || track.title === 'No song playing') return;
  // If the latest item in history is the same track, avoid duplicate
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
      if (v && v.title && v.title.trim().toLowerCase() === cleanT) {
        return v.user;
      }
    }
  }
  if (liveSong && (liveSong.videoId === videoId || (title && liveSong.title === title)) && liveSong.addedBy && liveSong.addedBy !== 'Autoplay / Host') {
    return liveSong.addedBy;
  }
  if (Array.isArray(queue)) {
    const inQueue = queue.find(q => (videoId && q.videoId === videoId) || (title && q.title === title));
    if (inQueue && inQueue.addedBy) return inQueue.addedBy;
  }
  const inHistory = playedHistory.find(h => (videoId && h.videoId === videoId) || (title && h.title === title));
  if (inHistory && inHistory.addedBy) return inHistory.addedBy;
  return 'Autoplay / Host';
}

// Cross-Platform System Volume Control (Mac OS, Windows, Linux)
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
      exec(`osascript -e "set volume output volume ${vol}"`, (err) => {
        resolve(!err);
      });
    } else if (process.platform === 'linux') {
      exec(`amixer -D pulse sset Master ${vol}% 2>/dev/null || pactl set-sink-volume @DEFAULT_SINK@ ${vol}% 2>/dev/null`, () => {
        resolve(true);
      });
    } else {
      resolve(true);
    }
  });
}

function cleanSongTitle(title) {
  if (!title) return '';
  return title
    .replace(/\(official\s*(video|audio|music\s*video|lyric\s*video)?\)/gi, '')
    .replace(/\[official\s*(video|audio|music\s*video|lyric\s*video)?\]/gi, '')
    .replace(/\((feat|ft)\.?\s+[^)]+\)/gi, '')
    .replace(/\[(feat|ft)\.?\s+[^\]]+\]/gi, '')
    .replace(/\b(feat|ft)\.?\s+.+$/gi, '')
    .replace(/\|.+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLrc(lrcString) {
  if (!lrcString) return [];
  const lines = lrcString.split('\n');
  const result = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10);
      const time = min * 60 + sec + ms / 1000;
      const text = match[4].trim();
      if (text) {
        result.push({ time, text });
      }
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

async function fetchLyrics(title, artist, duration) {
  const cleanTitle = cleanSongTitle(title);
  const cleanArtist = (artist || '').replace(/\s*•.*$/, '').trim();
  const cacheKey = `${cleanTitle.toLowerCase()}---${cleanArtist.toLowerCase()}`;

  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey);
  }

  try {
    const params = new URLSearchParams({
      track_name: cleanTitle,
      artist_name: cleanArtist
    });
    if (duration && duration > 0) {
      params.append('duration', Math.round(duration));
    }

    let res = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
    let data = null;

    if (res.ok) {
      data = await res.json();
    } else {
      const searchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle + ' ' + cleanArtist)}`);
      if (searchRes.ok) {
        const list = await searchRes.json();
        if (Array.isArray(list) && list.length > 0) {
          data = list[0];
        }
      }
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
    console.error('Lyrics error:', err);
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
    action, // 'add' | 'skip' | 'pause' | 'play' | 'remove' | 'move' | 'upvote' | 'unvote' | 'volume' | 'join'
    details: details || '',
    timestamp: Date.now()
  };
  activityLogs.unshift(item);
  if (activityLogs.length > 50) activityLogs.pop();
  return item;
}

addActivity('System', 'start', 'Party Jukebox server active');

// Robust playback timeline tracker (Independent of YTM desktop reporting 0s)
const playbackTracker = {
  videoId: '',
  elapsed: 0,
  lastReportedElapsed: -1,
  isPaused: true,
  songDuration: 0,
  lastUpdated: Date.now()
};

function updatePlaybackTracker(freshSong) {
  if (!freshSong || !freshSong.videoId) return;

  const now = Date.now();
  const duration = freshSong.songDuration || playbackTracker.songDuration || 0;
  playbackTracker.songDuration = duration;

  // 1. New song detected!
  if (freshSong.videoId !== playbackTracker.videoId) {
    if (playbackTracker.videoId && liveSong.title && liveSong.title !== 'No song playing') {
      addPlayedHistory({
        videoId: playbackTracker.videoId,
        title: liveSong.title,
        artist: liveSong.artist,
        thumbnail: liveSong.imageSrc,
        addedBy: liveSong.addedBy
      });
    }
    playbackTracker.videoId = freshSong.videoId;
    playbackTracker.elapsed = (typeof freshSong.elapsedSeconds === 'number' && freshSong.elapsedSeconds > 0)
      ? freshSong.elapsedSeconds
      : 0;
    playbackTracker.lastReportedElapsed = freshSong.elapsedSeconds ?? -1;
    playbackTracker.isPaused = freshSong.isPaused ?? false;
    playbackTracker.lastUpdated = now;
    return;
  }

  // 2. Play/Pause state changed
  if (typeof freshSong.isPaused === 'boolean' && freshSong.isPaused !== playbackTracker.isPaused) {
    // Watchdog for Made for Kids / COPPA auto-pausing:
    // If YouTube paused the song unexpectedly without any user clicking pause, auto-resume!
    if (freshSong.isPaused && !userExplicitlyPaused && freshSong.videoId && now - lastAutoResumeTime > 2000) {
      lastAutoResumeTime = now;
      console.log('⚡ YouTube auto-paused (Made for Kids / Miniplayer restriction). Auto-resuming playback...');
      setTimeout(() => {
        fetch(`${YTM_API}/api/v1/play`, { method: 'POST' }).catch(() => {});
      }, 350);
      return;
    }

    if (!playbackTracker.isPaused) {
      // Was playing, now pausing -> freeze elapsed at current calculated time
      const delta = (now - playbackTracker.lastUpdated) / 1000;
      playbackTracker.elapsed = Math.min(playbackTracker.elapsed + delta, duration || 9999);
    }
    playbackTracker.isPaused = freshSong.isPaused;
    playbackTracker.lastUpdated = now;
    if (typeof freshSong.elapsedSeconds === 'number' && freshSong.elapsedSeconds > 0) {
      playbackTracker.lastReportedElapsed = freshSong.elapsedSeconds;
    }
    return;
  }

  // 3. Genuine Seek detected: YTM reported a new elapsedSeconds that significantly differs from our tracked elapsed
  if (
    typeof freshSong.elapsedSeconds === 'number' &&
    freshSong.elapsedSeconds >= 0 &&
    freshSong.elapsedSeconds !== playbackTracker.lastReportedElapsed
  ) {
    const currentCalc = getCalculatedElapsed();
    const diff = Math.abs(freshSong.elapsedSeconds - currentCalc);

    // If difference is more than 3 seconds, user sought in the app
    if (diff > 3) {
      playbackTracker.elapsed = freshSong.elapsedSeconds;
      playbackTracker.lastUpdated = now;
    }
    playbackTracker.lastReportedElapsed = freshSong.elapsedSeconds;
  }
}

function getCalculatedElapsed() {
  if (playbackTracker.isPaused) {
    return Math.floor(playbackTracker.elapsed);
  }
  const delta = (Date.now() - playbackTracker.lastUpdated) / 1000;
  const total = playbackTracker.elapsed + delta;
  const max = playbackTracker.songDuration > 0 ? playbackTracker.songDuration : 9999;
  return Math.floor(Math.min(total, max));
}

// Hang / Stalled Playback Auto-Recovery Watchdog
let hangDetectionCount = 0;
let lastHangSkipTime = 0;

function checkPlaybackHang(freshSong) {
  if (!freshSong || !freshSong.videoId || userExplicitlyPaused) {
    hangDetectionCount = 0;
    return;
  }

  const now = Date.now();
  const duration = freshSong.songDuration || playbackTracker.songDuration || 0;
  const elapsed = getCalculatedElapsed();

  // If a song has finished (elapsed >= duration + 2s), but player hasn't progressed to next song
  if (duration > 0 && elapsed >= duration + 2 && !playbackTracker.isPaused) {
    hangDetectionCount++;
    if (hangDetectionCount >= 2 && now - lastHangSkipTime > 6000) {
      lastHangSkipTime = now;
      hangDetectionCount = 0;
      console.warn(`⚡ Watchdog: Lagu "${freshSong.title}" selesai (${elapsed}s/${duration}s) tapi tidak berganti otomatis. Memicu next...`);
      fetch(`${YTM_API}/api/v1/next`, { method: 'POST' }).catch(() => {});
    }
  } else {
    hangDetectionCount = 0;
  }
}

// Real-time Song Cache
let liveSong = {
  title: 'No song playing',
  artist: 'Connect YouTube Music',
  album: '',
  imageSrc: '',
  isPaused: true,
  songDuration: 0,
  elapsedSeconds: 0,
  videoId: '',
  addedBy: 'Autoplay / Sam'
};

// Helper to extract video ID from various YouTube URL formats
function extractVideoId(input) {
  if (!input) return null;
  input = input.trim();
  const match = input.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=)|music\.youtube\.com\/watch\?v=)([^#&?]{11})/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  return null;
}

// Validates track validity & availability on YouTube Music
async function validateYouTubeMusicTrack(videoId) {
  if (!videoId || typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId.trim())) {
    return {
      valid: false,
      error: 'Format Video ID YouTube tidak valid (harus 11 karakter).'
    };
  }

  const cleanId = videoId.trim();

  // 1. YouTube oEmbed check: confirms the video exists and is public on YouTube
  let oembedData = null;
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${cleanId}&format=json`, {
      signal: AbortSignal.timeout(3500)
    });
    if (!oembedRes.ok) {
      return {
        valid: false,
        error: 'Lagu/video tidak ditemukan di YouTube, telah dihapus, atau disetel privat.'
      };
    }
    oembedData = await oembedRes.json();
  } catch (err) {
    console.warn(`[ValidateTrack] oEmbed check warning for ${cleanId}:`, err.message);
  }

  // 2. YouTube Music Catalog check: confirms the video is accessible in YouTube Music
  try {
    const ytmRes = await fetch(`https://music.youtube.com/watch?v=${cleanId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(3500)
    });

    if (ytmRes.ok) {
      const html = await ytmRes.text();
      const hasOgTitle = html.includes('property="og:title"');
      const isGenericYTM = html.includes('<title>YouTube Music</title>') && !hasOgTitle;
      const isDeprecatedNotice = html.includes('Browser Anda sudah tidak digunakan lagi') && !hasOgTitle;

      if (isGenericYTM || isDeprecatedNotice) {
        return {
          valid: false,
          error: 'Video ini tidak tersedia di katalog YouTube Music (tidak dapat diputar di aplikasi musik).'
        };
      }
    }
  } catch (err) {
    console.warn(`[ValidateTrack] YTM catalog check warning for ${cleanId}:`, err.message);
  }

  return {
    valid: true,
    title: oembedData?.title || 'Unknown Title',
    artist: oembedData?.author_name || 'YouTube',
    thumbnail: oembedData?.thumbnail_url || `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg`
  };
}

// Fetch currently playing song from YouTube Music Desktop
async function fetchCurrentSongFromYTM() {
  try {
    const res = await fetch(`${YTM_API}/api/v1/song`);
    if (!res.ok) return null;
    const song = await res.json();
    return {
      title: song.title || 'Unknown Title',
      artist: song.artist || 'Unknown Artist',
      album: song.album || '',
      imageSrc: song.imageSrc || '',
      isPaused: song.isPaused ?? true,
      songDuration: song.songDuration || 0,
      elapsedSeconds: song.elapsedSeconds || 0,
      videoId: song.videoId || '',
      addedBy: resolveAddedBy(song.videoId, [], song.title)
    };
  } catch (err) {
    return null;
  }
}

// Connect to YTM WebSocket
function connectYTMWebSocket() {
  try {
    const ws = new WebSocket(YTM_WS);

    ws.onopen = () => {
      console.log('⚡ Connected to YouTube Music WebSocket for instant live events!');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'PLAYER_INFO' || msg.type === 'VIDEO_CHANGED') {
          if (msg.song) {
            const paused = msg.isPlaying ? false : (msg.song.isPaused ?? true);
            liveSong = {
              title: msg.song.title || 'Unknown Title',
              artist: msg.song.artist || 'Unknown Artist',
              album: msg.song.album || '',
              imageSrc: msg.song.imageSrc || '',
              isPaused: paused,
              songDuration: msg.song.songDuration || 0,
              elapsedSeconds: msg.position ?? msg.song.elapsedSeconds ?? 0,
              videoId: msg.song.videoId || '',
              addedBy: resolveAddedBy(msg.song.videoId, [], msg.song.title)
            };
            updatePlaybackTracker(liveSong);
            broadcastUpdate();
          }
        } else if (msg.type === 'PLAYER_STATE_CHANGED') {
          liveSong.isPaused = !msg.isPlaying;
          updatePlaybackTracker(liveSong);
          broadcastUpdate();
        } else if (msg.type === 'POSITION_CHANGED') {
          if (typeof msg.position === 'number' && msg.position > 1) {
            playbackTracker.elapsed = msg.position;
            playbackTracker.lastUpdated = Date.now();
            broadcastUpdate();
          }
        } else if (msg.type === 'VOLUME_CHANGED') {
          if (typeof msg.volume === 'number') currentVolume = msg.volume;
          if (typeof msg.muted === 'boolean') isMuted = msg.muted;
          broadcastUpdate();
        }
      } catch (e) {
        console.error('WS message parse error:', e);
      }
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      setTimeout(connectYTMWebSocket, 3000);
    };
  } catch (err) {
    setTimeout(connectYTMWebSocket, 3000);
  }
}

// Fetch and parse queue from YouTube Music Desktop
async function getQueueData() {
  try {
    const res = await fetch(`${YTM_API}/api/v1/queue`);
    if (!res.ok) return { queue: [], selectedIndex: -1 };
    const data = await res.json();
    const items = data.items || [];

    let selectedIndex = -1;
    const queue = [];

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

    // Fallback: If YTM didn't mark any song as selected, check liveSong.videoId
    if (selectedIndex === -1 && liveSong && liveSong.videoId) {
      const matchIdx = queue.findIndex(q => q.videoId === liveSong.videoId);
      if (matchIdx !== -1) {
        selectedIndex = matchIdx;
        queue[matchIdx].selected = true;
      }
    }

    // Seed previously played songs from queue history if not yet recorded
    if (selectedIndex > 0) {
      for (let i = selectedIndex - 1; i >= 0; i--) {
        const past = queue[i];
        if (past && past.title) {
          const already = playedHistory.some(p => (past.videoId && p.videoId === past.videoId) || p.title === past.title);
          if (!already) {
            playedHistory.push({
              id: 'past-' + past.rawIndex + '-' + (past.videoId || Math.random().toString(36).slice(2, 6)),
              videoId: past.videoId || '',
              title: past.title,
              artist: past.artist || '',
              thumbnail: past.thumbnail || '',
              addedBy: past.addedBy || 'Autoplay / Sam',
              playedAt: Date.now() - (selectedIndex - i) * 180000
            });
          }
        }
      }
    }

    return { queue, selectedIndex };
  } catch (err) {
    return { queue: [], selectedIndex: -1 };
  }
}

// Reorder queue in YouTube Music based on vote counts
async function reorderQueueByVotes() {
  try {
    const { queue, selectedIndex } = await getQueueData();
    if (queue.length <= 1) return;

    const startIndex = selectedIndex >= 0 ? selectedIndex + 1 : 0;
    if (startIndex >= queue.length - 1) return;

    let moved = false;
    for (let i = startIndex + 1; i < queue.length; i++) {
      const currentVotes = queue[i].upvotes;

      let targetIndex = i;
      while (targetIndex > startIndex) {
        const prevVotes = queue[targetIndex - 1].upvotes;
        if (currentVotes > prevVotes) {
          targetIndex--;
        } else {
          break;
        }
      }

      if (targetIndex !== i) {
        await fetch(`${YTM_API}/api/v1/queue/${queue[i].rawIndex}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toIndex: queue[targetIndex].rawIndex })
        });
        moved = true;
        break;
      }
    }

    if (moved) {
      setTimeout(broadcastUpdate, 300);
    }
  } catch (err) {
    console.error('Reorder error:', err);
  }
}

// Search YouTube Music
async function searchYouTubeMusic(query) {
  try {
    const res = await fetch(`${YTM_API}/api/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
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
        const videoId = card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
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
    console.error('Search error:', err);
    return [];
  }
}

const APP_VERSION = '2.4.2';

// --- API ROUTES ---

// 0. Version Endpoint
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, name: 'Party Jukebox' });
});

// 0.1 Host Management Endpoints (Auto-Vacant System v2.3.0)
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

  // Can claim if currently vacant, or if existing token matches, or if forced
  if (partyHost.name === null || partyHost.token === token || force) {
    const prevHost = partyHost.name;
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

  return res.status(409).json({
    error: `Kursi Host sedang dipegang oleh ${partyHost.name}. Tunggu sampai status Vacant atau minta dioperkan.`,
    partyHost: getPartyHostInfo()
  });
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

// 1. Status (Now Playing + Queue + Volume + Activity Feed)
app.get('/api/status', async (req, res) => {
  // Prevent all browser & intermediary proxy caching for real-time fidelity
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const [freshSong, { queue, selectedIndex }, sysVol] = await Promise.all([
    fetchCurrentSongFromYTM(),
    getQueueData(),
    getSystemVolume()
  ]);

  if (freshSong) {
    freshSong.addedBy = resolveAddedBy(freshSong.videoId, queue, freshSong.title);
    liveSong = freshSong;
    updatePlaybackTracker(freshSong);
  }
  currentVolume = sysVol;

  const currentIp = getLocalIp();

  res.json({
    online: liveSong.videoId !== '',
    version: APP_VERSION,
    host: {
      ip: currentIp,
      url: `http://${currentIp}:${PORT}`,
      publicUrl: 'https://dj.wsnsam.my.id'
    },
    current: {
      ...liveSong,
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

// 2. Search
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query is required' });
  }
  const results = await searchYouTubeMusic(query.trim());
  res.json({ results });
});

// 3. Add to Queue (with strict validation & verification against invalid songs)
app.post('/api/queue', async (req, res) => {
  const { input, user, title, artist, thumbnail } = req.body;
  const videoId = extractVideoId(input);

  if (!videoId) {
    return res.status(400).json({ error: 'Format link atau ID YouTube tidak valid.' });
  }

  // 1. Strict Validation: verify existence & catalog availability on YouTube Music
  const validation = await validateYouTubeMusicTrack(videoId);
  if (!validation.valid) {
    return res.status(422).json({ error: validation.error });
  }

  const songTitle = title || validation.title || 'Song';
  const songArtist = artist || validation.artist || '';
  const songThumb = thumbnail || validation.thumbnail || '';

  try {
    // 2. Queue into YouTube Music Desktop Companion
    const queueRes = await fetch(`${YTM_API}/api/v1/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        insertPosition: 'INSERT_AT_END'
      })
    });

    if (!queueRes.ok && queueRes.status !== 204) {
      return res.status(503).json({ error: 'Gagal menghubungi YouTube Music Desktop. Pastikan aplikasi aktif.' });
    }

    // 3. Verification: ensure YouTube Music actually enqueued the track and didn't silently reject it
    await new Promise(r => setTimeout(r, 450));
    const { queue: currentQueue } = await getQueueData();
    const isEnqueued = Array.isArray(currentQueue) && currentQueue.some(item => item.videoId === videoId);

    if (!isEnqueued) {
      return res.status(422).json({
        error: 'YouTube Music Desktop menolak lagu ini (tidak dapat dimasukkan ke antrean pemutaran).'
      });
    }

    // 4. Save to social tracking only upon verified enqueue!
    socialQueue.set(videoId, {
      user: user || 'Anonymous',
      addedAt: Date.now(),
      title: songTitle,
      artist: songArtist,
      thumbnail: songThumb
    });
    persistSocialQueue();

    addActivity(user, 'add', songTitle);
    broadcastUpdate();

    res.json({
      success: true,
      videoId,
      title: songTitle,
      user: user || 'Anonymous'
    });
  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: 'Gagal terhubung ke YouTube Music Desktop' });
  }
});

// 4. Remove from Queue
app.delete('/api/queue/:index', async (req, res) => {
  const index = Number(req.params.index);
  const { user, title } = req.body || {};

  if (isNaN(index)) {
    return res.status(400).json({ error: 'Invalid queue index' });
  }

  try {
    const response = await fetch(`${YTM_API}/api/v1/queue/${index}`, {
      method: 'DELETE'
    });

    if (!response.ok && response.status !== 204) {
      return res.status(500).json({ error: 'Failed to remove song from desktop app' });
    }

    addActivity(user, 'remove', title || 'a song');
    setTimeout(broadcastUpdate, 200);
    res.json({ success: true, removedIndex: index });
  } catch (err) {
    console.error('Delete queue error:', err);
    res.status(500).json({ error: 'Connection error' });
  }
});

// 5. Move / Reorder Queue Item (Drag and Drop)
app.patch('/api/queue/move', async (req, res) => {
  const { fromIndex, toIndex, user, title, targetPosition } = req.body;

  if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
    return res.status(400).json({ error: 'fromIndex and toIndex are required numbers' });
  }

  try {
    const moveRes = await fetch(`${YTM_API}/api/v1/queue/${fromIndex}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toIndex })
    });

    if (!moveRes.ok && moveRes.status !== 204) {
      return res.status(500).json({ error: 'Failed to move song in desktop app' });
    }

    addActivity(user, 'move', `dragged "${title || 'song'}" to #${targetPosition || (toIndex + 1)}`);
    setTimeout(broadcastUpdate, 200);
    res.json({ success: true });
  } catch (err) {
    console.error('Move error:', err);
    res.status(500).json({ error: 'Failed to move song' });
  }
});

// 6. Upvote a Song (And dynamically bump it up!)
app.post('/api/upvote', async (req, res) => {
  const { videoId, user, title } = req.body;
  if (!videoId || !user) {
    return res.status(400).json({ error: 'videoId and user are required' });
  }

  if (!upvotes.has(videoId)) {
    upvotes.set(videoId, new Set());
  }

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

  await reorderQueueByVotes();
  broadcastUpdate();
  res.json({ success: true, votes: votes.size, hasVoted });
});

// 7. Controls (Toggle, Next, Volume) - NO SEEK PER USER REQUEST
app.post('/api/control/toggle', async (req, res) => {
  const { user } = req.body;
  try {
    await fetch(`${YTM_API}/api/v1/toggle-play`, { method: 'POST' });
    playbackTracker.isPaused = !playbackTracker.isPaused;
    userExplicitlyPaused = playbackTracker.isPaused; // Set true if user paused, false if user resumed
    playbackTracker.lastUpdated = Date.now();
    liveSong.isPaused = playbackTracker.isPaused;

    addActivity(user, liveSong.isPaused ? 'pause' : 'play', liveSong.title);
    broadcastUpdate();
    res.json({ success: true, isPaused: liveSong.isPaused });
  } catch (e) {
    res.status(500).json({ error: 'Control error' });
  }
});

app.post('/api/control/next', async (req, res) => {
  const { user } = req.body;
  userExplicitlyPaused = false; // Reset pause state when skipping to next track
  try {
    const skippedTitle = liveSong.title || 'Song';
    const { queue, selectedIndex } = await getQueueData();

    let skipped = false;

    // 1. If there is a next song in the queue, jump to it directly via SET_INDEX
    if (selectedIndex >= 0 && selectedIndex + 1 < queue.length) {
      const targetIndex = queue[selectedIndex + 1].rawIndex;
      const resp = await fetch(`${YTM_API}/api/v1/queue`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: targetIndex })
      });
      if (resp.ok || resp.status === 204) {
        skipped = true;
      }
    }

    // 2. If no next song in queue or index jump didn't succeed, fallback to POST /api/v1/next
    if (!skipped) {
      await fetch(`${YTM_API}/api/v1/next`, { method: 'POST' }).catch(() => {});
    }

    // 3. Reset playbackTracker to immediately reflect transition
    playbackTracker.elapsed = 0;
    playbackTracker.lastReportedElapsed = -1;
    playbackTracker.lastUpdated = Date.now();

    addActivity(user, 'skip', skippedTitle);
    setTimeout(syncAndBroadcast, 500);
    res.json({ success: true, skipped });
  } catch (e) {
    console.error('Skip error:', e);
    res.status(500).json({ error: 'Control error' });
  }
});

// Volume endpoint: controls Mac OS system output volume directly!
app.post('/api/control/volume', async (req, res) => {
  const { volume, user } = req.body;
  if (typeof volume !== 'number') {
    return res.status(400).json({ error: 'volume number is required' });
  }

  const vol = Math.max(0, Math.min(100, Math.round(volume)));
  currentVolume = vol;

  await setSystemVolume(vol);

  fetch(`${YTM_API}/api/v1/volume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: vol })
  }).catch(() => {});

  addActivity(user, 'volume', `set speaker volume to ${vol}%`);
  broadcastUpdate();
  res.json({ success: true, volume: vol });
});

// 8. Lyrics Endpoint (LRCLib API with real-time sync LRC parser)
app.get('/api/lyrics', async (req, res) => {
  const title = req.query.title || liveSong.title;
  const artist = req.query.artist || liveSong.artist;
  const duration = Number(req.query.duration) || liveSong.songDuration;

  if (!title || title === 'No song playing') {
    return res.json({ hasLyrics: false, error: 'Tidak ada lagu yang sedang diputar' });
  }

  const lyrics = await fetchLyrics(title, artist, duration);
  res.json(lyrics);
});

// 9. Played History Endpoint
app.get('/api/history', (req, res) => {
  res.json({ history: playedHistory });
});

// 10. Server-Sent Events (Live real-time updates for all phones)
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

async function syncAndBroadcast() {
  const fresh = await fetchCurrentSongFromYTM();
  if (fresh) {
    liveSong = fresh;
    updatePlaybackTracker(fresh);
    checkPlaybackHang(fresh);
  }
  broadcastUpdate();
}

async function broadcastUpdate() {
  if (clients.size === 0) return;
  const { queue, selectedIndex } = await getQueueData();
  const payload = `data: ${JSON.stringify({
    current: {
      ...liveSong,
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
  })}\n\n`;

  for (const client of clients) {
    try {
      client.write(payload);
    } catch (e) {
      clients.delete(client);
    }
  }
}

// Background sync loop: check HTTP every 2s
setInterval(syncAndBroadcast, 2000);

// Helper to get local IP (Prioritizes Wi-Fi en0/wlan0 over VPN/tun)
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'wlan0', 'eth0']) {
    if (interfaces[name]) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();

// Start WebSocket connection to YTM
connectYTMWebSocket();

// Initial song and volume fetch
fetchCurrentSongFromYTM().then(s => {
  if (s) {
    liveSong = s;
    updatePlaybackTracker(s);
  }
});
getSystemVolume().then(v => {
  currentVolume = v;
});

app.listen(PORT, '0.0.0.0', () => {
  const localUrl = `http://${localIp}:${PORT}`;
  console.log('\n======================================================');
  console.log('🎵  PARTY JUKEBOX (READ-ONLY ACCURATE TIMELINE)!');
  console.log('======================================================');
  console.log(`📡 Local Network URL: ${localUrl}`);
  console.log(`💻 Host URL:          http://localhost:${PORT}`);
  console.log('======================================================');
  console.log('📲 SCAN WITH PHONE TO OPEN:');
  qrcode.generate(localUrl, { small: true });
  console.log('======================================================\n');
});
