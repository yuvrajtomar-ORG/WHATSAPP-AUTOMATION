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
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // generates an actual image, for the /qr web page
const { Boom } = require('@hapi/boom');

// ====== CONFIG — EDIT THESE ======
const PORT = process.env.PORT || 3000; // Render sets PORT itself — do not hardcode
const ALERT_SECRET = 'change-this-shared-secret'; // must match WEBHOOK_SECRET in the .gs file
const ALERT_TO = '919876543210'; // <-- YOUR WhatsApp number, country code + number, digits only
const AUTH_FOLDER = process.env.AUTH_FOLDER || '/data/auth_info'; // mount a Render Disk at /data
// ===================================

let sock; // active WhatsApp socket, set once connected
let latestQr = null; // most recent QR string, shown at GET /qr

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we handle QR printing ourselves below for clarity
  });

  sock.ev.on('creds.update', saveCreds);

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

// ---- HTTP webhook server ----
const app = express();
app.use(express.json());

app.post('/alert', async (req, res) => {
  try {
    const { secret, message, sheet, date, ngDelta } = req.body || {};

    if (secret !== ALERT_SECRET) {
      return res.status(401).json({ ok: false, error: 'bad secret' });
    }

    const text = message || `NG Delta alert — ${sheet} — ${date}: NG Delta is ${ngDelta} (expected 0).`;

    await sendWhatsAppMessage(ALERT_TO, text);
    console.log(`Alert sent: ${text}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send alert:', err);
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
