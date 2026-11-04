# Changelog

All notable changes to the **Party Jukebox** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.11.7] - 2026-11-04

### Added
- **Queue Bulk Delete with Checklist Selection:**
  - Added multi-select checklist mode to the upcoming party queue on both Desktop and Mobile views (`☑️ Checklist`).
  - Includes select/deselect individual songs, dynamic count badge (`X dipilih`), "Pilih Semua" (Select All) toggle, cancel button, and batch delete (`🗑️ Hapus (X)`).
  - Backed by atomic reverse-order splice endpoint `POST /api/queue/delete-bulk` preventing index shifting during batch removal.

### Fixed
- **Timeline Reset Bug on Queue Deletion:**
  - Fixed issue where deleting a queue item reset the currently playing song's progress to `0:00`.
  - Host's physical audio hardware (`hostAudio.currentTime`) is now locked as the ground truth; incoming SSE queue mutations can no longer overwrite the playing track's timeline or trigger false seek events.
- **Audio Stream Resolution Delay & Google CDN 403 Auto-Recovery:**
  - Investigated the root cause of the "ad-like" 11-second silence before tracks start: `yt-dlp` direct stream resolution takes 8–11 seconds on demand.
  - Implemented background pre-warming engine (`prewarmUpcomingTracks` in `server.js`) resolving streams for `partyQueue[0]` and `partyQueue[1]` ahead of time, ensuring instantaneous (0ms) track transitions.
  - Added hidden pre-buffering audio element (`#host-prewarm-audio`) on the Host browser to preload initial audio chunks in the background for true gapless playback.
  - Added automatic recovery on Google CDN 403 Forbidden / 404 stream responses: auto-purges stale cache tokens and transparently retries with a fresh direct stream URL.
- **Volume Slider Desync & Debounce:**
  - Added 1500ms interaction lock window (`lastUserVolumeInteraction`) to prevent remote SSE broadcasts from overwriting user volume adjustments.
  - Reduced network calls with 350ms client debounce and 120ms server debounce, while providing instant 0ms local gain response.
- **Instant Track Skip & Next Song Rendering:**
  - Skipping tracks or clicking "Play Now" immediately renders the upcoming track metadata and timeline without waiting for SSE or requiring a page reload.

---

## [2.6.0] - 2026-11-03

### Added
- **Decentralized Multi-Room Host Architecture:**
  - Each party host runs their own private room on their local machine/hotspot without needing centralized server coordination or sharing queues with other hosts.
  - Automatically adapts between Local Wi-Fi / Hotspot tethering (`http://192.168.x.x:3000`) and dynamic public internet.
- **Direct Song Transfer to YouTube Music:**
  - When the Host has YouTube Music running on their PC/Mac, song requests submitted by party guests from their mobile phones are automatically transferred directly into the Host's YouTube Music playback queue (`/api/v1/queue`).
  - Seamlessly mirrors what the Host plays inside YouTube Music with exact live metadata, album art, and duration.
- **Embedded Web Engine Fallback:**
  - If YouTube Music Desktop is not running (e.g. host on a smartphone or tablet), Party Jukebox operates completely standalone using its built-in official YouTube Web Player engine (`YT.Player`).
- **On-Demand Public Quick Tunnel (`*.trycloudflare.com`):**
  - Host can toggle a free, zero-config, secure Cloudflare Quick Tunnel right from the web UI with a single tap (`Buka Link Publik`).
  - QR Code and share link dynamically update so guests on cellular 4G/5G data can join without being on the same Wi-Fi.
- **Direct YouTube Music Catalog Search:**
  - Ingestion and catalog search now query YouTube Music directly via Innertube `WEB_REMIX` context, returning rich results in milliseconds.

---

## [2.5.1] - 2026-11-03

### Fixed
- **Precision Karaoke Lyrics Synchronization:** Advanced cleaner for Chinese/Japanese brackets (`《...》`, `【...】`), OST/MV metadata stripping, LRC `[offset:X]` parsing, ±4s duration verification in database lookups, and tightened 0.4s drift tolerance with 150ms vocal lead.
- **History Re-Queue Mismatch (1-Song Shift Bug):** Eliminated the 1-song shift bug where completed songs were recorded with the subsequent song's title/thumbnail; re-queueing from *Lagu yang Sudah Diputar* now always adds the exact matching track.

---

## [2.5.0] - 2026-11-03

