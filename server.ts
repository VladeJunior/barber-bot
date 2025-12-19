import express, { Request, Response } from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import cors from 'cors';
import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';
import qrcodeTerminal from 'qrcode-terminal';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// CONFIGURAÇÕES
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // URL do seu InfoBarber para receber respostas
const AUTH_FOLDER = 'auth_info_baileys';

// ESTADO GLOBAL (Para manter na memória)
let sock: any;
let qrCodeData: string | null = null;
let connectionStatus = 'disconnected';

// FUNÇÃO: Conectar ao WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.macOS('Desktop'), // Finge ser um Mac para não dar erro
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Novo QR Code gerado');
            // Transforma o QR Code em Base64 para enviar ao frontend igual a W-API faz
            qrCodeData = qr; 
            connectionStatus = 'qrcode_ready';

            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            connectionStatus = 'disconnected';
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Conexão aberta com sucesso!');
            connectionStatus = 'connected';
            qrCodeData = null; // Limpa o QR pois já conectou
        }
    });

    // LISTENER: Receber mensagens (Onde você cria o BOT depois)
    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && WEBHOOK_URL) {
                    // Aqui enviamos para o seu InfoBarber processar (se quiser)
                    // Formata um JSON parecido com o webhook da W-API
                    const webhookPayload = {
                        event: "webhookReceived",
                        connectedPhone: sock?.user?.id.split(':')[0],
                        messageId: msg.key.id,
                        fromMe: false,
                        sender: {
                            id: msg.key.remoteJid.split('@')[0],
                            pushName: msg.pushName
                        },
                        msgContent: {
                            text: msg.message?.conversation || msg.message?.extendedTextMessage?.text
                        }
                    };

                    try {
                        console.log('Enviando Webhook para:', WEBHOOK_URL);
                        // await axios.post(WEBHOOK_URL, webhookPayload);
                    } catch (e) {
                        console.error('Erro ao enviar webhook', e);
                    }
                }
            }
        }
    });
}

// INICIA A CONEXÃO
connectToWhatsApp();

// --- ROTAS DA API (ESPELHO DA W-API) ---

// 1. Rota de Enviar Texto (Instância LITE)
// POSTMAN: https://api.w-api.app/v1/message/send-text
app.post('/v1/message/send-text', async (req: Request, res: Response): Promise<any> => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: true, message: 'Phone e Message são obrigatórios' });
        }

        if (connectionStatus !== 'connected') {
            return res.status(503).json({ error: true, message: 'Instância não conectada' });
        }

        // Formata o número (Baileys precisa do sufixo @s.whatsapp.net)
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

        // Envia via Baileys
        const result = await sock.sendMessage(jid, { text: message });

        // RESPOSTA: Espelhando o formato da W-API
        return res.json({
            instanceId: "MEU-SISTEMA-PROPRIO",
            messageId: result.key.id,
            insertedId: "local-id-" + Date.now(), // Fake ID
            error: false
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: true, message: 'Erro ao enviar mensagem' });
    }
});

// 2. Rota de Pegar QR Code (Instância LITE)
// POSTMAN: https://api.w-api.app/v1/instance/qr-code
app.get('/v1/instance/qr-code', async (req: Request, res: Response) => {
    
    // Se já estiver conectado, avisa
    if (connectionStatus === 'connected') {
        return res.json({ error: false, message: "Instância já conectada", connected: true });
    }

    if (!qrCodeData) {
        return res.status(404).json({ error: true, message: "QR Code ainda não gerado. Aguarde..." });
    }

    // W-API retorna o base64 direto no JSON
    // A gente usa uma lib para gerar a imagem do QR Code em Base64
    const QRCode = require('qrcode');
    const base64Image = await QRCode.toDataURL(qrCodeData);

    return res.json({
        error: false,
        instanceId: "MEU-SISTEMA-PROPRIO",
        qrcode: base64Image // Formato: "data:image/png;base64,..."
    });
});

// 3. Rota de Status (Instância LITE)
// POSTMAN: https://api.w-api.app/v1/instance/status-instance
app.get('/v1/instance/status-instance', (req: Request, res: Response) => {
    return res.json({
        instanceId: "MEU-SISTEMA-PROPRIO",
        connected: connectionStatus === 'connected'
    });
});

// Inicia o servidor Express
app.listen(PORT, () => {
    console.log(`🚀 API Espelho W-API rodando na porta ${PORT}`);
    console.log(`👉 Endpoint Texto: http://localhost:${PORT}/v1/message/send-text`);
});