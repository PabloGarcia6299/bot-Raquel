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

// Servidor HTTP para Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Raquel Bot Activo')).listen(PORT, () => {
    console.log(`[HTTP] Servidor escuchando en el puerto ${PORT}`);
});

// ⚠️ Reemplazá con tu URL de Apps Script terminada en /exec
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec"; 
const NUMERO_TELEFONO_BOT = "5491167613040";

const mapaGrupos = new Map();
let solicitoCodigo = false;

async function iniciarRaquel() {
    console.log('\n--------------------------------------------------');
    console.log('[INIT] Iniciando proceso de conexión...');

    // Limpieza de sesión incompleta
    if (fs.existsSync('auth_info_baileys/creds.json')) {
        try {
            const credsData = JSON.parse(fs.readFileSync('auth_info_baileys/creds.json', 'utf-8'));
            if (!credsData.registered) {
                console.log('[AUTH] Sesión previa no registrada. Limpiando carpeta auth_info_baileys...');
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
            }
        } catch (e) {
            console.log('[AUTH] Error al leer creds.json. Recreando directorio...');
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        }
    }

    // 1. Obtener la última versión oficial de WhatsApp Web
    let version = [2, 3000, 1015901307];
    try {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo.version;
        console.log(`[WA_VERSION] Versión obtenida: v${version.join('.')}, ¿Es la última?: ${versionInfo.isLatest}`);
    } catch (err) {
        console.log('[WA_VERSION] No se pudo obtener la última versión online. Usando versión base.');
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'error' }),
        browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection) {
            console.log(`[STATUS] Estado de la conexión: ${connection}`);
        }

        // 2. Pedir código de vinculación únicamente cuando el canal emite la señal (qr)
        if (qr && !sock.authState.creds.registered && !solicitoCodigo) {
            solicitoCodigo = true;
            console.log('[PAIRING] Canal listo. Esperando 3 segundos antes de solicitar código...');
            await new Promise(r => setTimeout(r, 3000));

            try {
                console.log(`[PAIRING] Solicitando código para el número: ${NUMERO_TELEFONO_BOT}`);
                const code = await sock.requestPairingCode(NUMERO_TELEFONO_BOT);
                console.log('\n====================================');
                console.log('🔑 CÓDIGO DE VINCULACIÓN DE RAQUEL:', code);
                console.log('====================================\n');
            } catch (err) {
                console.error('[PAIRING ERROR] Falló la solicitud del código:', err.message || err);
                solicitoCodigo = false;
            }
        }

        if (connection === 'close') {
            solicitoCodigo = false;
            const errorObj = lastDisconnect?.error;
            const statusCode = errorObj?.output?.statusCode || errorObj?.statusCode;

            console.log(`[DISCONNECT] Conexión cerrada. Código de estado: ${statusCode}`);
            if (errorObj) {
                console.log('[DIAGNOSTIC] Detalle del error:', JSON.stringify({
                    message: errorObj.message,
                    statusCode: statusCode,
                    payload: errorObj?.output?.payload
                }, null, 2));
            }

            if (statusCode === 405 || statusCode === 401) {
                console.log('[RETRY] Error 405/401 (Restricción o desincronización). Esperando 45 segundos...');
                setTimeout(iniciarRaquel, 45000);
            } else if (statusCode !== DisconnectReason.loggedOut) {
                console.log('[RETRY] Reintentando conexión en 10 segundos...');
                setTimeout(iniciarRaquel, 10000);
            } else {
                console.log('[FATAL] Sesión cerrada explícitamente. Elimina auth_info_baileys y reinicia.');
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
