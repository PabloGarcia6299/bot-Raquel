const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const qrcode = require('qrcode-terminal');

// REEMPLAZÁ ESTA URL POR TU URL DE APPS SCRIPT (DEL PASO 1)
const APPS_SCRIPT_URL = "https://script.google.com/macros/library/d/1nWxSVx3dT1Uuc-1b6sBR7OD0jDILdH38Tvz8gvMTE1E-R8CzdgtwUAwy/2";

async function iniciarRaquel() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('ESCANEA ESTE CODIGO QR CON EL WHATSAPP DE RAQUEL:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) iniciarRaquel();
        } else if (connection === 'open') {
            console.log('¡Raquel está conectada y lista en WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
            try {
                const response = await fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    body: JSON.stringify({ sender: sender, message: text }),
                    headers: { 'Content-Type': 'application/json' }
                });
                const resJson = await response.json();

                await sock.sendMessage(msg.key.remoteJid, { text: resJson.text });
            } catch (err) {
                console.error("Error contactando Apps Script:", err);
            }
        }
    });
}

iniciarRaquel();
