/**
 * NG Delta WhatsApp Alert Server
 * -------------------------------
 * Receives a webhook from the Google Apps Script (whenever "NG Delta"
 * in the sheet is not 0) and sends a WhatsApp message using Baileys.
 *
 * SETUP:
 *   1. Install Node.js (v18+) if you don't have it: https://nodejs.org
 *   2. In this folder, run:
 *        npm install
 *   3. Open index config below and set ALERT_TO to your own WhatsApp
 *      number (with country code, digits only, e.g. "919876543210").
 *   4. Run:
 *        node server.js
 *   5. A QR code will print in the terminal. Open WhatsApp on your
 *      phone -> Settings -> Linked Devices -> Link a Device -> scan it.
 *   6. Once linked, the server stays running and listens on port 3000
 *      for alerts. Keep this terminal/process running continuously
 *      (e.g. with `pm2` or a background service) so alerts keep working.
 *   7. Point the Apps Script's WEBHOOK_URL at this server's address,
 *      e.g. http://localhost:3000/alert for local testing, or an
 *      ngrok/public URL so Google's servers can actually reach it
 *      (see the note at the bottom of the .gs file).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // generates an actual image, for the /qr web page
const sharp = require('sharp'); // renders the SVG table into a PNG image
const { Boom } = require('@hapi/boom');

// ====== CONFIG — EDIT THESE ======
const PORT = process.env.PORT || 3000; // Render sets PORT itself — do not hardcode
const ALERT_SECRET = 'change-this-shared-secret'; // must match WEBHOOK_SECRET in the .gs file
const ALERT_TO = '919876543210'; // <-- YOUR WhatsApp number, country code + number, digits only
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info'; // local, not persistent across redeploys on Render's free tier

// FREE persistence fix: back up the WhatsApp login to a private GitHub
// Gist, so it survives Render wiping the disk on every redeploy/restart.
// Set these two as environment variables in Render (Settings → Environment),
// NOT hardcoded here, since GITHUB_TOKEN is a secret.
//   GITHUB_TOKEN  — a GitHub Personal Access Token with "gist" scope
//   GIST_ID       — the ID of an existing (can be empty) secret Gist
// If either is missing, the server just behaves as before (local only).
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';
const GIST_FILENAME = 'auth_backup.json';
// ===================================

let sock; // active WhatsApp socket, set once connected
let latestQr = null; // most recent QR string, shown at GET /qr

// ---- Gist-based auth backup (free alternative to a paid Render Disk) ----

async function restoreAuthFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) {
    console.log('GITHUB_TOKEN/GIST_ID not set — skipping Gist restore (login will not survive redeploys).');
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      console.log('Gist restore: no existing backup found (or fetch failed) — starting fresh.');
      return;
    }
    const data = await res.json();
    const file = data.files && data.files[GIST_FILENAME];
    if (!file || !file.content) {
      console.log('Gist restore: backup file empty — starting fresh.');
      return;
    }
    const filesMap = JSON.parse(file.content); // { "creds.json": "<base64>", ... }
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    for (const [filename, base64Content] of Object.entries(filesMap)) {
      fs.writeFileSync(path.join(AUTH_FOLDER, filename), Buffer.from(base64Content, 'base64'));
    }
    console.log(`Gist restore: restored ${Object.keys(filesMap).length} auth file(s) from backup.`);
  } catch (err) {
    console.error('Gist restore failed (continuing without it):', err.message);
  }
}

let backupInFlight = false;
let backupQueued = false;

async function backupAuthToGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return;
  if (backupInFlight) { backupQueued = true; return; } // debounce rapid creds.update bursts
  backupInFlight = true;
  try {
    if (!fs.existsSync(AUTH_FOLDER)) return;
    const filesMap = {};
    for (const filename of fs.readdirSync(AUTH_FOLDER)) {
      const fullPath = path.join(AUTH_FOLDER, filename);
      if (fs.statSync(fullPath).isFile()) {
        filesMap[filename] = fs.readFileSync(fullPath).toString('base64');
      }
    }
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: { [GIST_FILENAME]: { content: JSON.stringify(filesMap) } },
      }),
    });
    if (!res.ok) {
      console.error('Gist backup failed:', res.status, await res.text());
    } else {
      console.log('Gist backup: auth state saved.');
    }
  } catch (err) {
    console.error('Gist backup error:', err.message);
  } finally {
    backupInFlight = false;
    if (backupQueued) {
      backupQueued = false;
      backupAuthToGist();
    }
  }
}

async function startWhatsApp() {
  await restoreAuthFromGist();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we handle QR printing ourselves below for clarity
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    backupAuthToGist(); // fire-and-forget, debounced
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      console.log('\nQR ready — open /qr in a browser to scan it (terminal QR is often unreadable in log viewers):\n');
      qrcode.generate(qr, { small: true }); // best-effort terminal fallback
    }

    if (connection === 'open') {
      latestQr = null; // connected — stop showing a stale QR on /qr
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      } else {
        console.log(`Logged out. Delete the ${AUTH_FOLDER} folder and restart to re-link.`);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connected and ready to send alerts.');
    }
  });
}

async function sendWhatsAppMessage(toNumber, text) {
  if (!sock) throw new Error('WhatsApp socket not ready yet');
  const jid = `${toNumber}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

async function sendWhatsAppImage(toNumber, imageUrl, caption) {
  if (!sock) throw new Error('WhatsApp socket not ready yet');
  const jid = `${toNumber}@s.whatsapp.net`;
  await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' });
}

// Sends an image from a PNG buffer (not a URL) — used for the
// locally-rendered table image.
async function sendWhatsAppImageBuffer(toNumber, buffer, caption) {
  if (!sock) throw new Error('WhatsApp socket not ready yet');
  const jid = `${toNumber}@s.whatsapp.net`;
  await sock.sendMessage(jid, { image: buffer, caption: caption || '' });
}

// Builds a table as an SVG, then renders it to a PNG buffer with sharp.
// title: string shown at top
// columns: array of column header strings
// rows: array of arrays (each inner array is one row's cell values,
//       same length as columns)
// highlightRows: optional array, same length as rows — each entry is
//       either a hex color string (used directly as that row's
//       background) or true (shorthand for the default red) or
//       false/undefined (default alternating stripe).
// legend: optional array of {color, label} shown under the title.
function renderTableImage(title, columns, rows, highlightRows, legend) {
  const colWidth = 160;
  const rowHeight = 34;
  const headerHeight = 44;
  const titleHeight = legend && legend.length ? 76 : 50;
  const padding = 20;

  const width = padding * 2 + colWidth * columns.length;
  const height = padding * 2 + titleHeight + headerHeight + rowHeight * rows.length;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  svg += `<rect width="100%" height="100%" fill="white"/>`;

  // Title
  svg += `<text x="${padding}" y="${padding + 28}" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#1a1a1a">${escapeXml(title)}</text>`;

  // Legend (small colored squares + labels), e.g. Green = OK, Yellow = minor, Red = major
  if (legend && legend.length) {
    let lx = padding;
    const ly = padding + 42;
    legend.forEach((item) => {
      svg += `<rect x="${lx}" y="${ly}" width="14" height="14" fill="${item.color}" stroke="#cccccc" stroke-width="1"/>`;
      svg += `<text x="${lx + 20}" y="${ly + 12}" font-family="Arial, sans-serif" font-size="12" fill="#444444">${escapeXml(item.label)}</text>`;
      lx += 24 + item.label.length * 7 + 20;
    });
  }

  const tableTop = padding + titleHeight;

  // Header row
  svg += `<rect x="${padding}" y="${tableTop}" width="${colWidth * columns.length}" height="${headerHeight}" fill="#2b2b2b"/>`;
  columns.forEach((col, i) => {
    const x = padding + i * colWidth + colWidth / 2;
    svg += `<text x="${x}" y="${tableTop + headerHeight / 2 + 6}" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="white" text-anchor="middle">${escapeXml(String(col))}</text>`;
  });

  // Data rows. highlightRows entries can be:
  //   a color string ('#fdecea' etc.) — used directly
  //   true — treated as the default red highlight (old boolean style)
  //   false/undefined — default alternating row stripe
  rows.forEach((row, rIdx) => {
    const y = tableTop + headerHeight + rIdx * rowHeight;
    const entry = highlightRows && highlightRows[rIdx];
    let bg;
    if (typeof entry === 'string') {
      bg = entry;
    } else if (entry === true) {
      bg = '#fdecea';
    } else {
      bg = rIdx % 2 === 0 ? '#f8f9fa' : '#ffffff';
    }
    svg += `<rect x="${padding}" y="${y}" width="${colWidth * columns.length}" height="${rowHeight}" fill="${bg}" stroke="#e0e0e0" stroke-width="1"/>`;
    row.forEach((cell, cIdx) => {
      const x = padding + cIdx * colWidth + colWidth / 2;
      svg += `<text x="${x}" y="${y + rowHeight / 2 + 5}" font-family="Arial, sans-serif" font-size="13" fill="#202124" text-anchor="middle">${escapeXml(String(cell))}</text>`;
    });
  });

  svg += `</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Builds a QuickChart.io chart config URL — a free hosted charting
// service that renders a chart config into a PNG you can pass as an
// image URL straight into WhatsApp (no local image rendering needed).
function buildChartImageUrl(labels, deltaValues, expectedLine) {
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'NG Delta',
          data: deltaValues,
          backgroundColor: deltaValues.map((d) =>
            Math.abs(d) > 100 ? '#E05A47' : d !== 0 ? '#F2A541' : '#999999'
          ),
        },
      ],
    },
    options: {
      title: { display: true, text: 'NG Delta by Day' },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true } }],
      },
    },
  };
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${encoded}&width=800&height=400&backgroundColor=white`;
}

// ---- HTTP webhook server ----
const app = express();
app.use(express.json({ limit: '2mb' }));

app.post('/alert', async (req, res) => {
  try {
    const { secret, message, sheet, date, ngDelta, to } = req.body || {};

    if (secret !== ALERT_SECRET) {
      return res.status(401).json({ ok: false, error: 'bad secret' });
    }

    // "to" can be a single number, an array of numbers (multiple
    // recipients), or omitted entirely (falls back to ALERT_TO).
    let recipients = [];
    if (Array.isArray(to)) {
      recipients = to.map((n) => String(n).trim()).filter(Boolean);
    } else if (to && String(to).trim()) {
      recipients = [String(to).trim()];
    }
    if (recipients.length === 0) {
      recipients = [ALERT_TO];
    }

    const text = message || `NG Delta alert — ${sheet} — ${date}: NG Delta is ${ngDelta} (expected 0).`;

    for (const recipient of recipients) {
      await sendWhatsAppMessage(recipient, text);
      console.log(`Alert sent to ${recipient}: ${text}`);
    }
    res.json({ ok: true, sentTo: recipients });
  } catch (err) {
    console.error('Failed to send alert:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Sends a chart image (NG Delta by day) with a text caption, instead
// of a plain text message. Body: { secret, to, caption, labels, delta }
// labels = array of day labels (e.g. ["01","02",...])
// delta  = array of NG Delta numbers, same length as labels
app.post('/snapshot-image', async (req, res) => {
  try {
    const { secret, to, caption, labels, delta } = req.body || {};

    if (secret !== ALERT_SECRET) {
      return res.status(401).json({ ok: false, error: 'bad secret' });
    }
    if (!Array.isArray(labels) || !Array.isArray(delta) || labels.length === 0) {
      return res.status(400).json({ ok: false, error: 'labels and delta arrays are required' });
    }

    let recipients = [];
    if (Array.isArray(to)) {
      recipients = to.map((n) => String(n).trim()).filter(Boolean);
    } else if (to && String(to).trim()) {
      recipients = [String(to).trim()];
    }
    if (recipients.length === 0) recipients = [ALERT_TO];

    const chartUrl = buildChartImageUrl(labels, delta);

    for (const recipient of recipients) {
      await sendWhatsAppImage(recipient, chartUrl, caption || '');
      console.log(`Image report sent to ${recipient}`);
    }
    res.json({ ok: true, sentTo: recipients, chartUrl });
  } catch (err) {
    console.error('Failed to send image report:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Sends a TABLE as an image (rows/columns, not a chart). Body:
// { secret, to, title, columns, rows, highlightRows, legend }
// columns: array of header strings
// rows: array of arrays (cell values), same length as columns
// highlightRows: optional array, same length as rows — each entry a
//     hex color string, or true (default red), or false/undefined
// legend: optional array of {color, label} shown under the title
app.post('/table-image', async (req, res) => {
  try {
    const { secret, to, title, columns, rows, highlightRows, legend } = req.body || {};

    if (secret !== ALERT_SECRET) {
      return res.status(401).json({ ok: false, error: 'bad secret' });
    }
    if (!Array.isArray(columns) || !Array.isArray(rows) || columns.length === 0) {
      return res.status(400).json({ ok: false, error: 'columns and rows arrays are required' });
    }

    let recipients = [];
    if (Array.isArray(to)) {
      recipients = to.map((n) => String(n).trim()).filter(Boolean);
    } else if (to && String(to).trim()) {
      recipients = [String(to).trim()];
    }
    if (recipients.length === 0) recipients = [ALERT_TO];

    const buffer = await renderTableImage(title || 'Report', columns, rows, highlightRows, legend);

    for (const recipient of recipients) {
      await sendWhatsAppImageBuffer(recipient, buffer, '');
      console.log(`Table image sent to ${recipient}`);
    }
    res.json({ ok: true, sentTo: recipients });
  } catch (err) {
    console.error('Failed to send table image:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, whatsappConnected: !!sock });
});

// Open this URL in a browser to scan the WhatsApp login QR code as an
// actual image — much easier than reading it out of the Render log viewer.
app.get('/qr', async (req, res) => {
  if (!latestQr) {
    return res.send(
      '<p style="font-family:sans-serif">No QR code right now — either already connected, or still starting up. Refresh in a few seconds.</p>'
    );
  }
  try {
    const dataUrl = await QRCode.toDataURL(latestQr, { width: 400 });
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;margin-top:40px">
          <h2>Scan with WhatsApp → Linked Devices → Link a Device</h2>
          <img src="${dataUrl}" width="400" height="400" />
          <p>This page auto-refreshes every 5 seconds.</p>
          <script>setTimeout(() => location.reload(), 5000);</script>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to render QR: ' + String(err));
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT} (POST /alert)`);
});

startWhatsApp();