### Added
- **Frozen Bottom Now Playing Player Bar:** Docked persistent player bar fixed at the bottom with synced progress, rotating vinyl disc, play/pause, skip, karaoke trigger, volume slider, and 10% snap button.
- **Universal Track Ingestion:** Fixed song addition errors caused by false-positive rate-limit checks (429/403) and special character titles; added encoded payload decoder for instant queuing of any song.
- **Decoupled Personal Domain:** Decoupled `dj.wsnsam.my.id` to be strictly personal for Sam; party URLs & QR codes now automatically adapt to each host's network/domain.

### Added
- **Auto-Update Version Watchdog with Floating Countdown Banner:**
  - Automatically detects when a newer build or backend server release is deployed.
  - Floating top banner notifies attendees with a 3-second countdown and 1-tap `[Refresh ⚡]` button, then automatically triggers `window.location.reload(true)` to ensure open browser sessions never stay stuck on outdated code.
- **Cache-Busting HTTP Headers on HTML Assets:**
  - Configured `express.static` with `no-cache, no-store, must-revalidate` specifically for `.html` files, completely preventing mobile browsers (iOS Safari, Android Chrome) from serving stale HTML from disk cache.

---

## [2.4.0] - 2026-11-03

### Added
- **Toggleable 10% Volume Snapping (`[🧲 10%]`):**
  - Added dedicated toggle button next to the volume slider allowing users to toggle between 10% step increments (`0%, 10%, 20%... 100%`) and granular 1% volume adjustment.
  - Automatically calculates closest 10% threshold upon activation.
  - Persists preference locally (`localStorage.jukebox_vol_snap`).
  - Active state visual feedback with neon pink accent highlight and informative toast notifications.

---

## [2.3.2] - 2026-11-03

### Added
- **Strict YouTube & YouTube Music Track Validation Pipeline:**
  - Prevents non-music, private, deleted, or unplayable YouTube videos from ever entering the queue or hanging playback.
  - Pre-validation checks YouTube oEmbed and `music.youtube.com` catalog availability before communicating with the desktop app.
  - Post-queue verification confirms that YouTube Music Desktop actually accepted and placed the video in its electron player queue.
  - Rejection with custom dialog: users entering invalid or unavailable videos receive an instant glassmorphic alert (`customAlert`) explaining why the track cannot be played.
- **Hang & Stalled Playback Auto-Recovery Watchdog:**
  - Detects if YouTube Music player gets stuck/hung on the previous song after playback duration has elapsed.
  - Automatically triggers `POST /api/v1/next` when playback fails to advance for >4s, ensuring uninterrupted party music flow.

---

## [2.3.1] - 2026-11-03

### Added
- **1-Click Multi-Host Portable Launcher (`npm run host`):**
  - Enabled any friend who clones the repository to immediately become the active Party Host with their own laptop and YouTube Music Desktop.
  - Automatically verifies YouTube Music Desktop Companion Server status (`port 26538`).
  - Seamlessly starts the Jukebox server and connects the portable Cloudflare Tunnel token so that `https://dj.wsnsam.my.id` instantly points to whoever is running `npm run host` without changing any DNS or router settings.
- **100% Custom Glassmorphic Dialog System:**
  - Completely eliminated all native browser blocking dialogs (`window.alert`, `window.confirm`, `window.prompt`).
  - Implemented responsive, theme-aware custom dialogs (`customAlert`, `customConfirm`, `customPrompt`) with keyboard shortcuts (`Enter` to submit, `Esc` to cancel), auto-focus, and smooth spring animations.

### Fixed
- **Now Playing Song Request Attribution Lost on Reload:**
  - Resolved issue where refreshing the browser caused the `by [Requester]` pill on Now Playing to disappear or revert to `Autoplay / Host`.
  - Added JSON disk persistence (`data/social_queue.json` & `data/played_history.json`) so server restarts never wipe social attribution.
  - Upgraded server attribution resolver (`resolveAddedBy`) to cross-reference video IDs, queue arrays, and exact track titles.
  - Added frontend `localStorage` requester cache fallback so attribution renders instantly even during reloads.

---

## [2.3.0] - 2026-11-03

### Added
- **Auto-Vacant Party Host Architecture:**
  - Resolved role confusion between Party Host (room master controller) and Guest Requesters.
  - The Party Host badge is now strictly **read-only** for normal guests (`👑 Host Party: [Name]`).
  - Guests manage their own personal requester profile independently (`👤 Kamu: [Nickname] ✏️`).
  - **Auto-Vacant Lifecycle:**
    - Host device transmits background heartbeat every 15s (`POST /api/host/heartbeat`).
    - If the Host closes their browser or disconnects for >60s, server automatically sets status to **VACANT** (`⚠️ Host Vacant`).
    - Any attendee can immediately claim Host via `[👑 Klaim Jadi Host]` or voluntarily release host ownership (`[🔓 Lepas Host]`).
    - New endpoints: `GET /api/host`, `POST /api/host/claim`, `POST /api/host/release`, and `POST /api/host/heartbeat`.
