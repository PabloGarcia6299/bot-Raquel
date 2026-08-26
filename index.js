const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const fetch = require('node-fetch');
const http = require('http');
const pino = require('pino');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Raquel Bot activo')).listen(PORT, () => {
    console.log(`Servidor HTTP escuchando en puerto ${PORT}`);
});

// ⚠️ Recordá reemplazar con tu URL de Apps Script terminada en /exec
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/TU_SCRIPT_ID/exec"; 
const NUMERO_TELEFONO_BOT = "541167613040";

const mapaGrupos = new Map();

async function iniciarRaquel() {
    if (fs.existsSync('auth_info_baileys/creds.json')) {
        try {
            const credsData = JSON.parse(fs.readFileSync('auth_info_baileys/creds.json', 'utf-8'));
            if (!credsData.registered) {
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
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    let solicitoCodigo = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !sock.authState.creds.registered && !solicitoCodigo) {
            solicitoCodigo = true;
            console.log('Socket estable. Aguardando 4 segundos para pedir código...');
            await new Promise(r => setTimeout(r, 4000));
            
            try {
                const code = await sock.requestPairingCode(NUMERO_TELEFONO_BOT);
                console.log('\n====================================');
                console.log('🔑 CÓDIGO DE VINCULACIÓN DE RAQUEL:', code);
                console.log('====================================\n');
            } catch (err) {
                console.error('Error al generar código:', err.message);
                solicitoCodigo = false;
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            solicitoCodigo = false;
            
            if (statusCode === 405 || statusCode === 401) {
                console.log('⚠️ WhatsApp aplicó restricción temporal (405). Pausando reintento 2 minutos...');
                setTimeout(iniciarRaquel, 120000);
            } else if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(iniciarRaquel, 10000);
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
                console.error("Error contactando Apps Script:", err);
            }
        }
    });
}

iniciarRaquel();
