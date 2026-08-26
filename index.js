const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const http = require('http');
const pino = require('pino');
const fs = require('fs');

// Servidor HTTP para mantener activo Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Raquel Bot está activo')).listen(PORT, () => {
    console.log(`Servidor HTTP escuchando en el puerto ${PORT}`);
});

// ⚠️ Reemplazá con tu URL desplegada de Apps Script (terminada en /exec)
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec"; 
const NUMERO_TELEFONO_BOT = "541167613040";

const mapaGrupos = new Map();

async function iniciarRaquel() {
    console.log('Iniciando proceso de conexión con WhatsApp...');

    // Limpieza de sesión incompleta previa si existiera
    if (fs.existsSync('auth_info_baileys/creds.json')) {
        try {
            const credsData = JSON.parse(fs.readFileSync('auth_info_baileys/creds.json', 'utf-8'));
            if (!credsData.registered) {
                console.log('Limpiando datos de sesión incompletos...');
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
            }
        } catch (e) {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'error' }),
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Si el número no está registrado, pide el código directamente tras dar tiempo a abrir la conexión
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                console.log('Solicitando código de vinculación a WhatsApp...');
                const code = await sock.requestPairingCode(NUMERO_TELEFONO_BOT);
                console.log('\n====================================');
                console.log('🔑 CÓDIGO DE VINCULACIÓN DE RAQUEL:', code);
                console.log('====================================\n');
            } catch (err) {
                console.error('Error al generar el código:', err.message);
            }
        }, 4000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection) {
            console.log(`Estado de conexión: ${connection}`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Conexión cerrada (código ${statusCode}). Reintentando en 5s...`);
            
            if (shouldReconnect) {
                setTimeout(iniciarRaquel, 5000);
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
