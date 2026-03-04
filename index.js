require('dotenv').config();
const dns = require('dns');
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

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
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
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

// --- CONFIGURAÇÃO DE E-MAIL (MUDANÇA PARA RESEND) ---
async function sendTransferEmail(phone, customerName) {
    console.log(`📡 Iniciando envio de e-mail via Resend para ${customerName} (${phone})...`);
    try {
        const { data, error } = await resend.emails.send({
            from: 'iSti Alert <onboarding@resend.dev>',
            to: botConfig.notificationEmail || process.env.MAIL_USER,
            subject: `🚨 Transferência: ${customerName}`,
            text: `Um cliente solicitou atendimento humano.\n\n` +
                `Nome/Info: ${customerName}\n` +
                `Telefone: ${phone}\n` +
                `Link direto: https://wa.me/${phone.split('@')[0]}\n\n` +
                `A iSti foi pausada para este número por ${botConfig.schedule.autoReturnMinutes || 10} minutos.`
        });

        if (error) {
            console.error(`❌ ERRO NO RESEND:`, error);
            throw error;
        }

        console.log(`📧 E-mail ENVIADO via Resend! ID: ${data.id}`);
        return data;
    } catch (err) {
        console.error(`❌ FALHA CRÍTICA NO ENVIO (RESEND):`, err.message);
        throw err;
    }
}

