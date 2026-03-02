require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');

const openai = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com'
});

// OpenAI Real para Whisper (Áudio)
const openaiWhisper = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// --- CARREGAMENTO DE CONFIGURAÇÕES SALVAS (Painel Administrativo) ---
const configPath = path.join(__dirname, 'bot-config.json');
const personalityPath = path.join(__dirname, 'personalidade.txt');

let lastQrCode = ""; // Armazena o último QR Code gerado para exibir no painel

let botConfig = {
    active: true,
    prompt: `Você é a iSti, assistente virtual da iStore. Responda de forma simpática usando seu emoji 💁🏻‍♀️. (O restante da personalidade é lido do arquivo personalidade.txt)`,
    schedule: { start: '18:00', end: '08:00', weekend: true, weekday24h: false, autoReturnMinutes: 10 },
    notificationEmail: '',
    clientesMudos: {}
};

// Se já existir configuração salva, carregar
if (fs.existsSync(configPath)) {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    botConfig = { ...botConfig, ...saved };
}

// Se o arquivo de personalidade existir, ele tem prioridade para o campo prompt
if (fs.existsSync(personalityPath)) {
    botConfig.prompt = fs.readFileSync(personalityPath, 'utf8');
}

// Persistência de quem está com humano
function saveGlobalConfig() {
    fs.writeFileSync(configPath, JSON.stringify(botConfig, null, 2));
    // Salva também a personalidade em um arquivo de texto separado
    fs.writeFileSync(personalityPath, botConfig.prompt, 'utf8');
}

// Lista de clientes em modo humano (permanente)
if (!botConfig.clientesMudos) botConfig.clientesMudos = {};

// Histórico Global para o Painel
let chatHistoryPanel = [];
function addHistory(type, text, phone) {
    chatHistoryPanel.push({ type, text: type === 'user' ? `${phone}: ${text}` : `iSti: ${text}`, timestamp: Date.now() });
    if (chatHistoryPanel.length > 20) chatHistoryPanel.shift();
}

// --- SERVIDOR DO PAINEL WEB ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.get('/api/config', (req, res) => res.json(botConfig));
app.post('/api/config', (req, res) => {
    const data = req.body;
    botConfig = { ...botConfig, ...data };
    saveGlobalConfig();
    res.json({ success: true });
});
app.get('/api/history', (req, res) => res.json(chatHistoryPanel));
app.get('/api/qr', (req, res) => res.json({ qr: lastQrCode }));
app.post('/api/test-email', async (req, res) => {
    if (!botConfig.notificationEmail) return res.status(400).json({ error: 'E-mail não configurado no painel.' });
    try {
        await sendTransferEmail('TESTE-BOT@c.us', 'Usuário de Teste');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Painel Administrativo da iSti rodando em: http://localhost:${PORT}`);
});


console.log("🛠️ Inicializando APIs e Verificando Credenciais...");
console.log("Estado das variáveis:", {
    GEMINI: process.env.GEMINI_API_KEY ? "✅ OK" : "❌ Faltando",
    SUPABASE: process.env.SUPABASE_URL ? "✅ OK" : "❌ Faltando",
    OPENAI: process.env.OPENAI_API_KEY ? "✅ OK" : "❌ Faltando",
    PORTA: process.env.PORT || 3000
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Retorna se o bot deve responder baseado no horário ou se está manually desativado
function shouldBotRespond() {
    if (!botConfig.active) return false;

    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const day = d.getDay();

    if (botConfig.schedule.weekend && (day === 0 || day === 6)) return true;
    if (botConfig.schedule.weekday24h && (day >= 1 && day <= 5)) return true;

    const current = d.getHours() * 60 + d.getMinutes();
    const [startH, startM] = botConfig.schedule.start.split(':').map(Number);
    const [endH, endM] = botConfig.schedule.end.split(':').map(Number);

    console.log(`⏱️ Verificando horário: Agora ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}. Atendimento das ${botConfig.schedule.start} às ${botConfig.schedule.end}`);
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;

    let respond = false;
    if (start > end) {
        respond = current >= start || current <= end;
    } else {
        respond = current >= start && current <= end;
    }

    if (!respond) {
        console.log(`🕒 Bot FORA do horário de atendimento automático.`);
    } else {
        console.log(`🕒 Bot DENTRO do horário de atendimento automático.`);
    }
    return respond;
}

// --- CONFIGURAÇÃO DE E-MAIL ---
const mailTransporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: process.env.MAIL_PORT || 465,
    secure: true,
    family: 4, // Força o uso de IPv4 para evitar erros ENETUNREACH (IPv6) no Railway/Docker
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
    },
    tls: {
        servername: process.env.MAIL_HOST || 'smtp.gmail.com'
    }
});

