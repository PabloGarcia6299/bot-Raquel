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

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec"; 
const NUMERO_TELEFONO_BOT = "5491167613040";

const mapaGrupos = new Map();
let solicitoCodigo = false;

async function iniciarRaquel() {
    console.log('\n--------------------------------------------------');
    console.log('[INIT] Iniciando proceso de conexión...');

    if (fs.existsSync('auth_info_baileys')) {
        try {
            const credsFile = 'auth_info_baileys/creds.json';
            if (fs.existsSync(credsFile)) {
                const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                if (!credsData.registered) {
                    console.log('[AUTH] Eliminando sesión no registrada...');
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                }
            }
        } catch (e) {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        }
    }

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
            console.log('[PAIRING] Esperando 5 segundos para estabilizar el socket...');
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
        if (!msg.message) return;

        console.log('\n📩 [PASO 1: EVENTO RECIBIDO] Se detectó actividad en WhatsApp.');

        const remoteJid = msg.key.remoteJid;
        console.log(`📍 [PASO 2: ORIGEN] JID: ${remoteJid}`);

        if (!remoteJid.endsWith('@g.us')) {
            console.log('⛔ [DESCARTADO] El mensaje no proviene de un grupo.');
            return;
        }

        let nombreGrupo = mapaGrupos.get(remoteJid);
        if (!nombreGrupo) {
            try {
                console.log('🔍 [PASO 3: METADATA] Consultando nombre del grupo a WhatsApp...');
                const groupMetadata = await sock.groupMetadata(remoteJid);
                nombreGrupo = groupMetadata.subject;
                mapaGrupos.set(remoteJid, nombreGrupo);
            } catch (e) {
                console.error('❌ [ERROR METADATA] Falló obtener nombre de grupo:', e.message);
                return;
            }
        }

        console.log(`👥 [PASO 3: GRUPO DETECTADO] Nombre: "${nombreGrupo}"`);

        const GRUPOS_AUTORIZADOS = ["gastos familiares"];
        const nombreNormalizado = nombreGrupo.toLowerCase().trim();
        console.log(`🔎 [PASO 4: VALIDACIÓN GRUPO] Nombre procesado: "${nombreNormalizado}" | Permitidos:`, GRUPOS_AUTORIZADOS);

        if (!GRUPOS_AUTORIZADOS.includes(nombreNormalizado)) {
            console.log(`⛔ [DESCARTADO] El grupo "${nombreGrupo}" NO coincide con la lista de autorizados.`);
            return;
        }

        // Extrae texto de mensaje simple, citados o con imagen
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || 
                     msg.message.videoMessage?.caption;

        console.log(`💬 [PASO 5: CONTENIDO DE MENSAJE] Texto extraído: "${text}"`);

        if (!text) {
            console.log('⛔ [DESCARTADO] El mensaje no contiene texto procesable.');
            return;
        }

        if (msg.key.fromMe && (text.startsWith("✅") || text.startsWith("🤖") || text.toLowerCase().includes("registrado"))) {
            console.log('🤖 [DESCARTADO] Filtro anti-bucle: es una respuesta propia del bot.');
            return;
        }

        const rawSender = msg.key.participant || msg.key.remoteJid;
        const sender = rawSender.replace('@s.whatsapp.net', '').replace('@g.us', '').split(':')[0];
        console.log(`👤 [PASO 6: REMITENTE] Número: ${sender} (fromMe: ${msg.key.fromMe})`);

        console.log('🚀 [PASO 7: ENVIANDO A APPS SCRIPT] Iniciando fetch...');
        console.log('📦 Payload:', JSON.stringify({ sender, message: text }));

        try {
            const response = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ sender, message: text }),
                headers: { 'Content-Type': 'application/json' },
                redirect: 'follow'
            });

            console.log(`📡 [PASO 8: RESPUESTA HTTP] Status Code: ${response.status} ${response.statusText}`);

            const rawBody = await response.text();
            console.log(`📄 [PASO 9: CUERPO RECIBIDO] Respuesta de Apps Script:`, rawBody);

            let resJson;
            try {
                resJson = JSON.parse(rawBody);
            } catch (parseError) {
                console.error('❌ [ERROR PARSE JSON] La respuesta de Google Apps Script no es un JSON válido.');
                return;
            }

            if (resJson?.text) {
                console.log(`📤 [PASO 10: ENVIANDO A WHATSAPP] Respondiendo: "${resJson.text}"`);
                await sock.sendMessage(remoteJid, { text: resJson.text });
                console.log('✅ [PASO 11: PROCESO COMPLETADO EXITOSAMENTE]');
            } else {
                console.log('⚠️ [ADVERTENCIA] Apps Script respondió pero no devolvió el campo "text".');
            }
        } catch (err) {
            console.error("❌ [APPS SCRIPT ERROR] Falló la petición fetch:", err);
        }
    });
}

iniciarRaquel();
