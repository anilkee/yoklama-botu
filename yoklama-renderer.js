const { ipcRenderer } = require('electron');

document.getElementById('versionText').textContent = `v${require('./package.json').version}`;

// --- DURUM ---
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// Discord bağlantısı kurulmadan taramaya kalkışmanın anlamı yok (hemen hata
// verir) - o yüzden panel açılır açılmaz değil, bağlantı "bağlı" olduğunda
// ve bir kere olacak şekilde ilk taramayı otomatik başlatıyoruz.
let hasAutoScanned = false;

function applyStatus(status) {
    statusDot.classList.remove('warn', 'ok', 'danger');
    if (status === 'bağlı') {
        statusDot.classList.add('ok');
        statusText.textContent = 'Bağlı';
        if (!hasAutoScanned) {
            hasAutoScanned = true;
            runScan();
        }
    } else if (status === 'hata') {
        statusDot.classList.add('danger');
        statusText.textContent = 'Bağlantı hatası';
    } else {
        statusDot.classList.add('warn');
        statusText.textContent = 'Bağlanıyor...';
    }
}

ipcRenderer.on('status', (event, status) => applyStatus(status));
ipcRenderer.send('request-status');

const scanBtn = document.getElementById('scanBtn');
const scanStatus = document.getElementById('scanStatus');
const summaryText = document.getElementById('summaryText');
const listEl = document.getElementById('list');
const emptyState = document.getElementById('emptyState');
const errorBox = document.getElementById('errorBox');

const schedHours = document.getElementById('schedHours');
const schedMinutes = document.getElementById('schedMinutes');
const scheduleBtn = document.getElementById('scheduleBtn');
const cancelScheduleBtn = document.getElementById('cancelScheduleBtn');
const countdownText = document.getElementById('countdownText');

let countdownInterval = null;
let lastResults = [];

const WARNING_LADDER = ['Sözlü Uyarı', '1x', '2x', '3x'];

function formatDate(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('tr-TR');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showError(message) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
}

function hideError() {
    errorBox.style.display = 'none';
}

function renderReactions(reactions) {
    if (!reactions || reactions.length === 0) {
        return '<span class="pill muted">Onay yok</span>';
    }
    return reactions.map((r) => `<span class="pill">${escapeHtml(r.emoji)} ${r.count}</span>`).join('');
}

function roleButtonLabel(member) {
    return member.isMaxTier
        ? `${member.currentTierLabel} (Maks)`
        : `${member.nextTierLabel} Ver`;
}

function renderRow(member) {
    const row = document.createElement('div');
    row.className = 'row';

    row.innerHTML = `
        <img class="avatar" src="${member.avatarURL}" alt="">
        <div class="info">
            <div class="name">${escapeHtml(member.displayName)} <span class="tag">${escapeHtml(member.tag)}</span></div>
            <div class="excuse">${member.excuseText ? escapeHtml(member.excuseText) : '<span class="muted">Mazaret yok</span>'}</div>
            <div class="reactions">${renderReactions(member.excuseReactions)}</div>
            <div class="tier muted">Mevcut kademe: ${member.currentTierLabel || 'Yok'}</div>
        </div>
        <div class="action">
            <button class="roleBtn small" data-id="${member.id}">${roleButtonLabel(member)}</button>
            <div class="roleMsg" data-id="${member.id}"></div>
        </div>
    `;
    return row;
}

function renderResults(data) {
    lastResults = data.absentees;
    listEl.innerHTML = '';
    summaryText.textContent = `Kontrol edilen: ${data.totalChecked} · Sesde: ${data.totalInVoice} · Sesde değil: ${data.absentees.length}`;

    if (data.absentees.length === 0) {
        emptyState.style.display = 'block';
        return;
    }
    emptyState.style.display = 'none';

    data.absentees.forEach((member) => {
        listEl.appendChild(renderRow(member));
    });

    document.querySelectorAll('.roleBtn').forEach((btn) => {
        btn.addEventListener('click', onRoleButtonClick);
    });
}