async function consultarEstoqueTexto() {
    try {
        const { data: produtos, error } = await supabase
            .from('products')
            .select('name, model, color, storage, condition, price, stock, batteryHealth, warranty, storageLocation')
            .gt('stock', 0);

        if (error) return 'Estoque indisponível.';
        if (!produtos || produtos.length === 0) return 'Estoque zerado.';

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

        function formatarPreco(price) {
            if (!price) return 'R$ 0,00';
            return 'R$ ' + Number(price).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        // Agrupa variações únicas por "nome base" (ex: "iPhone 17 Pro Max")
        const famílias = {};
        const visto = new Set();

        produtos.forEach(p => {
            const local = (p.storageLocation || '').toLowerCase();
            if (local.includes('assistência') || local.includes('assistencia')) return;

            const nomeCompleto = p.model || p.name || 'Produto sem nome';
            const nomeBase = nomeCompleto
                .replace(/\s*\d+\s*(GB|TB)/i, '')
                .replace(/\s*(Azul Profundo|Azul Névoa|Laranja Cósmico|Prateado|Prata|Titânio Natural|Titânio Preto|Titânio Branco|Titânio Azul|Titânio Areia|Titânio Deserto|Meia-?noite|Estelar|Starlight|Lavanda|Lilás|Cinza Espacial|Dourado|Verde Alpino|Verde|Azul Céu|Azul|Roxo Profundo|Roxo|Amarelo|Rosa|Preto Espacial|Preto|Branco|Vermelho|Ultramarino|Black|Midnight|Silver|Grafite|Pacific Blue|Sierra Blue|Alpine Green|Deep Purple|Space Black|Natural Titanium|White Titanium|Black Titanium|Blue Titanium|Desert Titanium|Rose Gold|Branco\/Prata|\(PRODUCT\)RED)\s*$/i, '')
                .trim();

            const storageVal = extrairStorage(p);
            const cor = (p.color || '').trim() || 'padrão';
            const condicao = p.condition || 'Novo';
            const storageStr = storageVal ? (storageVal.includes('TB') ? storageVal : `${storageVal}GB`) : '';

            // Chave única para evitar duplicatas
            const chaveUnica = `${nomeBase.toLowerCase()}|${storageStr.toLowerCase()}|${cor.toLowerCase()}|${condicao.toLowerCase()}`;
            if (visto.has(chaveUnica)) return;
            visto.add(chaveUnica);

            if (!famílias[nomeBase]) famílias[nomeBase] = [];
            famílias[nomeBase].push({ storageStr, cor, condicao, price: p.price });
        });

        // Ordena famílias: iPhones primeiro
        const ordemFamilia = (nome) => {
            const n = nome.toLowerCase();
            if (n.includes('iphone')) return '1_' + nome;
            if (n.includes('ipad')) return '2_' + nome;
            if (n.includes('watch')) return '3_' + nome;
            if (n.includes('mac')) return '4_' + nome;
            if (n.includes('airpod')) return '5_' + nome;
            return '6_' + nome;
        };

        const familiasOrdenadas = Object.entries(famílias)
            .sort(([a], [b]) => ordemFamilia(a).localeCompare(ordemFamilia(b)));

        const blocos = familiasOrdenadas.map(([familia, variações]) => {
            const linhas = variações.map(v => {
                const gb = v.storageStr ? `${v.storageStr} ` : '';
                const cond = v.condicao !== 'Novo' ? ` [${v.condicao}]` : '';
                return `  • ${gb}${v.cor}${cond} — ${formatarPreco(v.price)}`;
            });
            return `[${familia}]\nOpções disponíveis (SOMENTE ESTAS, não existem outras):\n${linhas.join('\n')}`;
        });

        return blocos.join('\n\n');
    } catch (err) {
        return 'Erro interno ao ler estoque.';
    }
}



const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
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

// --- SISTEMA DE DEBOUNCE: Acumula mensagens picadas em janela de 3.5s ---
const debounceTimers = {};      // timeout por cliente
const mensagensPendentes = {};  // buffer de msgs por cliente
const ultimaMsgObj = {};        // último objeto msg por cliente (para getChat, getContact etc)

client.on('message_create', async (msg) => {
    if (msg.to && (msg.to.includes('@g.us') || msg.to.includes('@broadcast'))) return;
    if (!msg.fromMe) return;

    const numeroCliente = msg.to;

    // Se a mensagem foi gerada pelo próprio código do bot, ignoramos o silenciamento
    if (botSentMsgIds.has(msg.id._serialized) || botRespondendo[numeroCliente]) {
        botSentMsgIds.delete(msg.id._serialized);
        return;
    }

    const texto = (msg.body || "").trim().toLowerCase();

    // Comando manual para retomar o bot
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

    // Se o humano mandou qualquer outra coisa, silencia o bot
    if (numeroCliente && numeroCliente.includes('@c.us')) {
        botConfig.clientesMudos[numeroCliente] = Date.now();
        saveGlobalConfig();
        console.log(`👤 [INTERVENÇÃO] Humano assumiu a conversa com ${numeroCliente}. Bot silenciado.`);
    }
});

// ============================================================
// FUNÇÃO CENTRAL: Processa todas as mensagens acumuladas de um
// cliente e gera uma única resposta da IA.
// ============================================================
async function processarMensagens(numeroCliente) {
    const msgs = mensagensPendentes[numeroCliente] || [];
    const msgRef = ultimaMsgObj[numeroCliente];
    delete mensagensPendentes[numeroCliente];
    delete ultimaMsgObj[numeroCliente];

    if (!msgs.length || !msgRef) return;

    if (botConfig.clientesMudos[numeroCliente]) {
        const minutosPassados = (Date.now() - botConfig.clientesMudos[numeroCliente]) / 1000 / 60;
        if (minutosPassados >= (botConfig.schedule.autoReturnMinutes || 10)) {
            delete botConfig.clientesMudos[numeroCliente];
            saveGlobalConfig();
        } else {
            console.log(`🔇 Bot mudo para ${numeroCliente}. Ignorando mensagens acumuladas.`);
            return;
        }
    }

    if (!shouldBotRespond()) {
        console.log(`🚫 Fora do horário. Ignorando msgs acumuladas de ${numeroCliente}.`);
        return;
    }

    // Inicializa histórico carregando do WhatsApp se necessário
    if (!historicoChats[numeroCliente]) {
        try {
            const chatObj = await msgRef.getChat();
            const lastMsgs = await chatObj.fetchMessages({ limit: 12 });
            historicoChats[numeroCliente] = lastMsgs
                .filter(m => m.body && m.type === 'chat' && !m.body.startsWith('/') && !m.body.includes('[[') && !m.body.includes('atendente entrou'))
                .map(m => ({ role: m.fromMe ? "assistant" : "user", content: m.body }));
        } catch (e) {
            historicoChats[numeroCliente] = [];
        }
    }

    // Adiciona ao histórico do painel
    const telefoneVistoPanel = numeroCliente.replace('@c.us', '');
    msgs.forEach(({ texto, temMidia }) => {
        if (!temMidia) addHistory('user', texto, telefoneVistoPanel);
        else addHistory('user', "[Enviou uma Mídia/Áudio]", telefoneVistoPanel);
    });

    try {
        const chatWs = await msgRef.getChat();
        await chatWs.sendStateTyping();

        // --- Processa todas as mensagens acumuladas ---
        let partesMensagem = [];
        let houveTranscricao = false;

        for (const { msg, texto } of msgs) {
            const regexLink = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/gi;
            const contemLink = regexLink.test(texto);
            const ehInstagram = texto.toLowerCase().includes('instagram.com') ||
                texto.toLowerCase().includes('facebook.com') ||
                (msg.type === 'image' && texto.includes('http')) ||
                msg.type === 'product' || msg.type === 'list_response';

            if (contemLink || ehInstagram) {
                console.log(`🔗 Link/Ad detectado de ${numeroCliente}. Redirecionando para humano.`);
                const textoTransfer = "Oi! Sou a iSti, assistente virtual da iStore 💁🏻‍♀️.\n\nNotei que você enviou um link ou post! 🍎 Vou chamar um especialista agora mesmo para te atender. _Chamando vendedor… só um instante_ 🏃🏻‍♀️➡️ [[TRANSFERENCIA_HUMANA_CONFIRMADA]]";
                await enviarRespostaWhatsApp(numeroCliente, textoTransfer, msgRef, msgs);
                return;
            }

            // Processa mídias
            if (msg.hasMedia || msg.type === 'audio' || msg.type === 'ptt') {
                const tmpPath = path.join(__dirname, `temp_audio_${Date.now()}.ogg`);
                try {
                    const media = await msg.downloadMedia();
                    if (media && (media.mimetype.includes('audio') || msg.type === 'ptt')) {
                        console.log(`🎤 Áudio recebido. Processando com Whisper...`);
                        const buffer = Buffer.from(media.data, 'base64');
                        fs.writeFileSync(tmpPath, buffer);
                        const transcription = await openaiWhisper.audio.transcriptions.create({
                            file: fs.createReadStream(tmpPath),
                            model: "whisper-1",
                        });
                        partesMensagem.push(transcription.text);
                        houveTranscricao = true;
                        console.log("✅ Whisper Transcreveu:", transcription.text);
                    } else if (media && media.mimetype.includes('image')) {
                        console.log(`📷 Imagem recebida. Processando com Gemini...`);
                        try {
                            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                            const promptImagem = "Descreva detalhadamente mas de forma resumida esta imagem e extraia os textos importantes. Se for sobre celular, tente identificar estado e cor. Você é os olhos da inteligência artificial iSti da loja iStore. Responda em português direto para o modelo base processar.";
                            const result = await model.generateContent([promptImagem, { inlineData: { data: media.data, mimeType: media.mimetype } }]);
                            const imgDesc = result.response.text();
                            partesMensagem.push(`[O cliente enviou uma imagem. Descrição: ${imgDesc}]`);
                            console.log("✅ Gemini descreveu a imagem:", imgDesc);
                        } catch (imgErr) {
                            console.error("❌ ERRO GEMINI (IMAGEM):", imgErr.message);
                            partesMensagem.push("[O cliente enviou uma imagem, mas ocorreu um erro ao analisá-la.]");
                        }
                    }
                } catch (err) {
                    console.error("❌ ERRO NA MÍDIA:", err.message);
                    partesMensagem.push("[Erro interno ao baixar mídia]");
                } finally {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                }
            } else if (texto) {
                partesMensagem.push(texto);
            }
        }

        let mensagemUsuario = partesMensagem.filter(Boolean).join('\n');
        if (!mensagemUsuario) mensagemUsuario = "[Mídia (Não foi possível analisar)]";

        if (msgs.length > 1) {
            console.log(`📦 [DEBOUNCE] Agrupadas ${msgs.length} mensagens de ${numeroCliente} em uma única chamada à IA.`);
        }

        const estoque = await consultarEstoqueTexto();
        const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: 'full', timeStyle: 'short' });

        const regrasAdicionais = `
[DATA/HORA ATUAL]
${agora} (Fuso de São Paulo)

[REGRAS CRÍTICAS DE NEGÓCIO]
1. PRO vs PRO MAX: NUNCA confunda modelos Pro com Pro Max. Eles têm tamanhos e preços DIFERENTES.
2. CPO = NOVO: Aparelhos CPO são NOVOS e LACRADOS. Se o cliente pedir "Novo", mostre os 'Novos' e os 'CPO'. Nunca mostre 'Seminovo' se pedirem Novo.
3. CORES REAIS: Use APENAS as cores que aparecem no "ESTOQUE ATUAL". É PROIBIDO inventar cores padrão (Preto, Branco, etc) se elas não estiverem listadas para o modelo exato.
4. ESTOQUE ESTRITO: Se o cliente perguntar se tem "todas as cores", mas o estoque listar apenas uma ou duas, diga quais são e NÃO confirme que tem todas.
`;
        const blocoEstoque = `
================================================================================
⚠️ ESTOQUE REAL DA LOJA — LEITURA OBRIGATÓRIA E LITERAL ⚠️
================================================================================
ATENÇÃO: A lista abaixo é O ÚNICO estoque existente. NÃO existe nenhum produto,
modelo, cor, GB ou variação que não esteja nesta lista. É ESTRITAMENTE PROIBIDO
mencionar ou confirmar qualquer produto que não apareça aqui.
Ignorar esta lista e usar conhecimento próprio é um ERRO CRÍTICO.
================================================================================

${estoque}

================================================================================
FIM DO ESTOQUE — NÃO HÁ MAIS NENHUM PRODUTO ALÉM DOS LISTADOS ACIMA.
================================================================================
`;
        const promptSistema = `${botConfig.prompt}\n\n${regrasAdicionais}\n\n[REGRA DE AMBIGUIDADE]\nSe o cliente pedir um modelo genérico (ex: "iPhone 17"), e existirem variações (Normal, Pro, Pro Max) no estoque, você OBRIGATORIAMENTE deve listar as categorias disponíveis e perguntar qual versão ele deseja. NUNCA assuma que ele quer o Pro Max ou o Normal.\n\n${blocoEstoque}`;

        const response = await openai.chat.completions.create(
            {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: promptSistema }, ...historicoChats[numeroCliente], { role: "user", content: mensagemUsuario }]
            },
            { timeout: 45000 }
        );

        const textoRespostaBot = response.choices[0].message.content;
        await enviarRespostaWhatsApp(numeroCliente, textoRespostaBot, msgRef, msgs, mensagemUsuario);

    } catch (erro) {
        console.error('❌ Erro na iSti (processarMensagens):', erro);
    }
}

