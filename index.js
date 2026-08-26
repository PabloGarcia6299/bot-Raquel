const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');

// 1. URL de Google Apps Script
const APPS_SCRIPT_URL = "https://script.google.com/macros/library/d/1nWxSVx3dT1Uuc-1b6sBR7OD0jDILdH38Tvz8gvMTE1E-R8CzdgtwUAwy/2";

// 2. Número de teléfono de Raquel (Código país + código área + número, sin el + ni espacios)
const NUMERO_TELEFONO_BOT = "54911XXXXXXXX"; 

let codigoSolicitado = false;

async function iniciarRaquel() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome') // Evita que WhatsApp cierre el socket por seguridad
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Solicitar el código SOLO cuando WhatsApp emita que la conexión está lista
        if (qr && !sock.authState.creds.registered && !codigoSolicitado) {
            codigoSolicitado = true;
            try {
                const code = await sock.requestPairingCode(NUMERO_TELEFONO_BOT);
                console.log('\n====================================');
                console.log('🔑 CÓDIGO DE VINCULACIÓN DE RAQUEL:', code);
                console.log('====================================\n');
            } catch (err) {
                console.error('Error al generar código de vinculación:', err.message);
                codigoSolicitado = false;
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            codigoSolicitado = false;
            
            if (shouldReconnect) {
                iniciarRaquel();
            }
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
