const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers 
} = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const http = require('http');
const pino = require('pino');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Raquel Bot Activo')).listen(PORT, () => {
    console.log(`[HTTP] Servidor escuchando en el puerto ${PORT}`);
});

// URL confirmada de Google Apps Script
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec"; 

// Número formateado (Argentina con prefijo 9)
const NUMERO_TELEFONO_BOT = "5491167613040";

const mapaGrupos = new Map();
let solicitoCodigo = false;

async function iniciarRaquel() {
    console.log('\n--------------------------------------------------');
    console.log('[INIT] Iniciando proceso de conexión...');

    let version = [2, 3000, 1015901307];
    try {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo.version;
        console.log(`[WA_VERSION] Versión en uso: v${version.join('.')}`);
    } catch (err) {
        console.log('[WA_VERSION] Usando versión fallback.');
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection) {
            console.log(`[STATUS] Estado: ${connection}`);
        }

        if (qr && !sock.authState.creds.registered && !solicitoCodigo) {
            solicitoCodigo = true;
            console.log('[PAIRING] Generando código de vinculación...');
            
            // Pausa estratégica para sincronizar llaves con WhatsApp
            await new Promise(r => setTimeout(r, 5000));
            
            try {
                const code = await sock.requestPairingCode(NUMERO_TELEFONO_BOT);
                await saveCreds();

                console.log('\n====================================');
                console.log('🔑 CÓDIGO DE VINCULACIÓN DE RAQUEL:', code);
                console.log('====================================\n');
            } catch (err) {
                console.error('[PAIRING ERROR] Error al generar código:', err.message || err);
                solicitoCodigo = false;
            }
        }

        if (connection === 'close') {
            solicitoCodigo = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[DISCONNECT] Conexión cerrada. Código: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('[AUTH] Sesión expirada. Limpiando archivos...');
                if (fs.existsSync('auth_info_baileys')) {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                }
                setTimeout(iniciarRaquel, 5000);
            } else {
                setTimeout(iniciarRaquel, 10000);
            }
        } else if (connection === 'open') {
            solicitoCodigo = false;
            console.log('--------------------------------------------------');
            console.log('✅ ¡Raquel está conectada y lista en WhatsApp!');
            console.log('--------------------------------------------------');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid.endsWith('@g.us')) return;

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

        if (!nombreGrupo.toLowerCase().includes("gasto")) return;

        const sender = msg.key.participant ? msg.key.participant.replace('@s.whatsapp.net', '') : remoteJid.replace('@s.whatsapp.net', '');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
            try {
                const response = await fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    body: JSON.stringify({ sender, message: text }),
                    headers: { 'Content-Type': 'application/json' }
                });
                const resJson = await response.json();
                if (resJson?.text) {
                    await sock.sendMessage(remoteJid, { text: resJson.text });
                }
            } catch (err) {
                console.error("[APPS SCRIPT ERROR]", err);
            }
        }
    });
}

iniciarRaquel();
