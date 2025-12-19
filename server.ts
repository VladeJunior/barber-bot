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

// --- CACHE DE RETRY (Correção TypeScript) ---
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
    // Se a sessão existe e o socket está aberto, retorna ela
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
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
            }
        } else if (connection === 'open') {
            console.log(`✅ Conexão estabelecida: ${instanceId}`);
            qrCodes.delete(instanceId);
        }
    });

    // WEBHOOK
    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && WEBHOOK_URL) {
                    try {
                        await axios.post(WEBHOOK_URL, {
                            event: "webhookReceived",
                            instanceId: instanceId,
                            connectedPhone: sock?.user?.id?.split(':')[0],
                            msgContent: msg.message?.conversation || msg.message?.extendedTextMessage?.text
                        });
                    } catch (e) {
                        // Silencia erro de webhook
                    }
                }
            }
        }
    });

    return sock;
}

// Inicia sessões salvas (Auto-Start)
if (fs.existsSync('auth_info_baileys')) {
    const existingSessions = fs.readdirSync('auth_info_baileys');
    existingSessions.forEach(id => {
        if (id !== '.DS_Store' && fs.statSync(path.join('auth_info_baileys', id)).isDirectory()) {
            console.log(`Restaurando: ${id}`);
            startSession(id);
        }
    });
}

// --- ROTAS API ---

// 1. Rota de Status (NOVA - A que faltava)
app.get('/v1/instance/status-instance', (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string;
    
    if (!instanceId) return res.status(400).json({ error: true, message: "instanceId obrigatório" });

    const session = sessions.get(instanceId);
    
    // Verifica se a sessão existe na memória E se tem usuário logado
    const isConnected = !!(session && session.user);

    return res.json({
        error: false,
        instanceId: instanceId,
        connected: isConnected
    });
});

// 2. Rota QR Code
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

// 3. Enviar Mensagem
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
        return res.status(500).json({ error: true });
    }
});

// 4. Rota de Reset
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

// 5. Rota Visual HTML
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
    return res.send(`
        <div style="text-align:center; font-family:sans-serif;">
            <h2>Escaneie para Conectar</h2>
            <img src="${img}" width="300" />
            <br><br>
            <p>Se der erro no celular, tente novamente.</p>
            <script>setTimeout(()=>location.reload(), 5000)</script>
        </div>
    `);
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));