async function sendTransferEmail(phone, customerName) {
    // Definimos o envio em uma Promise que não trava o fluxo principal
    return new Promise((resolve, reject) => {
        const mailOptions = {
            from: `"iSti Alert 🤖" <${process.env.MAIL_USER}>`,
            to: botConfig.notificationEmail || process.env.MAIL_USER,
            subject: `🚨 Transferência: ${customerName}`,
            text: `Um cliente solicitou atendimento humano.\n\n` +
                `Nome/Info: ${customerName}\n` +
                `Telefone: ${phone}\n` +
                `Link direto: https://wa.me/${phone.split('@')[0]}\n\n` +
                `A iSti foi pausada para este número por ${botConfig.schedule.autoReturnMinutes || 10} minutos.`
        };

        mailTransporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error(`❌ Erro ao enviar e-mail: ${error.message}`);
                return reject(error);
            }
            console.log(`📧 E-mail de notificação enviado com sucesso!`);
            resolve(info);
        });
    });
}

async function consultarEstoqueTexto() {
    try {
        const { data: produtos, error } = await supabase
            .from('products')
            .select('name, model, color, storage, condition, price, stock, batteryHealth, warranty, storageLocation')
            .gt('stock', 0);

        if (error) return 'Estoque indisponível.';
        if (!produtos || produtos.length === 0) return 'Estoque zerado.';

        // Extrai GB do nome caso o campo storage esteja vazio
        function extrairStorage(p) {
            if (p.storage) {
                const val = Number(p.storage);
                if (val >= 1000) return (val / 1000) + 'TB';
                return String(val);
            }
            const nomeParaBusca = p.name || p.model || '';
            const match = nomeParaBusca.match(/(\d+)\s*(GB|TB)/i);
            if (match) {
                if (match[2].toUpperCase() === 'TB') return match[1] + 'TB';
                return match[1];
            }
            return '';
        }

        // Formata preço corretamente: R$ 8.479,99
        function formatarPreco(price) {
            if (!price) return 'R$ 0,00';
            return 'R$ ' + Number(price).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        const estoqueAgrupado = {};
        produtos.forEach(p => {
            const local = (p.storageLocation || '').toLowerCase();
            // REGRA: Se o local for "assistência", nunca mostrar ao cliente
            if (local.includes('assistência') || local.includes('assistencia')) return;

            const nomeCompleto = p.model || p.name || 'Produto sem nome';
            const nomeBase = nomeCompleto
                .replace(/\s*\d+\s*(GB|TB)/i, '')
                .replace(/\s*(Azul Profundo|Laranja Cósmico|Prateado|Titânio Natural|Titânio Preto|Titânio Branco|Titânio Azul|Titânio Areia|Meia-?noite|Estelar|Cinza Espacial|Dourado|Verde|Azul|Roxo|Amarelo|Rosa|Preto|Branco|Vermelho|Black|Midnight|Starlight|Silver)\s*$/i, '')
                .trim();
            const storageVal = extrairStorage(p);
            const cor = p.color || 'padrão';
            const condicao = p.condition || 'Novo';
            const garantia = (p.warranty || '').toLowerCase().trim();

            const chave = `${nomeBase.toLowerCase()}-${cor.toLowerCase()}-${storageVal.toLowerCase()}-${condicao.toLowerCase()}-${local}`;

            if (!estoqueAgrupado[chave]) {
                let display = nomeBase;
                const storageStr = storageVal.includes('TB') ? storageVal : (storageVal ? `${storageVal}GB` : '');
                if (storageStr && !display.includes(storageStr)) display += ` ${storageStr}`;
                display += ` (${cor} / ${condicao})`;

                // Formata o local para exibição amigável ao cliente
                let localDisplay = "Loja Santa Cruz";
                if (local.includes('caruaru')) localDisplay = "Caruaru";

                estoqueAgrupado[chave] = {
                    display,
                    price: p.price,
                    location: localDisplay,
                    warranty: garantia ? ` [Garantia: ${garantia}]` : '',
                    battery: condicao !== 'Novo' && p.batteryHealth ? ` [Saúde: ${p.batteryHealth}%]` : ''
                };
            }
        });

        const getPriority = (name) => {
            const n = name.toLowerCase();
            if (n.includes('bateria') || n.includes('tela') || n.includes('peça') || n.includes('acessórios')) return 10;
            if (n.includes('iphone')) return 1;
            if (n.includes('ipad')) return 2;
            if (n.includes('watch')) return 3;
            if (n.includes('mac')) return 4;
            if (n.includes('airpods')) return 5;
            return 6;
        };

        const sorted = Object.values(estoqueAgrupado)
            .sort((a, b) => {
                const prioA = getPriority(a.display);
                const prioB = getPriority(b.display);
                if (prioA !== prioB) return prioA - prioB;
                return a.display.localeCompare(b.display);
            })
            .slice(0, 800);

        const listaFinal = sorted.map(item => `- ${item.display}${item.battery}${item.warranty} [Local: ${item.location}] -> ${formatarPreco(item.price)}`);
        return `[ESTOQUE ATUAL]\n${listaFinal.join('\n')}`;
    } catch (err) {
        return 'Erro interno ao ler estoque.';
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--hide-scrollbars',
            '--disable-notifications',
            '--disable-extensions'
        ]
    }
});

