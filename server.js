const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const YTM_API = 'http://localhost:26538';
const YTM_WS = 'ws://localhost:26538/api/v1/ws';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory social tracking for queued tracks: videoId -> { user, addedAt, title, artist, thumbnail }
const socialQueue = new Map();
// Upvotes: videoId -> Set of users who voted
const upvotes = new Map();
// Activity Feed / History Log: Array of { id, user, action, details, timestamp }
const activityLogs = [];

let currentVolume = 70;
let isMuted = false;

// Mac OS System Volume Control (Guarantees real speaker volume changes!)
function getSystemVolume() {
  return new Promise((resolve) => {
    exec('osascript -e "output volume of (get volume settings)"', (err, stdout) => {
      if (err) return resolve(currentVolume);
      const v = parseInt(stdout.trim(), 10);
      resolve(isNaN(v) ? currentVolume : v);
    });
  });
}

function setSystemVolume(vol) {
  return new Promise((resolve) => {
    exec(`osascript -e "set volume output volume ${vol}"`, (err) => {
      resolve(!err);
    });
  });
}

function addActivity(user, action, details) {
  const item = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    user: user || 'Someone',
    action, // 'add' | 'skip' | 'pause' | 'play' | 'remove' | 'move' | 'upvote' | 'unvote' | 'volume'
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
      addedBy: socialQueue.get(song.videoId)?.user || 'Autoplay / Sam'
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
              addedBy: socialQueue.get(msg.song.videoId)?.user || 'Autoplay / Sam'
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

// --- API ROUTES ---

// 1. Status (Now Playing + Queue + Volume + Activity Feed)
app.get('/api/status', async (req, res) => {
  const [freshSong, { queue, selectedIndex }, sysVol] = await Promise.all([
    fetchCurrentSongFromYTM(),
    getQueueData(),
    getSystemVolume()
  ]);

  if (freshSong) {
    liveSong = freshSong;
    updatePlaybackTracker(freshSong);
  }
  currentVolume = sysVol;

  res.json({
    online: liveSong.videoId !== '',
    current: {
      ...liveSong,
      currentElapsed: getCalculatedElapsed(),
      isPaused: playbackTracker.isPaused
    },
    queue,
    selectedIndex,
    volume: { state: currentVolume, isMuted },
    activity: activityLogs.slice(0, 30)
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

// 3. Add to Queue
app.post('/api/queue', async (req, res) => {
  const { input, user, title, artist, thumbnail } = req.body;
  const videoId = extractVideoId(input);

  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube link or song ID' });
  }

  try {
    const queueRes = await fetch(`${YTM_API}/api/v1/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        insertPosition: 'INSERT_AT_END'
      })
    });

    if (!queueRes.ok && queueRes.status !== 204) {
      return res.status(500).json({ error: 'Failed to queue song on desktop app' });
    }

    const songTitle = title || 'Song';
    socialQueue.set(videoId, {
      user: user || 'Anonymous',
      addedAt: Date.now(),
      title: songTitle,
      artist: artist || '',
      thumbnail: thumbnail || ''
    });

    addActivity(user, 'add', songTitle);
    broadcastUpdate();

    res.json({
      success: true,
      videoId,
      user: user || 'Anonymous'
    });
  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: 'Failed to connect to YouTube Music Desktop' });
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
    playbackTracker.lastUpdated = Date.now();
    liveSong.isPaused = playbackTracker.isPaused;

    addActivity(user, liveSong.isPaused ? 'pause' : 'play', liveSong.title);
    broadcastUpdate();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Control error' });
  }
});

app.post('/api/control/next', async (req, res) => {
  const { user } = req.body;
  try {
    const skippedTitle = liveSong.title;
    await fetch(`${YTM_API}/api/v1/next`, { method: 'POST' });

    addActivity(user, 'skip', skippedTitle);
    setTimeout(syncAndBroadcast, 400);
    res.json({ success: true });
  } catch (e) {
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

// 8. Server-Sent Events (Live real-time updates for all phones)
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
    volume: { state: currentVolume, isMuted },
    activity: activityLogs.slice(0, 30)
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

// Helper to get local IP
function getLocalIp() {
  const interfaces = os.networkInterfaces();
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
