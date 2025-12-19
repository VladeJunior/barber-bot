import express, { Request, Response } from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
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

// --- GERENCIADOR DE SESSÕES (A MÁGICA ACONTECE AQUI) ---
// Mapeia "instanceId" -> Objeto da Conexão
const sessions = new Map<string, any>();
const qrCodes = new Map<string, string>(); // Guarda o QR Code de cada ID

// Função para iniciar uma sessão específica
async function startSession(instanceId: string) {
    // Se já existe e está conectado, não faz nada
    if (sessions.has(instanceId) && !sessions.get(instanceId).destroyed) {
        return sessions.get(instanceId);
    }

    const sessionPath = path.join('auth_info_baileys', instanceId);
    
    // Cria a pasta se não existir
    if (!fs.existsSync(sessionPath)){
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        // MUDANÇA 1: Usar Ubuntu/Chrome (mais estável em servidores Linux/Docker)
        browser: Browsers.ubuntu('Chrome'),
        // MUDANÇA 2: Aumentar timeouts para evitar que o celular desista
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 250,
        // MUDANÇA 3: Ignorar chamadas de histórico antigo (deixa mais leve)
        syncFullHistory: false 
    });

    // Salva na memória
    sessions.set(instanceId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`QR Code gerado para: ${instanceId}`);
            qrCodes.set(instanceId, qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Conexão fechada para ${instanceId}. Reconectando...`, shouldReconnect);
            
            if (shouldReconnect) {
                startSession(instanceId); // Tenta reconectar a mesma instância
            } else {
                console.log(`Logout definitivo de ${instanceId}`);
                sessions.delete(instanceId);
                qrCodes.delete(instanceId);
                // Opcional: Apagar a pasta de credenciais se quiser resetar total
            }
        } else if (connection === 'open') {
            console.log(`Conexão aberta para: ${instanceId}`);
            qrCodes.delete(instanceId); // Limpa o QR Code pois já conectou
        }
    });

    // WEBHOOK: Agora sabemos QUAL instância recebeu a mensagem
    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && WEBHOOK_URL) {
                    const webhookPayload = {
                        event: "webhookReceived",
                        instanceId: instanceId, // <--- AQUI ESTÁ A RESPOSTA DA SUA DÚVIDA
                        connectedPhone: sock?.user?.id?.split(':')[0],
                        messageId: msg.key.id,
                        sender: msg.key.remoteJid.split('@')[0],
                        msgContent: msg.message?.conversation || msg.message?.extendedTextMessage?.text
                    };
                    
                    try {
                        // Enviamos para o InfoBarber dizendo: "Essa msg chegou para a barbearia X"
                        await axios.post(WEBHOOK_URL, webhookPayload);
                    } catch (e) {
                        console.error('Erro webhook', e);
                    }
                }
            }
        }
    });

    return sock;
}

// Inicializa as pastas existentes ao ligar o servidor (Reconecta quem já estava salvo)
// Isso garante que se o servidor reiniciar, as barbearias voltam online sozinhas
if (fs.existsSync('auth_info_baileys')) {
    const existingSessions = fs.readdirSync('auth_info_baileys');
    existingSessions.forEach(id => {
        if (fs.statSync(path.join('auth_info_baileys', id)).isDirectory()) {
            console.log(`Restaurando sessão: ${id}`);
            startSession(id);
        }
    });
}

// --- ROTAS (Adaptação Multi-Tenant) ---

// 1. Pegar QR Code (Cria a instância se não existir)
// GET /v1/instance/qr-code?instanceId=barbearia_01
app.get('/v1/instance/qr-code', async (req: Request, res: Response) => {
    // Tenta pegar do query (?instanceId=...) ou do body (se for POST)
    const instanceId = req.query.instanceId as string || req.body.instanceId;

    if (!instanceId) {
        return res.status(400).json({ error: true, message: "instanceId é obrigatório" });
    }

    // Se a sessão não existe, cria agora (Lazy Loading)
    if (!sessions.has(instanceId)) {
        await startSession(instanceId);
    }

    // Aguarda um pouquinho para ver se conecta ou gera QR
    // (Gambiarra leve para dar tempo do Baileys gerar o primeiro QR)
    await new Promise(r => setTimeout(r, 1000));

    const session = sessions.get(instanceId);
    
    // Verifica status (se 'user' existe, está conectado)
    if (session?.user) {
        return res.json({ error: false, message: "Instância já conectada", connected: true });
    }

    const qr = qrCodes.get(instanceId);

    if (!qr) {
        return res.status(404).json({ error: true, message: "Gerando QR Code... Tente novamente em 2s" });
    }

    const base64Image = await QRCode.toDataURL(qr);
    return res.json({
        error: false,
        instanceId: instanceId,
        qrcode: base64Image
    });
});

// 2. Enviar Texto
// POST /v1/message/send-text
app.post('/v1/message/send-text', async (req: Request, res: Response): Promise<any> => {
    // Agora o InfoBarber PRECISA mandar o instanceId no JSON ou na URL
    const { phone, message, instanceId } = req.body; 
    // OBS: Se o InfoBarber manda instanceId na URL (query), use req.query.instanceId

    // Prioridade: Body > Query
    const targetInstance = instanceId || req.query.instanceId;

    if (!targetInstance || !sessions.has(targetInstance as string)) {
        return res.status(404).json({ error: true, message: "Instância não encontrada ou desconectada" });
    }

    const sock = sessions.get(targetInstance as string);

    // Verifica se está realmente conectado
    if (!sock.user) {
        return res.status(503).json({ error: true, message: "Instância existe mas não está conectada ao WhatsApp" });
    }

    try {
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        const result = await sock.sendMessage(jid, { text: message });

        return res.json({
            error: false,
            instanceId: targetInstance,
            messageId: result.key.id
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: true, message: "Erro ao enviar" });
    }
});

// 3. Status
app.get('/v1/instance/status-instance', (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string;
    
    if (!instanceId || !sessions.has(instanceId)) {
         return res.json({ instanceId: instanceId, connected: false });
    }

    const sock = sessions.get(instanceId);
    return res.json({
        instanceId: instanceId,
        connected: !!sock.user // Retorna true se tiver usuário logado
    });
});

// 4. Logout
app.post('/v1/instance/logout', async (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string || req.body.instanceId;
    
    if (instanceId && sessions.has(instanceId)) {
        const sock = sessions.get(instanceId);
        await sock.logout();
        sessions.delete(instanceId);
        qrCodes.delete(instanceId);
        // Removemos a pasta para garantir que o próximo login seja limpo
        const sessionPath = path.join('auth_info_baileys', instanceId);
        fs.rmSync(sessionPath, { recursive: true, force: true });
        
        return res.json({ error: false, message: "Desconectado" });
    }
    return res.json({ error: false, message: "Sessão não encontrada" });
});
// 5. Rota de Reset (Apaga a sessão e força novo QR Code)
// POST /v1/instance/reset?instanceId=barbearia_01
app.post('/v1/instance/reset', async (req: Request, res: Response) => {
    const instanceId = req.query.instanceId as string || req.body.instanceId;
    
    if (!instanceId) return res.status(400).json({ error: true, message: "instanceId obrigatório" });

    // 1. Desconecta se estiver rodando
    if (sessions.has(instanceId)) {
        const sock = sessions.get(instanceId);
        sock.end(undefined); // Encerra a conexão brutalmente
        sessions.delete(instanceId);
        qrCodes.delete(instanceId);
    }

    // 2. Apaga os arquivos físicos (O "Hard Reset")
    const sessionPath = path.join('auth_info_baileys', instanceId);
    if (fs.existsSync(sessionPath)) {
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`Pasta de sessão ${instanceId} apagada.`);
        } catch (e) {
            console.error("Erro ao apagar pasta:", e);
        }
    }

    return res.json({ 
        error: false, 
        message: `Instância ${instanceId} resetada. Pode pedir novo QR Code agora.` 
    });
});
// --- ROTA VISUAL (Para testar no navegador) ---
app.get('/connect', async (req: Request, res: Response) => {
    // Exige passar ?instanceId=nome_da_loja
    const instanceId = req.query.instanceId as string;
    if (!instanceId) return res.send("Informe ?instanceId=nome_da_loja na URL");

    // Lógica igual à do JSON, mas retorna HTML
    if (!sessions.has(instanceId)) await startSession(instanceId);
    await new Promise(r => setTimeout(r, 1000));
    const session = sessions.get(instanceId);
    
    if (session?.user) return res.send("<h1>Conectado!</h1>");
    const qr = qrCodes.get(instanceId);
    if (!qr) return res.send("Generating QR... Refresh page.");
    
    const base64Image = await QRCode.toDataURL(qr);
    return res.send(`<img src="${base64Image}" /> <script>setTimeout(()=>location.reload(), 5000)</script>`);
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor Multi-Tenant rodando na porta ${PORT}`);
});