// ============================================================
// FUNÇÃO AUXILIAR: Realiza limpeza do texto, detecta transferência
// e dispara a mensagem final no WhatsApp.
// ============================================================
async function enviarRespostaWhatsApp(numeroCliente, textoRespostaBot, msgRef, msgs, mensagemUsuario) {
    // DETECÇÃO DE TRANSFERÊNCIA
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
        try {
            const chat = await msgRef.getChat();
            const contact = await chat.getContact();
            const nomeCliente = contact.pushname || contact.name || `Cliente ${numeroCliente.split('@')[0]}`;
            console.log(`📧 Tentando enviar e-mail para: ${botConfig.notificationEmail || 'e-mail do sistema'}`);
            sendTransferEmail(numeroCliente, nomeCliente)
                .then(info => console.log("✅ E-mail de transferência enviado:", info))
                .catch(e => console.error("❌ FALHA NO E-MAIL:", e.message));
            if (client.info && client.info.wid) {
                client.sendMessage(client.info.wid._serialized, `🚨 *ATENÇÃO:* Cliente @${numeroCliente.split('@')[0]} pediu humano!`).catch(() => { });
            }
        } catch (e) {
            console.error("❌ Erro ao preparar dados para e-mail:", e.message);
        }
    }

    // LIMPEZA DE TEXTO PARA O WHATSAPP
    let textFinal = textoRespostaBot
        .replace(/\[\[.*?\]\]/g, '')
        .replace(/[\[_]?Chamando vendedor[….]{1,3} só um instante[_\]]?\s*(🏃🏻‍♀️)?(➡️)?/gi, 'Chamando vendedor... só um instante 🏃🏻‍♀️')
        .replace(/14,10%/g, '')
        .replace(/\(com acréscimo de\s*:?\)/gi, '')
        .replace(/\(com acréscimo\s*:?\)/gi, '')
        .replace(/[\[\]_➡️]/g, '')
        .trim();

    if (!textFinal) textFinal = "💁🏻‍♀️ Só um minutinho que vou verificar isso pra você! 🏃🏻‍♀️";

    if (botConfig.clientesMudos[numeroCliente] && !isTransfer) {
        console.log(`🛑 Intervenção humana detectada! Cancelando envio para ${numeroCliente}`);
        return;
    }

    botRespondendo[numeroCliente] = true;
    try {
        const sentMsg = await client.sendMessage(numeroCliente, textFinal, { linkPreview: false });
        botSentMsgIds.add(sentMsg.id._serialized);
        addHistory('bot', textFinal, 'iSti');
    } finally {
        setTimeout(() => { botRespondendo[numeroCliente] = false; }, 3000);
    }

    if (mensagemUsuario) {
        historicoChats[numeroCliente].push({ role: "user", content: mensagemUsuario });
        historicoChats[numeroCliente].push({ role: "assistant", content: textFinal });
        if (historicoChats[numeroCliente].length > 20) historicoChats[numeroCliente].shift();
    }
}

