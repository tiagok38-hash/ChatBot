const config = {
    apiUrl: '/api'
};

// DOM Elements
const toggle = document.getElementById('bot-toggle');
const statusText = document.getElementById('status-text');
const promptInput = document.getElementById('prompt-input');
const weekStart = document.getElementById('weekday-start');
const weekEnd = document.getElementById('weekday-end');
const week24h = document.getElementById('weekday-24h');
const weekendActive = document.getElementById('weekend-active');
const autoReturnInput = document.getElementById('auto-return-minutes');
const notificationEmailInput = document.getElementById('notification-email');
const btnSave = document.getElementById('btn-save');
const btnTestEmail = document.getElementById('btn-test-email');
const btnRefresh = document.getElementById('refresh-chat');
const chatHistory = document.getElementById('chat-history');
const toast = document.getElementById('toast');
const qrSection = document.getElementById('qr-section');
const qrImg = document.getElementById('qr-code-img');
const botNameLabel = document.querySelector('.bot-name');

// Load initial config
async function loadConfig() {
    try {
        const res = await fetch(`${config.apiUrl}/config`);
        const data = await res.json();

        // Setup values
        toggle.checked = data.active;
        updateStatusUI(data.active);

        promptInput.value = data.prompt;
        weekStart.value = data.schedule.start;
        weekEnd.value = data.schedule.end;
        weekendActive.checked = data.schedule.weekend;
        week24h.checked = data.schedule.weekday24h;
        autoReturnInput.value = data.schedule.autoReturnMinutes || 10;
        notificationEmailInput.value = data.notificationEmail || '';

        // Initial setup for disabled/enabled state of time inputs
        toggleTimeInputs(data.schedule.weekday24h);

        loadHistory();
        updateQR(); // Initial QR check
    } catch (err) {
        console.error('Erro ao conectar com API:', err);
    }
}

// Update QR Code
async function updateQR() {
    try {
        const res = await fetch(`${config.apiUrl}/qr`);
        const data = await res.json();
        if (data.qr) {
            qrImg.src = data.qr;
            qrSection.classList.remove('hidden');
        } else {
            qrSection.classList.add('hidden');
        }
    } catch (err) {
        console.error('Erro ao buscar QR:', err);
    }
}

// Load Chat History
async function loadHistory() {
    try {
        const res = await fetch(`${config.apiUrl}/history`);
        const data = await res.json();

        chatHistory.innerHTML = '';

        if (data.length === 0) {
            chatHistory.innerHTML = '<div class="loading-history">Nenhuma conversa recente encontrada.</div>';
            return;
        }

        data.forEach(msg => {
            const bubble = document.createElement('div');
            bubble.classList.add('chat-bubble', msg.type === 'bot' ? 'bot' : 'user');

            const messageText = document.createElement('span');
            messageText.textContent = msg.text;

            const timeInfo = document.createElement('span');
            timeInfo.classList.add('chat-time');

            // Format phone and date
            const dateStr = new Date(msg.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            timeInfo.textContent = msg.type === 'bot' ? dateStr : `Cliente - ${dateStr}`;

            bubble.appendChild(messageText);
            bubble.appendChild(timeInfo);
            chatHistory.appendChild(bubble);
        });

        // Scroll to bottom
        chatHistory.scrollTop = chatHistory.scrollHeight;

    } catch (err) {
        console.error('Erro ao carregar historico:', err);
    }
}

// Update Status Interface
function updateStatusUI(isActive) {
    if (isActive) {
        statusText.textContent = 'Trabalhando';
        statusText.classList.remove('off');
    } else {
        statusText.textContent = 'Dormindo';
        statusText.classList.add('off');
    }
}

// Save Settings
async function saveSettings() {
    const payload = {
        active: toggle.checked,
        prompt: promptInput.value,
        schedule: {
            start: weekStart.value,
            end: weekEnd.value,
            weekend: weekendActive.checked,
            weekday24h: week24h.checked,
            autoReturnMinutes: parseInt(autoReturnInput.value) || 0
        },
        notificationEmail: notificationEmailInput.value.trim()
    };

    try {
        const res = await fetch(`${config.apiUrl}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            showToast('Configurações salvas e aplicadas! 🎉');
        }
    } catch (err) {
        console.error('Erro ao salvar:', err);
        showToast('Erro de conexão ao salvar.', true);
    }
}

// UI Triggers
toggle.addEventListener('change', (e) => {
    updateStatusUI(e.target.checked);
});

week24h.addEventListener('change', (e) => {
    toggleTimeInputs(e.target.checked);
});

function toggleTimeInputs(is24h) {
    weekStart.disabled = is24h;
    weekEnd.disabled = is24h;
    if (is24h) {
        weekStart.style.opacity = '0.5';
        weekEnd.style.opacity = '0.5';
    } else {
        weekStart.style.opacity = '1';
        weekEnd.style.opacity = '1';
    }
}

btnSave.addEventListener('click', () => {
    btnSave.textContent = 'Salvando...';
    saveSettings().finally(() => {
        setTimeout(() => btnSave.textContent = 'Salvar Configurações', 1000);
    });
});

btnRefresh.addEventListener('click', (e) => {
    e.preventDefault();
    chatHistory.innerHTML = '<div class="loading-history">Carregando...</div>';
    loadHistory();
});

btnTestEmail.addEventListener('click', async () => {
    if (!notificationEmailInput.value) {
        showToast('Preencha o e-mail primeiro!', true);
        return;
    }
    btnTestEmail.textContent = 'Enviando...';
    try {
        const res = await fetch(`${config.apiUrl}/test-email`, { method: 'POST' });
        if (res.ok) {
            showToast('E-mail de teste enviado! Verifique seu Inbox/Spam.');
        } else {
            const err = await res.json();
            showToast(`Erro: ${err.error}`, true);
        }
    } catch (e) {
        showToast('Erro de conexão ao testar.', true);
    } finally {
        btnTestEmail.textContent = 'Testar';
    }
});

// Toast system
let toastTimeout;
function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.style.background = isError ? '#FF3B30' : '#333';
    toast.classList.remove('hidden');

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.add('hidden');
    }, 3000);
}

// Init
loadConfig();

// Poll for QR and History
setInterval(updateQR, 5000); // Check for QR every 5s
setInterval(loadHistory, 15000); // Refresh history every 15s