async function onRoleButtonClick(evt) {
    const btn = evt.currentTarget;
    const memberId = btn.dataset.id;
    const msgEl = document.querySelector(`.roleMsg[data-id="${memberId}"]`);

    btn.disabled = true;
    msgEl.textContent = 'Gönderiliyor...';
    msgEl.className = 'roleMsg';

    const result = await ipcRenderer.invoke('yoklama-rol-ver', memberId);
    btn.disabled = false;

    if (!result.ok) {
        if (result.reason === 'max') {
            msgEl.textContent = `Zaten en üst kademede (${result.currentTierLabel}).`;
        } else {
            msgEl.textContent = `Hata: ${result.error || 'bilinmeyen hata'}`;
        }
        msgEl.className = 'roleMsg error';
        return;
    }

    msgEl.textContent = result.botReply
        ? `Gönderildi: ${result.givenLabel} — Bot: "${result.botReply}"`
        : `Gönderildi: ${result.givenLabel} (bot cevabı yakalanamadı, Discord'dan kontrol et)`;
    msgEl.className = 'roleMsg ok';

    const member = lastResults.find((m) => m.id === memberId);
    if (member) {
        member.currentTierLabel = result.givenLabel;
        const idx = WARNING_LADDER.indexOf(result.givenLabel);
        member.nextTierLabel = idx >= 0 && idx < WARNING_LADDER.length - 1 ? WARNING_LADDER[idx + 1] : null;
        member.isMaxTier = idx === WARNING_LADDER.length - 1;
        btn.textContent = roleButtonLabel(member);
    }
}

async function runScan() {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Taranıyor...';
    hideError();

    const result = await ipcRenderer.invoke('yoklama-tara');

    scanBtn.disabled = false;
    scanBtn.textContent = 'Taramayı Başlat';

    if (!result.ok) {
        showError(`Tarama başarısız: ${result.error}`);
        return;
    }

    scanStatus.textContent = `Son tarama: ${formatDate(result.data.scannedAt)}`;
    renderResults(result.data);
}

scanBtn.addEventListener('click', runScan);

// --- ZAMANLAYICI (tek seferlik, manuel) ---
function startCountdown(targetTs) {
    if (countdownInterval) clearInterval(countdownInterval);
    scheduleBtn.disabled = true;
    cancelScheduleBtn.style.display = 'inline-block';

    function tick() {
        const remaining = targetTs - Date.now();
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            countdownText.textContent = 'Tarama çalışıyor...';
            return;
        }
        const totalSec = Math.floor(remaining / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        countdownText.textContent = `Sonraki tarama: ${h}s ${m}d ${s}sn sonra`;
    }
    tick();
    countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = null;
    countdownText.textContent = '';
    scheduleBtn.disabled = false;
    cancelScheduleBtn.style.display = 'none';
}

scheduleBtn.addEventListener('click', async () => {
    const hours = parseInt(schedHours.value, 10) || 0;
    const minutes = parseInt(schedMinutes.value, 10) || 0;
    const ms = (hours * 3600 + minutes * 60) * 1000;
    if (ms <= 0) {
        showError('Zamanlayıcı için en az 1 dakika gir.');
        return;
    }
    hideError();
    const result = await ipcRenderer.invoke('yoklama-zamanla', ms);
    if (result.ok) startCountdown(result.scheduledAt);
});

cancelScheduleBtn.addEventListener('click', async () => {
    await ipcRenderer.invoke('yoklama-zamanlamayi-iptal-et');
    stopCountdown();
});

ipcRenderer.on('yoklama-otomatik-sonuc', (event, result) => {
    stopCountdown();
    if (!result.ok) {
        showError(`Zamanlanmış tarama başarısız: ${result.error}`);
        return;
    }
    scanStatus.textContent = `Son tarama (otomatik): ${formatDate(result.data.scannedAt)}`;
    renderResults(result.data);
});

// Panel açılınca bekleyen bir zamanlama varsa geri say
ipcRenderer.invoke('yoklama-zamanlama-durumu').then((state) => {
    if (state && state.scheduledAt) startCountdown(state.scheduledAt);
});

// İlk otomatik tarama, bağlantı "bağlı" olduğunda applyStatus() içinden tetiklenir.