// ============================================================
// ENTRADA DE MENSAGENS NOVAS — com Debounce de 3.5s
// ============================================================
function enfileirarMensagem(msg, isEdit = false) {
    const numeroCliente = msg.from;
    const textoOriginal = (msg.body || "").trim();

    if (numeroCliente.includes('@g.us') || numeroCliente.includes('@broadcast')) return;

    const prefixo = isEdit ? "✏️ [EDITADA]" : "📩";
    console.log(`${prefixo} [${new Date().toLocaleTimeString()}] De ${numeroCliente}: "${textoOriginal}"`);

    if (!mensagensPendentes[numeroCliente]) mensagensPendentes[numeroCliente] = [];

    if (isEdit) {
        // Mensagem editada: substitui ou acrescenta com contexto explícito para a IA
        const idSerialized = msg.id._serialized;
        const idx = mensagensPendentes[numeroCliente].findIndex(m => m.msg.id._serialized === idSerialized);
        const textoComContexto = `[O cliente editou uma mensagem anterior para]: "${textoOriginal}"`;
        if (idx >= 0) {
            // Substitui a versão antiga no buffer ainda não processado
            mensagensPendentes[numeroCliente][idx] = { msg, texto: textoComContexto, temMidia: msg.hasMedia };
            console.log(`♻️ Mensagem editada substituída no buffer de ${numeroCliente}.`);
        } else {
            // Mensagem foi editada depois de já ter sido processada: cria nova entrada
            mensagensPendentes[numeroCliente].push({ msg, texto: textoComContexto, temMidia: msg.hasMedia });
            console.log(`🆕 Mensagem editada adicionada como nova intenção de ${numeroCliente}.`);
        }
    } else {
        mensagensPendentes[numeroCliente].push({ msg, texto: textoOriginal, temMidia: msg.hasMedia });
    }

    ultimaMsgObj[numeroCliente] = msg;

    // Reseta o timer a cada mensagem recebida (janela deslizante de 3.5s)
    if (debounceTimers[numeroCliente]) clearTimeout(debounceTimers[numeroCliente]);
    debounceTimers[numeroCliente] = setTimeout(() => {
        delete debounceTimers[numeroCliente];
        processarMensagens(numeroCliente);
    }, 3500);
}

client.on('message', (msg) => enfileirarMensagem(msg, false));

// Suporte a mensagens editadas pelo cliente
client.on('message_edit', (msg) => {
    if (msg.fromMe) return; // ignora edições feitas pelo próprio número da loja
    enfileirarMensagem(msg, true);
});

console.log("🚀 Inicializando cliente WhatsApp...");
client.initialize();
