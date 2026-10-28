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
const { Boom } = require('@hapi/boom');

// ====== CONFIG — EDIT THESE ======
const PORT = 3000;
const ALERT_SECRET = 'change-this-shared-secret'; // must match WEBHOOK_SECRET in the .gs file
const ALERT_TO = '919876543210'; // <-- YOUR WhatsApp number, country code + number, digits only
// ===================================

let sock; // active WhatsApp socket, set once connected

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we handle QR printing ourselves below for clarity
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Linked Devices > Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      } else {
        console.log('Logged out. Delete the auth_info folder and restart to re-link.');
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

app.listen(PORT, () => {
  console.log(`Webhook server listening on http://localhost:${PORT}/alert`);
});

startWhatsApp();
