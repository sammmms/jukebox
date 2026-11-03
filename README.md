# 🎵 Party Jukebox

> **Collaborative, real-time jukebox web application for house parties & hangouts.**  
> Host your music on a laptop connected to speakers with YouTube Premium (lossless, ad-free), while friends control the queue, vote, read karaoke lyrics, and DJ from their phones—**no app installation and no login required for guests!**

---

## ✨ Features

- 🎧 **Host Once, Stream Anywhere:** 1 Host machine (Mac, Windows, or Linux) plays music to your home speakers or sound system.
- 📱 **Zero Friction for Friends:** Guests simply scan a QR code from the terminal or open the local Wi-Fi URL in Safari / Chrome.
- 🎤 **Real-Time Karaoke Synced Lyrics:** Watch lyrics highlight and scroll smoothly line-by-line in sync with music playback (powered by LRCLib), with clean plain lyrics fallback.
- 📜 **Previously Played History:** See what songs have already played, who queued them, and re-queue any favorite track with 1 tap (`+ Putar Lagi`).
- 🗳️ **Crowd Upvote System:** Guests upvote queued songs (`🔥`); songs with the most votes dynamically bubble up to play next.
- ⠿ **Drag-and-Drop Queue Reordering:** DJ can reorder upcoming tracks on mobile using intuitive grab handles (`⠿`).
- 🗑️ **Queue Management:** Remove unwanted requests with the delete button (`🗑️`).
- ⏱️ **Read-Only Monotonic Timeline:** Live progress bar with steady second-by-second countdown. Read-only to prevent guests from seeking or interrupting audio.
- 🔊 **Master Speaker Volume Control:** Directly controls the host computer's master speaker output.
- 👥 **Attribution Badges & Room Feed:** Color-coded DJ badges ("Added by Leo", "Added by Cia") and an activity feed showing who queued, skipped, moved, or voted on songs.

---

## 🚀 Quick Start Guide (For Any Host)

Anyone can be the host! Whether you are on **macOS**, **Windows**, or **Linux**, follow these simple steps to get the jukebox running in under 5 minutes.

### 📋 Prerequisites

