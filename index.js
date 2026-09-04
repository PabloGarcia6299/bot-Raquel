import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    initAuthCreds,
    BufferJSON,
    proto,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';
import http from 'http';
import pino from 'pino';
import QRCode from 'qrcode';

// NUEVO (v7): logger a nivel 'debug' para poder ver el detalle real de lo que
// pasa con la conexión y el envío de mensajes. Una vez que confirmemos que
// todo anda bien, lo podés volver a bajar a 'fatal' o 'silent'.
const logger = pino({ level: 'debug' });

// --- implementación propia del auth state sobre MongoDB ---
// Reemplaza a la librería "mongo-baileys" de la comunidad, que tenía un bug
// al guardar datos de tipo array (rompía el guardado de claves de sesión
// silenciosamente, lo cual probablemente causaba fallas al descifrar mensajes).
async function useMongoDBAuthState(collection) {
    const writeData = async (id, data) => {
        const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.replaceOne({ _id: id }, { _id: id, value: serialized }, { upsert: true });
    };

    const readData = async (id) => {
        const doc = await collection.findOne({ _id: id });
        if (!doc || doc.value === undefined) return null;
        return JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver);
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tareas = [];
                    for (const categoria in data) {
                        for (const id in data[categoria]) {
                            const value = data[categoria][id];
                            const key = `${categoria}-${id}`;
                            tareas.push(value ? writeData(key, value) : removeData(key));
                        }
                    }
                    await Promise.all(tareas);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}

// --- Guardamos el último QR como imagen para poder escanearlo desde el navegador ---
let currentQrDataUrl = null;

