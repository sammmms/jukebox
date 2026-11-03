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
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || DEFAULT_TUNNEL_TOKEN;
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
  console.log(`${c.cyan}🔍 [1/3] Memeriksa YouTube Music Desktop...${c.reset}`);
  const ytmOk = await checkYTM();
  if (ytmOk) {
    console.log(`${c.emerald}   ✅ YouTube Music Desktop terhubung & aktif di port 26538!${c.reset}`);
  } else {
    console.log(`${c.amber}   ⚠️  YouTube Music Desktop belum terdeteksi.${c.reset}`);
    console.log(`${c.gray}      Tips: Buka YouTube Music Desktop -> Settings -> Integrations ->`);
    console.log(`      Aktifkan 'Companion Server' (Port 26538). Server Jukebox tetap berjalan${c.reset}`);
    console.log(`${c.gray}      dan akan otomatis terhubung begitu YouTube Music dibuka.${c.reset}`);
  }

  console.log(`\n${c.cyan}🌐 [2/3] Memeriksa Cloudflare Tunnel (${c.bold}https://dj.wsnsam.my.id${c.reset}${c.cyan})...${c.reset}`);
  const cloudflaredPath = findCloudflared();
  const alreadyRunning = isCloudflaredRunning();

  let tunnelProcess = null;

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
  } else {
    console.log(`${c.amber}   ⚠️  cloudflared belum terinstall di laptop ini.${c.reset}`);
    console.log(`${c.white}      Untuk menghubungkan domain https://dj.wsnsam.my.id secara otomatis:${c.reset}`);
    if (process.platform === 'darwin') {
      console.log(`${c.pink}      👉 Jalankan: brew install cloudflared${c.reset}`);
    } else if (process.platform === 'win32') {
      console.log(`${c.pink}      👉 Jalankan: winget install --id Cloudflare.cloudflared${c.reset}`);
    } else {
      console.log(`${c.pink}      👉 Unduh dari: https://github.com/cloudflare/cloudflared/releases${c.reset}`);
    }
    console.log(`${c.gray}      (Tanpa tunnel, Jukebox tetap bisa diakses di jaringan lokal WiFi).${c.reset}`);
  }

  console.log(`\n${c.cyan}🎶 [3/3] Menjalankan Server Jukebox Lokal...${c.reset}`);
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