client.on('qr', async (qr) => {
    qrcode.generate(qr, { small: true });
    // Gera versão em imagem (Base64) para o painel administrativo
    const QRCodeLib = require('qrcode');
    lastQrCode = await QRCodeLib.toDataURL(qr);
    console.log("🆕 Novo QR Code gerado para o Painel Administrativo.");
});

client.on('ready', () => {
    lastQrCode = ""; // Limpa o QR Code após conectar
    console.log('✅ Tudo pronto! A iSti está rodando no WhatsApp!');
});

const historicoChats = {};
const botRespondendo = {};
const botSentMsgIds = new Set();
const usuariosSendoProcessados = new Set();

client.on('message_create', async (msg) => {
    if (msg.to && (msg.to.includes('@g.us') || msg.to.includes('@broadcast'))) return;
    if (!msg.fromMe) return;
    const numeroCliente = msg.to;
    if (botRespondendo[numeroCliente] || botSentMsgIds.has(msg.id._serialized)) {
        botSentMsgIds.delete(msg.id._serialized);
        return;
    }
    const texto = msg.body.trim().toLowerCase();
    if (texto === '/retomar') {
        if (botConfig.clientesMudos[numeroCliente]) {
            delete botConfig.clientesMudos[numeroCliente];
            saveGlobalConfig();
            try { await msg.delete(true); } catch (e) { }
            try {
                const meuNumero = client.info.wid._serialized;
                await client.sendMessage(meuNumero, `✅ iSti retomada para @${numeroCliente.split('@')[0]}!`);
            } catch (e) { }
        }
        return;
    }
    if (numeroCliente && numeroCliente.includes('@c.us')) {
        botConfig.clientesMudos[numeroCliente] = Date.now();
        saveGlobalConfig();
    }
});

