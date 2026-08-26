const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const http = require('http');
const pino = require('pino');

// Servidor HTTP integrado para que Render no reinicie el servicio por falta de puerto
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Raquel Bot está activo')).listen(PORT, () => {
    console.log(`Servidor HTTP escuchando en el puerto ${PORT}`);
});

// Reemplazar con tu URL desplegada que termina en /exec
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec"; 
const NUMERO_TELEFONO_BOT = "541167613040";

let codigoSolicitado = false;
const mapaGrupos = new Map();

async function iniciarRaquel() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Oculta los logs técnicos masivos de Baileys
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Esperar a que la conexión se estabilice antes de pedir el código
    if (!sock.authState.creds.registered && !codigoSolicitado) {
        codigoSolicitado = true;
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(NUMERO_TELEFONO_BOT);
                console.log('\n====================================');
                console.log('🔑 CÓDIGO DE VINCULACIÓN DE RAQUEL:', code);
                console.log('====================================\n');
            } catch (err) {
                console.error('Error al generar código de vinculación:', err.message);
                codigoSolicitado = false;
            }
        }, 6000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                setTimeout(iniciarRaquel, 3000);
            }
        } else if (connection === 'open') {
            console.log('¡Raquel está conectada y lista en WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const esGrupo = remoteJid.endsWith('@g.us');

        if (!esGrupo) return;

        let nombreGrupo = mapaGrupos.get(remoteJid);
        if (!nombreGrupo) {
            try {
                const groupMetadata = await sock.groupMetadata(remoteJid);
                nombreGrupo = groupMetadata.subject;
                mapaGrupos.set(remoteJid, nombreGrupo);
            } catch (e) {
                return;
            }
        }

        const esGrupoObjetivo = nombreGrupo.toLowerCase().includes("gasto");
        if (!esGrupoObjetivo) return;

        const sender = msg.key.participant ? msg.key.participant.replace('@s.whatsapp.net', '') : remoteJid.replace('@s.whatsapp.net', '');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
            try {
                const response = await fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    body: JSON.stringify({ sender: sender, message: text }),
                    headers: { 'Content-Type': 'application/json' }
                });
                const resJson = await response.json();

                if (resJson && resJson.text) {
                    await sock.sendMessage(remoteJid, { text: resJson.text });
                }
            } catch (err) {
                console.error("Error contactando Apps Script:", err);
            }
        }
    });
}

iniciarRaquel();
