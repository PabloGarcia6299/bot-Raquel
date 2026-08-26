const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');

// Configuración con tus datos
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxaRMvrEC_NQjxJjwmEgv8rVGymcYSZN2oFzopoG-8E_nKT2QS16FN4tJ2A6tZeCFM5/exec";
const NUMERO_TELEFONO_BOT = "541167613040";

let codigoSolicitado = false;
const mapaGrupos = new Map(); // Caché para evitar consultas repetidas de metadata

async function iniciarRaquel() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

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

        const remoteJid = msg.key.remoteJid;
        const esGrupo = remoteJid.endsWith('@g.us');

        // Ignorar chats privados
        if (!esGrupo) return;

        // Identificar el nombre del grupo
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

        // Evaluar si es el grupo objetivo "Gasto Familiares" o "Gastos Familiares"
        const esGrupoObjetivo = nombreGrupo.toLowerCase().includes("gasto");
        if (!esGrupoObjetivo) return;

        // Extraer el número real de quien envió el mensaje en el grupo
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