const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('OK');
        return;
    }

    if (req.url === '/qr') {
        if (currentQrDataUrl) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <html>
                <head><meta http-equiv="refresh" content="15"></head>
                <body style="text-align:center;font-family:sans-serif;margin-top:40px;">
                    <h2>Escaneá este código con WhatsApp</h2>
                    <p>WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
                    <img src="${currentQrDataUrl}" style="width:280px;height:280px;" />
                    <p>(la página se actualiza sola cada 15 segundos)</p>
                </body>
                </html>
            `);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="text-align:center;font-family:sans-serif;margin-top:40px;"><h2>Todavía no hay código QR disponible (o ya está vinculado).</h2></body></html>');
        }
    } else {
        res.end('Raquel Bot Activo');
    }
}).listen(PORT, () => {
    console.log(`[HTTP] Servidor escuchando en el puerto ${PORT}`);
});

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec";
const NUMERO_TELEFONO_BOT = "541167613040";
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('[FATAL] No se encontró la variable de entorno MONGODB_URI. Revisá "Environment" en Render.');
    process.exit(1);
}

// --- cliente de Mongo, se conecta una sola vez y se reutiliza ---
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

// NUEVO (v7): pequeño store en memoria de los mensajes que mandamos, para
// poder implementar el callback getMessage que Baileys 7 recomienda para
// reintentos, votos de encuesta y mensajes citados. Se auto-limpia para no
// acumular memoria indefinidamente.
const mensajesEnviados = new Map();
function guardarMensajeEnviado(key, content) {
    mensajesEnviados.set(key.id, content);
    if (mensajesEnviados.size > 200) {
        mensajesEnviados.delete(mensajesEnviados.keys().next().value);
    }
}

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

// --- envío con reintento para sock.sendMessage ---
async function enviarConReintento(jid, contenido, intentos = 2) {
    for (let i = 0; i < intentos; i++) {
        try {
            const msg = await sock.sendMessage(jid, contenido);
            if (msg?.key) guardarMensajeEnviado(msg.key, contenido);
            return true;
        } catch (err) {
            console.error(`[WHATSAPP SEND ERROR] intento ${i + 1}/${intentos}:`, err.message || err);
            if (i < intentos - 1) {
                await new Promise((r) => setTimeout(r, 3000));
            }
        }
    }
    return false;
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
        auth: {
            creds: state.creds,
            // NUEVO (v7): cachea las claves de sesión Signal en memoria para no
            // tener que reconstruir la sesión con cada dispositivo en cada
            // mensaje. Recomendado por Baileys 7 para mejorar el envío/recepción,
            // justo lo que nos venía fallando con los dispositivos @lid.
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        // NUEVO (v7): recomendado por Baileys para que los reintentos de envío,
        // los votos de encuesta y las citas de mensajes funcionen bien.
        getMessage: async (key) => {
            return mensajesEnviados.get(key.id);
        }
    });

    console.log('[SOCKET] Socket creado, esperando eventos de conexión...');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection) {
            console.log(`[STATUS] Estado: ${connection}`);
        }

        if (qr && !sock.authState.creds.registered) {
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr);
                console.log('\n====================================');
                console.log('📷 QR LISTO. Abrí esto en cualquier navegador para escanearlo:');
                console.log('https://bot-raquel.onrender.com/qr');
                console.log('====================================\n');
            } catch (err) {
                console.error('[QR ERROR] No se pudo generar la imagen del QR:', err.message || err);
            }
        }

        if (connection === 'close') {
            isConnecting = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const razon = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) || 'desconocida';
            console.log(`[DISCONNECT] Conexión cerrada. Código: ${statusCode} (${razon})`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('[AUTH] Sesión expirada o desvinculada. Limpiando MongoDB y generando QR nuevo...');
                await limpiarSesionMongo();
                setTimeout(iniciarRaquel, 5000);
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('[DISCONNECT] Error 440 (connectionReplaced): esperando 30s antes de reintentar para evitar otra colisión...');
                setTimeout(iniciarRaquel, 30000);
            } else {
                setTimeout(iniciarRaquel, 10000);
            }
        } else if (connection === 'open') {
            isConnecting = false;
            intentoNumero = 0;
            console.log('--------------------------------------------------');
            console.log('✅ ¡Raquel está conectada y lista en WhatsApp!');
            console.log('--------------------------------------------------');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') {
            console.log(`[FILTRO] Evento ignorado: tipo "${type}" no es "notify".`);
            return;
        }

        // NUEVO (v7): Baileys aclara que 'messages' puede traer más de un
        // mensaje por evento, así que ahora los recorremos a todos (antes solo
        // se miraba messages[0], lo que podía hacer perder mensajes).
        for (const msg of messages) {
            await procesarMensaje(msg);
        }
    });
}

async function procesarMensaje(msg) {
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

    // El identificador del remitente puede venir como número real
    // (...@s.whatsapp.net), como LID (...@lid, el ID anónimo que WhatsApp usa
    // ahora para algunos participantes de grupo) o, si vos mismo mandás desde
    // tu propio número, directamente en remoteJid.
    const rawSender = msg.key.participant || msg.key.remoteJid;
    const sender = rawSender.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '').split(':')[0];

    console.log(`[APPS SCRIPT] Enviando a Google Sheets → sender: ${sender}, message: "${text}"`);

    let resJson = null;
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ sender, message: text }),
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[APPS SCRIPT] Respuesta HTTP recibida. Status: ${response.status}`);

        const rawBody = await response.text();
        console.log('[APPS SCRIPT] Body crudo de respuesta:', rawBody);

        try {
            resJson = JSON.parse(rawBody);
        } catch (parseErr) {
            console.log('[APPS SCRIPT] La respuesta no es JSON válido, se ignora el parseo.');
        }
    } catch (err) {
        console.error("[APPS SCRIPT FETCH ERROR]", err.message || err);
    }

    if (resJson?.text) {
        const enviado = await enviarConReintento(remoteJid, { text: resJson.text });
        if (enviado) {
            console.log('[WHATSAPP] Confirmación enviada al grupo.');
        } else {
            console.error('[WHATSAPP] No se pudo enviar la confirmación tras los reintentos.');
        }
    } else {
        console.log('[APPS SCRIPT] No hay campo "text" utilizable, no se envió confirmación al grupo.');
    }
}

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
});

iniciarRaquel();
