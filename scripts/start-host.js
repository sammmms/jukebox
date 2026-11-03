#!/usr/bin/env node

/**
 * 👑 PARTY JUKEBOX - 1-CLICK MULTI-HOST LAUNCHER
 * 
 * Memungkinkan siapapun yang meng-clone repo ini untuk langsung menjadi HOST pesta:
 * 1. Mengecek koneksi YouTube Music Desktop (port 26538)
 * 2. Menjalankan server Jukebox lokal (port 3000)
 * 3. Mengaktifkan Cloudflare Tunnel ke domain publik https://dj.wsnsam.my.id
 *
 * Cara pakai:
 *   npm run host
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULT_TUNNEL_TOKEN = 'eyJhIjoiMTkwMzVmM2VlN2YyMmIxMTkyZjFiZWNlZTY1ZjlkODEiLCJ0IjoiNmNjMjVjNGUtOWFiYy00ZTk3LWI4NTUtMDRkN2NlNTFiOTlhIiwicyI6Ill6SXlZVGxoWlRVdE1tRTVZeTAwT0dNMkxXRTRZVEl0T0RFelpERXdaVE5sTW1RMyJ9';
// Only enable personal tunnel if explicitly requested via environment variable or --tunnel flag
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || (process.argv.includes('--tunnel') ? DEFAULT_TUNNEL_TOKEN : null);
const ROOT_DIR = path.resolve(__dirname, '..');

// ANSI Colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  pink: '\x1b[38;2;236;72;153m',
  rose: '\x1b[38;2;244;63;94m',
  amber: '\x1b[38;2;245;158;11m',
  cyan: '\x1b[36m',
  emerald: '\x1b[32m',
  gray: '\x1b[90m',
  white: '\x1b[37m'
};

console.log(`
${c.pink}${c.bold}╔════════════════════════════════════════════════════════════════════╗${c.reset}
${c.pink}${c.bold}║           👑 PARTY JUKEBOX - 1-CLICK MULTI-HOST LAUNCHER 👑        ║${c.reset}
${c.pink}${c.bold}║             Domain Publik: https://dj.wsnsam.my.id                 ║${c.reset}
${c.pink}${c.bold}╚════════════════════════════════════════════════════════════════════╝${c.reset}
`);

// 1. Check YouTube Music Desktop
function checkYTM() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:26538/query', { timeout: 1500 }, (res) => {
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 2. Find cloudflared binary
function findCloudflared() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'cloudflared.exe' : 'cloudflared';

  // Check PATH
  try {
    const checkCmd = isWin ? `where ${binName}` : `which ${binName}`;
    const p = execSync(checkCmd, { stdio: 'pipe' }).toString().trim().split('\n')[0];
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}

  // Check common macOS locations
  const macPaths = [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared'
  ];
  for (const mp of macPaths) {
    if (fs.existsSync(mp)) return mp;
  }

  // Check local bin in repo
  const localBin = path.join(ROOT_DIR, 'bin', binName);
  if (fs.existsSync(localBin)) return localBin;

  return null;
}

// 3. Check if cloudflared is already running as a system service
function isCloudflaredRunning() {
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'tasklist' : 'ps aux';
    const out = execSync(cmd, { stdio: 'pipe' }).toString();
    return out.includes('cloudflared');
  } catch (e) {
    return false;
  }
}

async function main() {
  console.log(`${c.emerald}🚀 [1/3] Party Jukebox Standalone Audio Engine siap!${c.reset}`);
  console.log(`${c.gray}   (Aplikasi berjalan mandiri tanpa perlu membuka YouTube Music Desktop lagi).${c.reset}`);

  const isQuickTunnel = process.argv.includes('--public') || process.argv.includes('--quick-tunnel');

  if (TUNNEL_TOKEN) {
    console.log(`\n${c.cyan}🌐 [2/3] Memeriksa Cloudflare Tunnel Pribadi (${c.bold}https://dj.wsnsam.my.id${c.reset}${c.cyan})...${c.reset}`);
    const cloudflaredPath = findCloudflared();
    const alreadyRunning = isCloudflaredRunning();

    if (alreadyRunning) {
      console.log(`${c.emerald}   ✅ Service cloudflared sudah aktif di latar belakang laptop ini!${c.reset}`);
    } else if (cloudflaredPath) {
      console.log(`${c.emerald}   ✅ cloudflared ditemukan di: ${cloudflaredPath}${c.reset}`);
      console.log(`${c.pink}   🚀 Menghubungkan tunnel ke dj.wsnsam.my.id...${c.reset}`);
      
      tunnelProcess = spawn(cloudflaredPath, ['tunnel', 'run', '--token', TUNNEL_TOKEN], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      tunnelProcess.stderr.on('data', (d) => {
        const line = d.toString();
        if (line.includes('Registered tunnel connection') || line.includes('Connection registered')) {
          console.log(`${c.emerald}   ⚡ Tunnel Cloudflare terhubung secara global!${c.reset}`);
        }
      });

      tunnelProcess.on('error', (err) => {
        console.warn(`${c.rose}   ⚠️  Gagal menjalankan cloudflared: ${err.message}${c.reset}`);
      });
    }
  } else if (isQuickTunnel) {
    console.log(`\n${c.cyan}🌐 [2/3] Membuka Cloudflare Quick Tunnel Publik (On-the-fly)...${c.reset}`);
    const cloudflaredPath = findCloudflared();
    if (cloudflaredPath) {
      tunnelProcess = spawn(cloudflaredPath, ['tunnel', '--url', 'http://localhost:3000'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      tunnelProcess.stderr.on('data', (d) => {
        const match = d.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
          console.log(`${c.emerald}   ⚡ Link Publik Berhasil Dibuat: ${c.bold}${c.pink}${match[0]}${c.reset}`);
        }
      });
    }
  } else {
    console.log(`\n${c.cyan}🌐 [2/3] Mode Akses: Jaringan Lokal WiFi & Hotspot Tethering${c.reset}`);
    console.log(`${c.gray}   (Host bisa mengaktifkan link publik internet sewaktu-waktu langsung dari UI web).${c.reset}`);
  }

  console.log(`\n${c.cyan}🎶 [3/3] Menjalankan Server Jukebox Standalone...${c.reset}`);
  const serverProcess = spawn('node', ['server.js'], {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });

  console.log(`
${c.emerald}${c.bold}🎉 PESTA SIAP DIMULAI!${c.reset}
${c.white}• Domain Publik : ${c.bold}${c.pink}https://dj.wsnsam.my.id${c.reset}
${c.white}• Akses Lokal   : ${c.bold}${c.cyan}http://localhost:3000${c.reset}
${c.gray}Tekan Ctrl+C untuk menghentikan host.${c.reset}
`);

  // Clean shutdown
  function cleanup() {
    console.log(`\n${c.amber}🛑 Menghentikan Host Party...${c.reset}`);
    if (tunnelProcess) {
      try { tunnelProcess.kill('SIGTERM'); } catch (e) {}
    }
    try { serverProcess.kill('SIGTERM'); } catch (e) {}
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(console.error);
