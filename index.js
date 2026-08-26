const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');

// 1. Reemplazá con tu URL de Google Apps Script
const APPS_SCRIPT_URL = "https://script.google.com/macros/library/d/1nWxSVx3dT1Uuc-1b6sBR7OD0jDILdH38Tvz8gvMTE1E-R8CzdgtwUAwy/2";

// 2. Reemplazá con el número de teléfono que será Raquel (Código país + código área + número, SIN el signo + ni espacios)
// Ejemplo Argentina: "5491122334455"
const NUMERO_TELEFONO_BOT = "54911XXXXXXXX";

async function iniciarRaquel() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Solicitar código de vinculación de 8 dígitos
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            const code = await sock.requestPairingCode(NUMERO_TELEFONO_BOT);
            console.log('\n====================================');
            console.log('CÓDIGO DE VINCULACIÓN DE RAQUEL:', code);
            console.log('====================================\n');
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
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