- **Interactive Reactive Category Recommendation Chips:**
  - Fixed category recommendation chips not visually updating when pressed.
  - Tapping any chip immediately applies high-contrast vibrant gradient highlighting, active shadow, and subtle scale transform.
  - Dynamic results counter banner displays above search results with quick `✕ Reset` button.
  - 1-tap toggle-off: tapping the currently active category deselects it and reverts to default recommendations.
- **Cloudflare Tunnel Deployment:**
  - Permanent public SSL endpoint deployed at `https://dj.wsnsam.my.id`.
  - Background daemon configured via macOS LaunchAgent (`~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`).

---

## [2.2.0] - 2026-11-03

### Added
- **Dynamic DJ Profiles & Custom Name Entry:**
  - Removed all 4 static hardcoded DJ profiles (Leo, Andrew, Cia, Sam).
  - Any party guest can now enter their own custom DJ name or nickname upon joining.
  - New server-side dynamic DJ registry with `POST /api/dj/join` tracking active party participants across all connected devices.
  - Included active party DJs list (`djs: []`) in `GET /api/status` for real-time guest sync.
- **Mandatory First-Time Onboarding Modal:**
  - Guests opening the app without cached credentials are automatically prompted with a blocking, welcoming DJ setup modal.
  - Prevents anonymous requests and ensures attribution for every added song and upvote.
  - Allows quick 1-tap selection if other party profiles are already active.
- **Deterministic 9-Color DJ Palette:**
  - Automatically generates unique, consistent neon/pastel accent colors, avatar dots, and badge styles for any arbitrary DJ name across all views.
- **Dynamic DJ Header Bar & Switcher:**
  - Replaced the static button grid with a sleek dynamic DJ bar: active DJ badge with quick-edit trigger, dynamic horizontal pills for other active guests, and a `+ Ganti DJ` modal switcher.

---

## [2.1.0] - 2026-11-03

### Added
- **Mandarin & C-Pop (华语) Ecosystem:**
  - Dedicated `🇨🇳 Mandarin / C-Pop (华语)` and `🇹🇼 Taiwan / C-Pop (台湾)` country filter options.
  - Dedicated `🏮 Mandopop / C-Pop` genre category.
  - Quick mood chips: `🇨🇳 Mandopop Hits`, `🎤 KTV Mandarin`, and `🏮 Classic Mandarin`.
  - Curated party recommendation lists pre-loaded with hits from 周杰伦 (Jay Chou), 林俊杰 (JJ Lin), 邓紫棋 (G.E.M.), 告五人 (Accusefive), 周兴哲 (Eric Chou), and 菲道尔 (Firdhaus).
  - Smart search query generator: selecting Mandarin without typing automatically targets top Mandopop hits rather than language tutorial videos.
- **Modern Glassmorphic Custom Components:**
  - **`CustomSelect`**: Floating glassmorphic dropdowns with country flags, animated chevrons, active checkmarks (`✓`), and click-outside dismissal.
  - **`CustomSearchInput`**: Integrated clear button `✕`, search spinner, and desktop keyboard shortcut `/` or `⌘K`.
  - **`CustomTimeline`**: Spotify-grade glowing playhead dot (`shadow-pink-500/80`), monospace duration timers, and synced status indicator.
  - **`CustomVolumeControl`**: Dynamic speaker emoji reacting to output level (`🔇`, `🔈`, `🔉`, `🔊`), monospace percentage badge, and 1-tap presets (`30%`, `70%`, `100%`).
  - **`CustomHostShare`**: 1-click `📋 Salin Link` button with animated clipboard copy feedback.
  - **`CustomLyricsContainer`**: Apple Music & Spotify-inspired vertical gradient fade mask (`lyrics-fade-mask`).
- **Brand Favicon Suite:**
  - Added vector `public/favicon.svg` with high-contrast squircle gradient and vinyl groove styling.
  - Added multi-resolution `public/favicon.ico` (64x64, 32x32, 16x16) and `public/favicon.png` for all mobile and desktop browsers.
- **In-App Version & Changelog Modal:**
  - Clickable version pill in the header opening the full release notes modal directly within the app.

