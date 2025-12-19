import express, { Request, Response } from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import cors from 'cors';
import axios from 'axios';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 

// --- CACHE & CONFIG ---
const localMsgRetryMap = new Map<string, number>();
const msgRetryCounterCache = {
    get: (key: string) => { return localMsgRetryMap.get(key) },
    set: (key: string, value: number) => { localMsgRetryMap.set(key, value) },
    del: (key: string) => { localMsgRetryMap.delete(key) },
    flushAll: () => { localMsgRetryMap.clear() }
};

const sessions = new Map<string, any>();
const qrCodes = new Map<string, string>();

async function startSession(instanceId: string) {
    // Proteção extra contra pastas de sistema
    if (instanceId === 'lost+found' || instanceId === '.DS_Store') return;

    if (sessions.has(instanceId) && !sessions.get(instanceId).ws.isClosed) {
        return sessions.get(instanceId);
    }

    const sessionPath = path.join('auth_info_baileys', instanceId);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        msgRetryCounterCache: msgRetryCounterCache as any, 
        browser: ["InfoBarber", "Chrome", "120.0.6099.0"], 
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        fireInitQueries: false,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: true,
    });

    sessions.set(instanceId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`QR Code novo para: ${instanceId}`);
            qrCodes.set(instanceId, qr);
        }

        if (connection === 'close') {
            const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
            console.log(`Conexão fechada: ${instanceId}. Razão: ${reason}`);

            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(() => startSession(instanceId), 3000);
            } else {
                sessions.delete(instanceId);
                qrCodes.delete(instanceId);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            console.log(`✅ Conexão estabelecida: ${instanceId}`);
            qrCodes.delete(instanceId);
        }
    });

    // --- WEBHOOK MONITOR (MODO INSPETOR) ---
    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && WEBHOOK_URL) {
                    
                    // 1. Log de Raio-X (Para descobrirmos onde está o número)
                    console.log('🔍 RAIO-X DA MENSAGEM:', JSON.stringify(msg, null, 2));

                    const remoteJid = msg.key.remoteJid;
                    const participant = msg.key.participant; // Em alguns casos o número tá aqui

                    // Tenta achar o número real (Fallback)
                    // Se o remoteJid for LID, tenta pegar do participant. Se não tiver, usa o LID mesmo.
                    let senderNumber = remoteJid.split('@')[0];
                    
                    if (remoteJid.includes('@lid') && participant) {
                        senderNumber = participant.split('@')[0];
                        console.log(`💡 Achei o número real no participant: ${senderNumber}`);
                    }

                    try {
                        const payload = {
                            event: "webhookReceived",
                            instanceId: instanceId,
                            connectedPhone: sock?.user?.id?.split(':')[0],
                            sender: senderNumber, // Manda o melhor número que achamos
                            rawId: remoteJid,     // Manda o ID original também pra debug
                            msgContent: msg.message?.conversation || msg.message?.extendedTextMessage?.text
                        };

                        if (!payload.msgContent) continue; 

                        console.log(`📤 Enviando para Supabase: ${payload.sender} diz "${payload.msgContent}"`);
                        
                        // Envia para o Supabase
                        await axios.post(WEBHOOK_URL, payload);
                        
                    } catch (e: any) {
                        console.error(`❌ ERRO WEBHOOK: ${e.message}`);
                    }
                }
            }
        }
    });

    return sock;
}

// Inicia sessões salvas (Auto-Start Corrigido)
if (fs.existsSync('auth_info_baileys')) {
    const existingSessions = fs.readdirSync('auth_info_baileys');
    existingSessions.forEach(id => {
        const fullPath = path.join('auth_info_baileys', id);
        // IGNORA ARQUIVOS DE SISTEMA E lost+found
        if (id !== '.DS_Store' && id !== 'lost+found' && fs.statSync(fullPath).isDirectory()) {
            console.log(`Restaurando sessão: ${id}`);
            startSession(id);
        }
    });
}

// --- ROTAS API ---

app.get('/v1/instance/status-instance', (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string;
    if (!instanceId) return res.status(400).json({ error: true, message: "instanceId obrigatório" });
    const session = sessions.get(instanceId);
    const isConnected = !!(session && session.user);
    return res.json({ error: false, instanceId: instanceId, connected: isConnected });
});

app.get('/v1/instance/qr-code', async (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string;
    if (!instanceId) return res.status(400).json({ error: true, message: "Falta instanceId" });

    if (!sessions.has(instanceId)) await startSession(instanceId);
    await new Promise(r => setTimeout(r, 2000));

    const session = sessions.get(instanceId);
    if (session?.user) return res.json({ error: false, connected: true });

    const qr = qrCodes.get(instanceId);
    if (!qr) return res.status(404).json({ error: true, message: "Aguardando QR..." });

    const base64Image = await QRCode.toDataURL(qr);
    return res.json({ error: false, instanceId, qrcode: base64Image });
});

app.post('/v1/message/send-text', async (req: Request, res: Response): Promise<any> => {
    const { phone, message, instanceId } = req.body;
    const target = instanceId || req.query.instanceId;

    if (!target || !sessions.has(target as string)) {
        return res.status(404).json({ error: true, message: "Instância desconectada" });
    }

    const sock = sessions.get(target as string);
    try {
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        const result = await sock.sendMessage(jid, { text: message });
        return res.json({ error: false, messageId: result.key.id });
    } catch (error) {
        console.error("Erro ao enviar msg:", error);
        return res.status(500).json({ error: true });
    }
});

app.get('/v1/instance/reset', async (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string;
    if (!instanceId) return res.status(400).send("Falta instanceId");

    if (sessions.has(instanceId)) {
        try { sessions.get(instanceId).end(undefined); } catch(e){}
        sessions.delete(instanceId);
        qrCodes.delete(instanceId);
    }
    const p = path.join('auth_info_baileys', instanceId);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    return res.json({ message: "Resetado com sucesso." });
});

app.get('/connect', async (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string;
    if (!instanceId) return res.send("Use ?instanceId=SEU_ID");

    if (!sessions.has(instanceId)) await startSession(instanceId);
    await new Promise(r => setTimeout(r, 2000));

    const session = sessions.get(instanceId);
    if (session?.user) return res.send("<h1 style='color:green'>CONECTADO! ✅ Pode fechar.</h1>");

    const qr = qrCodes.get(instanceId);
    if (!qr) return res.send("<meta http-equiv='refresh' content='2'><h2>Gerando QR... aguarde...</h2>");
    const img = await QRCode.toDataURL(qr);
    return res.send(`<div style="text-align:center"><h2>Escaneie para Conectar</h2><img src="${img}" width="300" /></div>`);
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));