client.on('message', async (msg) => {
    const numeroCliente = msg.from;
    const textoOriginal = msg.body || "";
    console.log(`📩 [${new Date().toLocaleTimeString()}] Mensagem de ${numeroCliente}: "${textoOriginal}"`);
    if (numeroCliente.includes('@g.us') || numeroCliente.includes('@broadcast')) return;

    if (usuariosSendoProcessados.has(numeroCliente)) {
        console.log(`⏳ Ignorando msg de ${numeroCliente} (em processamento).`);
        return;
    }

    if (botConfig.clientesMudos[numeroCliente]) {
        const minutosPassados = (Date.now() - botConfig.clientesMudos[numeroCliente]) / 1000 / 60;
        if (minutosPassados >= (botConfig.schedule.autoReturnMinutes || 10)) {
            delete botConfig.clientesMudos[numeroCliente];
            saveGlobalConfig();
        } else return;
    }

    if (!shouldBotRespond()) {
        console.log(`🚫 Ignorando msg de ${numeroCliente} (Bot configurado para NÃO responder agora).`);
        return;
    }

    const telefoneVistoPanel = numeroCliente.replace('@c.us', '');
    if (!msg.hasMedia) addHistory('user', textoOriginal, telefoneVistoPanel);
    else addHistory('user', "[Enviou uma Mídia/Áudio]", telefoneVistoPanel);

    if (!historicoChats[numeroCliente]) {
        try {
            const chatObj = await msg.getChat();
            const lastMsgs = await chatObj.fetchMessages({ limit: 12 });
            historicoChats[numeroCliente] = lastMsgs
                .filter(m => m.body && m.type === 'chat' && !m.body.startsWith('/') && !m.body.includes('[[') && !m.body.includes('atendente entrou'))
                .map(m => ({ role: m.fromMe ? "assistant" : "user", content: m.body }));
        } catch (e) {
            historicoChats[numeroCliente] = [];
        }
    }

    usuariosSendoProcessados.add(numeroCliente);

    try {
        const regexLink = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
        const contemLink = regexLink.test(textoOriginal);
        // Detecta se é um post do Instagram ou se a mensagem veio de um anúncio (muitas vezes contém links do FB/Insta)
        const ehInstagram = textoOriginal.toLowerCase().includes('instagram.com') ||
            textoOriginal.toLowerCase().includes('facebook.com') ||
            (msg.type === 'image' && textoOriginal.includes('http')) ||
            msg.type === 'product' || msg.type === 'list_response';

        let transcricaoAudio = "";
        let textoRespostaBot = "";
        let mensagemUsuario = textoOriginal;

        if (contemLink || ehInstagram) {
            console.log(`🔗 Link/Ad detectado de ${numeroCliente}. Redirecionando para humano.`);
            textoRespostaBot = "Oi! Sou a iSti, assistente virtual da iStore 💁🏻‍♀️.\n\nNotei que você enviou um link ou post! 🍎 Vou chamar um especialista agora mesmo para te atender. _Chamando vendedor… só um instante_ 🏃🏻‍♀️➡️ [[TRANSFERENCIA_HUMANA_CONFIRMADA]]";
        } else {
            const chatWs = await msg.getChat();
            await chatWs.sendStateTyping();

            // Processa mídia (áudio/imagem)
            console.log(`🔎 Verificando mídia: hasMedia=${msg.hasMedia}, type=${msg.type}`);
            if (msg.hasMedia || msg.type === 'audio' || msg.type === 'ptt') {
                const tmpPath = path.join(__dirname, `temp_audio_${Date.now()}.ogg`);
                try {
                    const media = await msg.downloadMedia();
                    if (media && (media.mimetype.includes('audio') || msg.type === 'ptt')) {
                        console.log(`🎤 Áudio recebido. Processando com OpenAI Whisper...`);
                        const buffer = Buffer.from(media.data, 'base64');
                        fs.writeFileSync(tmpPath, buffer);
                        const transcription = await openaiWhisper.audio.transcriptions.create({
                            file: fs.createReadStream(tmpPath),
                            model: "whisper-1",
                        });
                        transcricaoAudio = transcription.text;
                        console.log("✅ Whisper Transcreveu: ", transcricaoAudio);
                    } else if (media && media.mimetype.includes('image')) {
                        console.log(`📷 Imagem recebida. Processando com Gemini...`);
                        try {
                            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                            const promptImagem = "Descreva detalhadamente mas de forma resumida esta imagem e extraia os textos importantes. Se for sobre celular, tente identificar estado e cor. Você é os olhos da inteligência artificial iSti da loja iStore. Responda em português direto para o modelo base processar.";
                            const result = await model.generateContent([
                                promptImagem,
                                {
                                    inlineData: {
                                        data: media.data,
                                        mimeType: media.mimetype
                                    }
                                }
                            ]);
                            const imgDesc = result.response.text();
                            transcricaoAudio = `[O cliente enviou uma imagem. Descrição da imagem analisada: ${imgDesc}]`;
                            console.log("✅ Gemini descreveu a imagem: ", imgDesc);
                        } catch (imgErr) {
                            console.error("❌ ERRO NO GEMINI (IMAGEM):", imgErr.message);
                            transcricaoAudio = "[O cliente enviou uma imagem, mas ocorreu um erro na nuvem ao analisá-la.]";
                        }
                    }
                } catch (err) {
                    console.error("❌ ERRO NA MÍDIA:", err.message);
                    transcricaoAudio = "[Erro interno ao baixar mídia do WhatsApp]";
                } finally {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                }
            }

            mensagemUsuario = transcricaoAudio ? `${transcricaoAudio}\n${textoOriginal}`.trim() : textoOriginal;
            if (!mensagemUsuario && msg.hasMedia) mensagemUsuario = "[Mídia (Não foi possível analisar)]";

            const estoque = await consultarEstoqueTexto();
            const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: 'full', timeStyle: 'short' });

            const regrasAdicionais = `
[DATA/HORA ATUAL]
${agora} (Fuso de São Paulo)

[REGRAS CRÍTICAS DE NEGÓCIO]
1. PRO vs PRO MAX: NUNCA confunda modelos Pro com Pro Max. Eles têm tamanhos e preços DIFERENTES.
2. CPO = NOVO: Aparelhos CPO são NOVOS e LACRADOS. Se o cliente pedir "Novo", mostre os 'Novos' e os 'CPO'. Nunca mostre 'Seminovo' se pedirem Novo.
`;
            const promptSistema = `${botConfig.prompt}\n\n${regrasAdicionais}\n\n[RESPOSTAS CURTAS]\n\nESTOQUE:\n${estoque}`;

            const response = await openai.chat.completions.create({
                model: "deepseek-chat",
                messages: [{ role: "system", content: promptSistema }, ...historicoChats[numeroCliente], { role: "user", content: mensagemUsuario }],
            }, { timeout: 30000 });

            textoRespostaBot = response.choices[0].message.content;
        }

        // DETECÇÃO DE TRANSFERÊNCIA (Melhorada)
        const lowerBotText = textoRespostaBot.toLowerCase();
        const transferKeywords = [
            '[[transferencia_humana_confirmada]]',
            'chamando vendedor',
            'chamando um especialista',
            'chamando atendente',
            'vou chamar um atendente',
            'vou chamar o vendedor',
            'transferindo para um humano',
            'especialista humano'
        ];

        const isTransfer = transferKeywords.some(kw => lowerBotText.includes(kw));

        if (isTransfer) {
            console.log(`🚨 [TRANSFERÊNCIA] Gatilho detectado! Iniciando processo de e-mail para ${numeroCliente}`);
            botConfig.clientesMudos[numeroCliente] = Date.now();
            saveGlobalConfig();

            // Dispara e-mail
            try {
                const chat = await msg.getChat();
                const contact = await chat.getContact();
                const nomeCliente = contact.pushname || contact.name || `Cliente ${numeroCliente.split('@')[0]}`;

                console.log(`📧 Tentando enviar e-mail de transferência para: ${botConfig.notificationEmail || 'e-mail do sistema'}`);
                sendTransferEmail(numeroCliente, nomeCliente)
                    .then(info => console.log("✅ E-mail enviado com sucesso:", info.messageId))
                    .catch(e => console.error("❌ FALHA CRÍTICA NO E-MAIL:", e.message));

                if (client.info && client.info.wid) {
                    client.sendMessage(client.info.wid._serialized, `🚨 *ATENÇÃO:* Cliente @${numeroCliente.split('@')[0]} pediu humano!`).catch(() => { });
                }
            } catch (e) {
                console.error("❌ Erro ao preparar dados para e-mail:", e.message);
            }
        }

        // LIMPEZA DE TEXTO PARA O WHATSAPP
        textoRespostaBot = textoRespostaBot.replace(/\[\[.*?\]\]/g, '').trim();
        const regexFraseTransferencia = /[\[_]?Chamando vendedor[….]{1,3} só um instante[_\]]? \s*(🏃🏻‍♀️)?(➡️)?/gi;
        textoRespostaBot = textoRespostaBot.replace(regexFraseTransferencia, 'Chamando vendedor... só um instante 🏃🏻‍♀️');
        textoRespostaBot = textoRespostaBot.replace(/[\[\]_➡️]/g, '').trim();

        if (!textoRespostaBot) textoRespostaBot = "💁🏻‍♀️ Só um minutinho que vou verificar isso pra você! 🏃🏻‍♀️";

        // RESPONDE NO WHATSAPP
        botRespondendo[numeroCliente] = true;
        try {
            const sentMsg = await msg.reply(textoRespostaBot);
            botSentMsgIds.add(sentMsg.id._serialized);
            addHistory('bot', textoRespostaBot, 'iSti');
        } finally {
            setTimeout(() => { botRespondendo[numeroCliente] = false; }, 3000);
        }

        historicoChats[numeroCliente].push({ role: "user", content: mensagemUsuario });
        historicoChats[numeroCliente].push({ role: "assistant", content: textoRespostaBot });
        if (historicoChats[numeroCliente].length > 10) historicoChats[numeroCliente].shift();

    } catch (erro) {
        console.error('❌ Erro na iSti:', erro);
    } finally {
        usuariosSendoProcessados.delete(numeroCliente);
    }
});

console.log("🚀 Inicializando cliente WhatsApp...");
client.initialize();
