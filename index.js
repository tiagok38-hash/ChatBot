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

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// --- CARREGAMENTO DE CONFIGURAÇÕES SALVAS (Painel Administrativo) ---
const configPath = path.join(__dirname, 'bot-config.json');
const personalityPath = path.join(__dirname, 'personalidade.txt');

let botConfig = {
    active: true,
    prompt: `Você é a iSti, assistente virtual da iStore. Responda de forma simpática usando seu emoji 💁🏻‍♀️. (O restante da personalidade é lido do arquivo personalidade.txt)`,
    schedule: { start: '18:00', end: '08:00', weekend: true, weekday24h: false, autoReturnMinutes: 10 }, // Ex: horários em que atende
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🌐 Painel Administrativo da iSti rodando em: http://localhost:${PORT}`);
});


console.log("🛠️ Inicializando APIs (Gemini e Supabase)...");
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
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;

    let respond = false;
    if (start > end) {
        respond = current >= start || current <= end;
    } else {
        respond = current >= start && current <= end;
    }
    if (!respond) console.log(`🕒 Bot fora do horário de atendimento (${botConfig.schedule.start} - ${botConfig.schedule.end}).`);
    return respond;
}

async function consultarEstoqueTexto() {
    try {
        const { data: produtos, error } = await supabase
            .from('products')
            .select('name, model, color, storage, condition, price, stock, batteryHealth, warranty')
            .gt('stock', 0);

        if (error) return 'Estoque indisponível.';
        if (!produtos || produtos.length === 0) return 'Estoque zerado.';

        const estoqueAgrupado = {};
        produtos.forEach(p => {
            const nomeBase = p.name || p.model || 'Produto sem nome';
            const chave = `${nomeBase}-${p.color}-${p.storage}-${p.condition}-${p.warranty || ''}`;
            if (!estoqueAgrupado[chave]) {
                let display = nomeBase;
                const storageStr = p.storage ? `${p.storage}GB` : '';
                if (storageStr && !nomeBase.includes(storageStr)) display += ` ${storageStr}`;
                if (p.condition) display += ` (${p.color || 'padrão'} / ${p.condition})`;
                else display += ` (${p.color || 'padrão'} / Novo)`;

                estoqueAgrupado[chave] = {
                    display,
                    price: p.price,
                    warranty: p.warranty ? ` [Garantia: ${p.warranty}]` : '',
                    battery: p.condition !== 'Novo' && p.batteryHealth ? ` [Saúde: ${p.batteryHealth}%]` : ''
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

        const getBaseModel = (display) => {
            let base = display.split('(')[0].trim();
            base = base.replace(/\d+GB/i, '').replace(/Azul|Meia-noite|Estelar|Verde|Rosa|Amarelo|Vermelho|Branco|Preto|Sideral|Prata|Dourado|Grafite|Verde Alpino|Azul-Sierra|Roxo|Titânio|Natural|Branco/gi, '').trim();
            return base;
        };

        const sorted = Object.values(estoqueAgrupado)
            .sort((a, b) => {
                const prioA = getPriority(a.display);
                const prioB = getPriority(b.display);
                if (prioA !== prioB) return prioA - prioB;
                const baseA = getBaseModel(a.display);
                const baseB = getBaseModel(b.display);
                if (baseA !== baseB) return baseA.localeCompare(baseB);
                const getCondPrio = (d) => {
                    if (d.includes('Novo')) return 0;
                    if (d.includes('CPO')) return 1;
                    if (d.includes('Open Box')) return 2;
                    if (d.includes('Vitrini')) return 3;
                    return 4;
                };
                const cpA = getCondPrio(a.display);
                const cpB = getCondPrio(b.display);
                if (cpA !== cpB) return cpA - cpB;
                return a.display.localeCompare(b.display);
            })
            .slice(0, 800);

        const listaFinal = sorted.map(item => `- ${item.display}${item.battery}${item.warranty} -> R$ ${item.price || 0},00 [SÓ 1 UNIDADE]`);
        return listaFinal.join('\n');
    } catch (err) {
        return 'Erro interno ao ler estoque.';
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ Tudo pronto! A iSti está rodando no WhatsApp!'));

const historicoChats = {};
const botRespondendo = {};
const botSentMsgIds = new Set();
const usuariosSendoProcessados = new Set();

client.on('message_create', async (msg) => {
    if (msg.to && msg.to.includes('@g.us')) return;
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
    if (numeroCliente.includes('@g.us')) return;

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

    if (!shouldBotRespond()) return;

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
        // Se a mensagem não tem mídia e o corpo é vazio, ignorar silenciosamente
        let mensagemUsuario = textoOriginal;
        if (msg.hasMedia && !transcricaoAudio) {
            mensagemUsuario = "O cliente enviou uma mídia/imagem/áudio.";
        }
        if (!mensagemUsuario) {
            usuariosSendoProcessados.delete(numeroCliente);
            return;
        }

        if (contemLink || ehInstagram) {
            console.log(`🔗 Link/Ad detectado de ${numeroCliente}. Redirecionando para humano.`);
            textoRespostaBot = "Oi! Sou a iSti, assistente virtual da iStore 💁🏻‍♀️.\n\nNotei que você enviou um link ou post! 🍎 Vou chamar um especialista agora mesmo para te atender. Só um instante! [[TRANSFERENCIA_HUMANA_CONFIRMADA]]";
        } else {
            const chatWs = await msg.getChat();
            await chatWs.sendStateTyping();

            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (media.mimetype.includes('audio') || msg.type === 'ptt') {
                        const modelGemini = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                        const mimeLimpo = media.mimetype.split(';')[0]; // Deixa só 'audio/ogg' do 'audio/ogg; codecs=opus'
                        const audioPart = { inlineData: { data: media.data, mimeType: mimeLimpo } };
                        const result = await modelGemini.generateContent(["Transcreva este áudio em detalhes do que foi falado pelo cliente, seja preciso (se não tiver voz resuma):", audioPart]);
                        transcricaoAudio = result.response.text();
                        console.log("Transcreveu sucesso: ", transcricaoAudio);
                    }
                } catch (err) {
                    console.error("Erro na transcrição de áudio pelo Gemini:", err.message || err);
                    transcricaoAudio = "[O cliente enviou um áudio, mas ocorreu um erro no processador e não pude ouvir. Peça para escrever.]";
                }
            }

            const estoque = await consultarEstoqueTexto();
            const promptSistema = `${botConfig.prompt}\n\n[RESPOSTAS CURTAS: Máximo 2 frases.]\n\nESTOQUE ATUAL:\n${estoque}`;

            let contextMsg = "";
            if (msg.hasQuotedMsg) {
                try {
                    const quoted = await msg.getQuotedMessage();
                    contextMsg = `[O cliente está respondendo a: "${quoted.body}"]\n\n`;
                } catch (e) { }
            }

            mensagemUsuario = contextMsg + (transcricaoAudio || textoOriginal || "O cliente enviou uma imagem/mídia.");

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: promptSistema }, ...historicoChats[numeroCliente], { role: "user", content: mensagemUsuario }],
                stream: false
            }, { timeout: 30000 });

            textoRespostaBot = response.choices[0].message.content;

            textoRespostaBot = textoRespostaBot
                .replace(/14[,.]10%?/g, '')
                .replace(/taxa de 14[,.]10%/gi, '')
                .replace(/\+ \s*=/g, '=')
                .replace(/R\$ \d+([,.]\d{3})?([,.]\d{2})? \s*[+\-=] \s*/g, '')
                .replace(/Valor total: R\$ \d+([,.]\d{3})?([,.]\d{2})? \s*[+\-=]/gi, '')
                .replace(/sem juros/gi, '')
                .replace(/\bparcelado sem acréscimo\b/gi, 'parcelado');

        }

        if (textoRespostaBot.includes('[[TRANSFERENCIA_HUMANA_CONFIRMADA]]')) {
            botConfig.clientesMudos[numeroCliente] = Date.now();
            saveGlobalConfig();
            if (client.info && client.info.wid) {
                const meuNumero = client.info.wid._serialized;
                await client.sendMessage(meuNumero, `🚨 *ATENÇÃO:* O cliente @${numeroCliente.split('@')[0]} pediu um humano!`);
            }
        }

        textoRespostaBot = textoRespostaBot.replace(/\[\[.*?\]\]/g, '').trim();
        if (!textoRespostaBot) textoRespostaBot = "💁🏻‍♀️ Só um minutinho que vou verificar isso pra você!";

        botRespondendo[numeroCliente] = true;
        try {
            const sentMsg = await msg.reply(textoRespostaBot, undefined, { linkPreview: false });
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
