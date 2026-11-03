# Changelog

All notable changes to the **Party Jukebox** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