### Fixed
- **Window Auto-Scroll Isolation:**
  - Removed all global `scrollIntoView()` calls across the codebase that previously caused unexpected outer page viewport jumps when song lyric lines advanced.
  - Constrained lyric scrolling strictly inside the fullscreen lyrics modal (`modalContainer.scrollTo()`) only when `isLyricsOpen === true`.
- **Manual Refresh Reliability:**
  - Enhanced top-right refresh button with visual spinning feedback (`animate-spin`), minimum 450ms tactile duration, and instant toast notification.
  - Added cache-busting timestamp (`_t=${Date.now()}`) and strict `no-store` headers to `/api/status` preventing stale browser caching.
  - Added automatic Server-Sent Events (SSE) health verification and reconnection on manual refresh.

---

## [2.0.0] - 2026-11-03

### Added
- **Widescreen Desktop 2-Column Dashboard:**
  - Multi-column layout optimized for iPads, Macs, and 4K displays.
  - **Left Column:** Expanded Now Playing card, embedded real-time karaoke lyrics panel, and host Wi-Fi QR code card.
  - **Right Column:** YouTube Music search, Country & Genre filters, draggable upcoming queue, and room activity feed.
- **View Modes Switcher:**
  - Segmented control toggle with three distinct view modes:
    - `⚡ Auto`: Automatically switches between mobile phone view and widescreen dashboard based on viewport width (breakpoint: 1024px).
    - `📱 Mobile`: Forces single-column phone view on any display.
    - `💻 Desktop`: Forces 2-column widescreen dashboard layout.
  - Persisted user preference in `localStorage` (`jukebox_view`).
- **System Theme Matching Engine:**
  - Dynamic `window.matchMedia('(prefers-color-scheme: dark)')` integration that synchronizes theme with macOS / iOS / Android day/night schedules.
  - Segmented control toggle supporting `🌓 System`, `☀️ Light`, and `🌙 Dark` modes.
  - Tailored color palette for Apple-style frosted light glassmorphism and cyberpunk neon dark ambiance.
  - Persisted user preference in `localStorage` (`jukebox_theme`).

---

## [1.2.0] - 2026-11-03

### Added
- **Real-Time Karaoke Lyrics Synchronization:**
  - Integration with LRCLib API providing syllable- and line-accurate synchronized LRC lyrics with real-time glow highlights.
  - Graceful fallback to plain lyrics when time-synced data is unavailable.
- **YouTube COPPA "Made for Kids" Auto-Resume Watchdog:**
  - Background server watchdog detecting unexpected pauses caused by YouTube's miniplayer COPPA policy on anime and children's songs.
  - Automatically dispatches `POST /api/v1/play` to resume playback without host manual intervention.
- **Up Next Preview Card & Autoplay Queue Differentiation:**
  - Dedicated Up Next banner previewing the very next upcoming track with 1-tap `Play Now ⏭️` button.
  - Visual badges distinguishing crowd requests (`by [User]`) from YouTube's auto-generated queue (`✨ Autoplay YouTube`).
- **Music Search Filters & Curated Party Recommendations:**
  - Country and Genre filter dropdowns.
  - Horizontal scrollable quick mood chips (`Indo Hits`, `K-Pop`, `Anime Hits`, `Top Global`, `Party EDM`, `Acoustic Chill`, `Classic Rock`).
  - Pre-loaded curated party recommendations displayed when search query is empty.

---

## [1.1.0] - 2026-11-03

### Added
- **Drag-and-Drop Queue Reordering:**
  - Integrated SortableJS for intuitive touch-and-drag queue reorganization via handle (`⠿`).
  - Implemented server-side `PATCH /api/queue/move` with dynamic YouTube Music queue synchronization.
- **Crowd Upvote Priority System:**
  - Guest upvote button (`🔥`) dynamically bubbling songs up the playlist order.
- **Master Physical Speaker Volume Control:**
  - Synchronized volume slider directly controlling the host computer's master audio output via `osascript`.
- **Previously Played History List:**
  - Dedicated tab displaying finished songs with 1-tap re-queue button (`+ Putar Lagi`).
- **Monotonic Playback Timeline Tracker:**
  - Replaced unreliable client time tracking with server-side monotonic drift calibration and 200ms smooth client interpolation ticker.

---

## [1.0.0] - 2026-11-03

### Added
- Initial public release of **Party Jukebox**.
- Real-time communication via Server-Sent Events (SSE) and YouTube Music Desktop API Server plugin (`localhost:26538`).
- Zero-friction guest onboarding with terminal QR code generation and local Wi-Fi URL.
- YouTube search and direct URL link pasting support.
- Attribution tracking by DJ profile (Leo, Andrew, Cia, Sam).
- Live room activity feed ("Who did what").