1. **Node.js** (v18.0.0 or later): [Download Node.js](https://nodejs.org/)
2. **YouTube Music Desktop App** (open-source player with API server plugin):
   - **macOS (Apple Silicon / M1/M2/M3/M4):** [Download ARM64 DMG](https://github.com/pear-devs/pear-desktop/releases/latest)
   - **macOS (Intel):** [Download x64 DMG](https://github.com/pear-devs/pear-desktop/releases/latest)
   - **Windows:** [Download `.exe` Installer](https://github.com/pear-devs/pear-desktop/releases/latest)
   - **Linux:** [Download `.AppImage` or `.deb`](https://github.com/pear-devs/pear-desktop/releases/latest)

---

### ⚙️ Step 1: Configure YouTube Music Desktop

1. Open **YouTube Music.app** on your computer.
2. Sign in to your Google Account (recommended: account with YouTube Premium for uninterrupted ad-free playback).
3. Open **Settings** (Gear icon ⚙️) or press `Cmd + ,` (Mac) / `Ctrl + ,` (Windows).
4. Navigate to **Plugins** in the sidebar.
5. Search for or scroll to **API Server** and toggle it **ON**.
6. Click the settings for **API Server**:
   - **Port:** `26538` (default)
   - **Hostname:** `0.0.0.0` or `localhost`
   - **Auth Strategy:** `NONE` (leave disabled / none)
7. Start playing any playlist or song in the YouTube Music app.

---

### 💻 Step 2: Clone & Start Party Jukebox

Open your terminal and run:

```bash
# 1. Clone the repository
git clone https://github.com/sam/jukebox.git
cd jukebox

# 2. Install dependencies (express, cors, qrcode-terminal)
npm install

# 3. Start the Jukebox server
npm start
```

Upon launching, the terminal will automatically detect your local Wi-Fi IP address and print:

```text
======================================================
🎵  PARTY JUKEBOX READY!
======================================================
📡 Local Network URL: http://192.168.0.180:3000
💻 Host URL:          http://localhost:3000
======================================================
📲 SCAN WITH PHONE TO OPEN:
[ QR Code renders in your terminal ]
======================================================
```

---

### 📲 Step 3: Let Friends Connect!

1. Make sure your friends are connected to the **same Wi-Fi network** as the host laptop.
2. Tell them to open their phone camera and **scan the terminal QR code**, or enter the `Local Network URL` (e.g. `http://192.168.0.180:3000`) in their mobile browser.
3. Each friend picks their DJ name (Leo, Andrew, Cia, Sam, or custom).
4. Anyone can search for songs, paste YouTube URLs, upvote, reorder, view synchronized lyrics, and enjoy the party!

---

## 🛠️ Architecture & How It Works

```
                     ┌───────────────────────────────────────────────┐
                     │               Host Machine                    │
                     │  (Sam's / Andrew's / Anyone's Mac or PC)      │
                     │                                               │
                     │   ┌────────────────────────────────────────┐  │
                     │   │        YouTube Music Desktop           │  │
                     │   │   - Plays Lossless / Premium Audio     │  │
                     │   │   - API Server on localhost:26538      │  │
                     │   └───────────────────▲────────────────────┘  │
                     │                       │ REST + WebSocket      │
                     │   ┌───────────────────▼────────────────────┐  │
                     │   │          Node.js Express App           │  │
                     │   │   - Server-Sent Events (SSE)           │  │
                     │   │   - Master System Volume Control       │  │
                     │   │   - Monotonic Playback Tracker         │  │
                     │   │   - LRCLib Karaoke Synced Lyrics API   │  │
                     │   │   - Queue Reordering & Voting Engine   │  │
                     │   └───────────────────▲────────────────────┘  │
                     └───────────────────────┼───────────────────────┘
                                             │ Wi-Fi LAN (:3000)
                     ┌───────────────────────┴───────────────────────┐
                     │                                               │
               📱 Guest 1 (Leo)              📱 Guest 2 (Cia)         📱 Guest 3 (Andrew)
             Mobile Web Interface          Mobile Web Interface     Mobile Web Interface
```

- **Host App (`server.js`):**
  - Communicates with YouTube Music desktop's internal REST API and WebSocket events.
  - Controls macOS physical speaker volume via `osascript`, with cross-platform fallback for Windows & Linux.
  - Bridges requests to [LRCLib](https://lrclib.net/) to provide live synchronized LRC karaoke lines.
  - Broadcasts instantaneous queue, playback, and volume state to all connected phones via lightweight **Server-Sent Events (SSE)**.
- **Client App (`public/index.html`):**
  - Single-page mobile-first interface styled with Tailwind CSS.
  - Drag-and-drop powered by SortableJS.
  - Real-time karaoke scrolling with auto-centering on the active line.
  - Smooth 200ms interpolation ticker that counts steadily without snapping or jitter.

---

## ❓ Troubleshooting & FAQ

### 1. Friends' phones cannot open the URL (`Connection timed out`)
- **Same Wi-Fi Network:** Make sure the host computer and phones are connected to the exact same Wi-Fi router (avoid Guest Wi-Fi networks that have "AP Isolation" / "Client Isolation" enabled).
- **Firewall:**
  - **macOS:** System Settings → Network → Firewall → Allow incoming connections for Node.
  - **Windows:** Windows Defender Firewall → Allow an app through firewall → Allow Node.js.

### 2. "Connect YouTube Music" or Red Indicator in UI
- Ensure **YouTube Music Desktop** is running and the **API Server** plugin is turned ON in Settings.
- Verify in your host terminal:
  ```bash
  curl http://localhost:26538/api/v1/song
  ```
  If it returns JSON song details, the desktop app is properly connected.

### 3. Remote Access (Friends outside home Wi-Fi)
If you want friends to queue songs from mobile cellular data (outside Wi-Fi), expose the local port using Cloudflare Tunnel or localtunnel:
```bash
npx localtunnel --port 3000
```
Share the generated HTTPS URL with anyone!

---

## 📜 License
MIT License. Created with ❤️ for friends and music lovers.
