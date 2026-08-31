const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers 
} = require('@whiskeysockets/baileys');
const { useMongoDBAuthState } = require('mongo-baileys');
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');
const http = require('http');
const pino = require('pino');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Raquel Bot Activo')).listen(PORT, () => {
    console.log(`[HTTP] Servidor escuchando en el puerto ${PORT}`);
});

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec"; 
const NUMERO_TELEFONO_BOT = "5491167613040";
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('[FATAL] No se encontró la variable de entorno MONGODB_URI. Revisá "Environment" en Render.');
    process.exit(1);
}

// --- NUEVO: cliente de Mongo, se conecta una sola vez y se reutiliza ---
const mongoClient = new MongoClient(MONGODB_URI);
let authCollection = null;

async function conectarMongo() {
    if (authCollection) return authCollection;
    console.log('[MONGO] Conectando a MongoDB Atlas...');
    await mongoClient.connect();
    const db = mongoClient.db('raquel_bot');
    authCollection = db.collection('auth_baileys');
    console.log('[MONGO] Conexión establecida correctamente.');
    return authCollection;
}

async function limpiarSesionMongo() {
    if (!authCollection) return;
    console.log('[MONGO] Limpiando sesión guardada en la base (sesión deslogueada o inválida)...');
    await authCollection.deleteMany({});
}

const mapaGrupos = new Map();
let solicitoCodigo = false;

// --- Control de estado de conexión para evitar sockets duplicados ---
let sock = null;
let isConnecting = false;
let intentoNumero = 0;

async function cerrarSocketAnterior() {
    if (!sock) return;
    console.log('[CLEANUP] Cerrando socket anterior antes de reconectar...');
    try {
        sock.ev.removeAllListeners();
    } catch (e) {
        console.log('[CLEANUP] No se pudieron remover listeners (no crítico):', e.message);
    }
    try {
        sock.end(new Error('Reconexión controlada'));
    } catch (e) {
        console.log('[CLEANUP] No se pudo cerrar el socket anterior (no crítico):', e.message);
    }
    sock = null;
}

async function iniciarRaquel() {
    if (isConnecting) {
        console.log('[GUARD] Ya hay un intento de conexión en curso, se ignora este llamado duplicado.');
        return;
    }
    isConnecting = true;
    intentoNumero++;

    console.log('\n--------------------------------------------------');
    console.log(`[INIT] Iniciando proceso de conexión... (intento #${intentoNumero})`);

    await cerrarSocketAnterior();

    let collection;
    try {
        collection = await conectarMongo();
    } catch (err) {
        console.error('[MONGO ERROR] No se pudo conectar a MongoDB:', err.message);
        isConnecting = false;
        setTimeout(iniciarRaquel, 15000);
        return;
    }

    let version = [2, 3000, 1015901307];
    try {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo.version;
        console.log(`[WA_VERSION] Versión en uso: v${version.join('.')}`);
    } catch (err) {
        console.log('[WA_VERSION] Usando versión fallback.');
    }

    const { state, saveCreds } = await useMongoDBAuthState(collection);
    console.log(`[AUTH] Estado de sesión cargado desde MongoDB. ¿Registrado?: ${state.creds.registered}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    console.log('[SOCKET] Socket creado, esperando eventos de conexión...');

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
            isConnecting = false;
            solicitoCodigo = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const razon = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) || 'desconocida';
            console.log(`[DISCONNECT] Conexión cerrada. Código: ${statusCode} (${razon})`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('[AUTH] Sesión expirada o desvinculada. Limpiando MongoDB y generando pairing code nuevo...');
                await limpiarSesionMongo();
                setTimeout(iniciarRaquel, 5000);
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                // Espera más larga específicamente para 440, según recomendación oficial
                // de Baileys ("reconectar con cuidado") para no chocar con el estado
                // que el servidor todavía no liberó del todo.
                console.log('[DISCONNECT] Error 440 (connectionReplaced): esperando 30s antes de reintentar para evitar otra colisión...');
                setTimeout(iniciarRaquel, 30000);
            } else {
                setTimeout(iniciarRaquel, 10000);
            }
        } else if (connection === 'open') {
            isConnecting = false;
            solicitoCodigo = false;
            intentoNumero = 0;
            console.log('--------------------------------------------------');
            console.log('✅ ¡Raquel está conectada y lista en WhatsApp!');
            console.log('--------------------------------------------------');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') {
            console.log(`[FILTRO] Mensaje ignorado: tipo "${type}" no es "notify".`);
            return;
        }
        const msg = messages[0];
        if (!msg.message) {
            console.log('[FILTRO] Mensaje ignorado: no tiene contenido de mensaje (msg.message vacío).');
            return;
        }

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        console.log(`[MENSAJE RECIBIDO]: "${text}" | De: ${msg.key.remoteJid}`);

        if (!text) {
            console.log('[FILTRO] Mensaje ignorado: no se pudo extraer texto (¿es una imagen, audio o sticker?).');
            return;
        }

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid.endsWith('@g.us')) {
            console.log('[FILTRO] Mensaje ignorado: no proviene de un grupo (@g.us).');
            return;
        }

        let nombreGrupo = mapaGrupos.get(remoteJid);
        if (!nombreGrupo) {
            try {
                const groupMetadata = await sock.groupMetadata(remoteJid);
                nombreGrupo = groupMetadata.subject;
                mapaGrupos.set(remoteJid, nombreGrupo);
                console.log(`[GRUPO] Metadata obtenida. Nombre: "${nombreGrupo}"`);
            } catch (e) {
                console.log('[FILTRO] Mensaje ignorado: no se pudo obtener metadata del grupo:', e.message);
                return;
            }
        }

        const GRUPOS_AUTORIZADOS = ["gastos familiares"];
        if (!GRUPOS_AUTORIZADOS.includes(nombreGrupo.toLowerCase().trim())) {
            console.log(`[FILTRO] Mensaje ignorado: grupo "${nombreGrupo}" no está autorizado.`);
            return;
        }

        if (msg.key.fromMe && (text.startsWith("✅") || text.startsWith("🤖") || text.toLowerCase().includes("registrado"))) {
            console.log('[FILTRO] Mensaje ignorado: es un auto-mensaje de confirmación (anti-bucle).');
            return;
        }

        const rawSender = msg.key.participant || msg.key.remoteJid;
        const sender = rawSender.replace('@s.whatsapp.net', '').replace('@g.us', '').split(':')[0];

        console.log(`[APPS SCRIPT] Enviando a Google Sheets → sender: ${sender}, message: "${text}"`);

        try {
            const response = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ sender, message: text }),
                headers: { 'Content-Type': 'application/json' }
            });
            console.log(`[APPS SCRIPT] Respuesta HTTP recibida. Status: ${response.status}`);

            const resJson = await response.json();
            console.log('[APPS SCRIPT] Body de respuesta:', JSON.stringify(resJson));

            if (resJson?.text) {
                await sock.sendMessage(remoteJid, { text: resJson.text });
                console.log('[WHATSAPP] Confirmación enviada al grupo.');
            } else {
                console.log('[APPS SCRIPT] La respuesta no tenía campo "text", no se envió confirmación al grupo.');
            }
        } catch (err) {
            console.error("[APPS SCRIPT ERROR]", err.message || err);
        }
    });
}

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
});

iniciarRaquel();
