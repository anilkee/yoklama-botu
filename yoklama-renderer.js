const { ipcRenderer } = require('electron');

document.getElementById('versionText').textContent = `v${require('./package.json').version}`;

// --- DURUM ---
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

function applyStatus(status) {
    // Eski format (düz string) ile yeni format ({state, detail}) ikisini de kabul et.
    const state = (status && typeof status === 'object') ? status.state : status;
    const detail = (status && typeof status === 'object') ? status.detail : null;

    statusDot.classList.remove('warn', 'ok', 'danger');
    if (state === 'bağlı') {
        statusDot.classList.add('ok');
        statusText.textContent = detail || 'Bağlı';
    } else if (state === 'hata') {
        statusDot.classList.add('danger');
        statusText.textContent = detail || 'Bağlantı hatası';
    } else {
        statusDot.classList.add('warn');
        statusText.textContent = detail || 'Bağlanıyor...';
    }
}

ipcRenderer.on('status', (event, status) => applyStatus(status));
ipcRenderer.send('request-status');

// --- İŞLEM KAYDI (LOG) ---
const logListEl = document.getElementById('logList');
const clearLogBtn = document.getElementById('clearLogBtn');
const MAX_LOG_LINES = 300;

function logCategoryOf(message) {
    const match = /^\[([^\]]+)\]/.exec(message);
    if (!match) return '';
    return match[1].toLowerCase();
}

function appendLog(time, message) {
    const line = document.createElement('div');
    const category = logCategoryOf(message);
    line.className = `log-line log-${category}`;
    const t = new Date(time).toLocaleTimeString('tr-TR');
    line.innerHTML = `<span class="log-time">${t}</span>${escapeHtml(message)}`;
    logListEl.appendChild(line);

    while (logListEl.children.length > MAX_LOG_LINES) {
        logListEl.removeChild(logListEl.firstChild);
    }
    logListEl.scrollTop = logListEl.scrollHeight;
}

ipcRenderer.on('log-entry', (event, entry) => appendLog(entry.time, entry.message));

clearLogBtn.addEventListener('click', () => {
    logListEl.innerHTML = '';
});

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

const selectedCountEl = document.getElementById('selectedCount');
const bulkReasonEl = document.getElementById('bulkReason');
const bulkWarnBtn = document.getElementById('bulkWarnBtn');
const bulkProgressEl = document.getElementById('bulkProgress');

let countdownInterval = null;
let lastResults = [];
const selectedIds = new Set();

const WARNING_LADDER = ['Sözlü Uyarı', '1x', '2x', '3x'];

// --- SEBEP SORMA MODAL'I (tekli uyarı) ---
const reasonModalOverlay = document.getElementById('reasonModalOverlay');
const reasonModalSub = document.getElementById('reasonModalSub');
const reasonModalInput = document.getElementById('reasonModalInput');
const reasonModalCancel = document.getElementById('reasonModalCancel');
const reasonModalConfirm = document.getElementById('reasonModalConfirm');

let pendingReasonResolve = null;

function askForReason(subText) {
    return new Promise((resolve) => {
        pendingReasonResolve = resolve;
        reasonModalSub.textContent = subText;
        reasonModalInput.value = '';
        reasonModalOverlay.style.display = 'flex';
        reasonModalInput.focus();
    });
}

function closeReasonModal(result) {
    reasonModalOverlay.style.display = 'none';
    if (pendingReasonResolve) {
        pendingReasonResolve(result);
        pendingReasonResolve = null;
    }
}

reasonModalCancel.addEventListener('click', () => closeReasonModal(null));
reasonModalConfirm.addEventListener('click', () => {
    const reason = reasonModalInput.value.trim();
    if (!reason) {
        reasonModalInput.focus();
        return;
    }
    closeReasonModal(reason);
});

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

function updateSelectedCount() {
    selectedCountEl.textContent = `${selectedIds.size} kişi seçili`;
    bulkWarnBtn.disabled = selectedIds.size === 0 || !bulkReasonEl.value.trim();
}

function renderRow(member) {
    const row = document.createElement('div');
    row.className = `row ${member.inVoice ? 'status-in' : 'status-out'}`;
    row.dataset.id = member.id;
    if (selectedIds.has(member.id)) row.classList.add('selected');

    const voiceClass = member.inVoice ? 'in' : 'out';
    const voiceLabel = member.inVoice ? 'Sesde ✅' : 'Sesde Değil ❌';
    const excuseHtml = member.inVoice
        ? ''
        : `
            <div class="excuse">${member.excuseText ? escapeHtml(member.excuseText) : '<span class="muted">Mazaret yok</span>'}</div>
            <div class="reactions">${renderReactions(member.excuseReactions)}</div>
        `;

    row.innerHTML = `
        <span class="voiceDot ${voiceClass}"></span>
        <img class="avatar" src="${member.avatarURL}" alt="">
        <div class="info">
            <div class="name">${escapeHtml(member.displayName)} <span class="tag">${escapeHtml(member.tag)}</span></div>
            <div class="voiceLabel ${voiceClass}">${voiceLabel}</div>
            ${excuseHtml}
            <div class="tier muted">Mevcut kademe: ${member.currentTierLabel || 'Yok'}</div>
        </div>
        <div class="action">
            <div class="selectBtns">
                <button class="small selBtn selPlus${selectedIds.has(member.id) ? ' active' : ''}" data-id="${member.id}" title="Toplu uyarı için seç">+</button>
                <button class="small selBtn selMinus" data-id="${member.id}" title="Seçimden çıkar">-</button>
            </div>
            <button class="roleBtn small" data-id="${member.id}">${roleButtonLabel(member)}</button>
            <div class="roleMsg" data-id="${member.id}"></div>
        </div>
    `;
    return row;
}

function renderResults(data) {
    lastResults = data.members;
    listEl.innerHTML = '';
    summaryText.innerHTML = `Kontrol edilen: <b>${data.totalChecked}</b> · Sesde: <span class="green-num">${data.totalInVoice}</span> · Sesde değil: <span class="red-num">${data.totalChecked - data.totalInVoice}</span>`;

    if (data.members.length === 0) {
        emptyState.style.display = 'block';
        return;
    }
    emptyState.style.display = 'none';

    data.members.forEach((member) => {
        listEl.appendChild(renderRow(member));
    });

    document.querySelectorAll('.roleBtn').forEach((btn) => {
        btn.addEventListener('click', onRoleButtonClick);
    });
    document.querySelectorAll('.selPlus').forEach((btn) => {
        btn.addEventListener('click', () => selectMember(btn.dataset.id));
    });
    document.querySelectorAll('.selMinus').forEach((btn) => {
        btn.addEventListener('click', () => deselectMember(btn.dataset.id));
    });
    updateSelectedCount();
}

function selectMember(memberId) {
    selectedIds.add(memberId);
    const row = listEl.querySelector(`.row[data-id="${memberId}"]`);
    if (row) {
        row.classList.add('selected');
        row.querySelector('.selPlus').classList.add('active');
    }
    updateSelectedCount();
}

function deselectMember(memberId) {
    selectedIds.delete(memberId);
    const row = listEl.querySelector(`.row[data-id="${memberId}"]`);
    if (row) {
        row.classList.remove('selected');
        row.querySelector('.selPlus').classList.remove('active');
    }
    updateSelectedCount();
}

async function onRoleButtonClick(evt) {
    const btn = evt.currentTarget;
    const memberId = btn.dataset.id;
    const msgEl = document.querySelector(`.roleMsg[data-id="${memberId}"]`);
    const member = lastResults.find((m) => m.id === memberId);

    let reason = null;
    if (member && !member.isMaxTier) {
        reason = await askForReason(`${member.displayName} kişisine "${member.nextTierLabel}" verilecek. Sebebini yaz - kanala duyuru olarak düşecek:`);
        if (reason === null) return; // iptal edildi
    }

    btn.disabled = true;
    msgEl.textContent = 'Gönderiliyor...';
    msgEl.className = 'roleMsg';

    const result = await ipcRenderer.invoke('yoklama-rol-ver', memberId, reason);
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

    let text = result.botReply
        ? `Gönderildi: ${result.givenLabel} — Bot: "${result.botReply}"`
        : `Gönderildi: ${result.givenLabel} (bot cevabı yakalanamadı, Discord'dan kontrol et)`;
    if (result.announceError) text += ` (duyuru gönderilemedi: ${result.announceError})`;
    msgEl.textContent = text;
    msgEl.className = 'roleMsg ok';

    applyGivenRoleToRow(memberId, result.givenLabel);
}

// Bir kişiye rol verildikten sonra (tekli ya da toplu akıştan), o satırın
// kademe bilgisini ve "Rol Ver" butonunun metnini güncel tutar.
function applyGivenRoleToRow(memberId, givenLabel) {
    const member = lastResults.find((m) => m.id === memberId);
    if (!member) return;
    member.currentTierLabel = givenLabel;
    const idx = WARNING_LADDER.indexOf(givenLabel);
    member.nextTierLabel = idx >= 0 && idx < WARNING_LADDER.length - 1 ? WARNING_LADDER[idx + 1] : null;
    member.isMaxTier = idx === WARNING_LADDER.length - 1;

    const btn = listEl.querySelector(`.roleBtn[data-id="${memberId}"]`);
    if (btn) btn.textContent = roleButtonLabel(member);

    const tierEl = listEl.querySelector(`.row[data-id="${memberId}"] .tier`);
    if (tierEl) tierEl.textContent = `Mevcut kademe: ${member.currentTierLabel || 'Yok'}`;
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

// --- TOPLU UYARI ---
bulkReasonEl.addEventListener('input', updateSelectedCount);

ipcRenderer.on('yoklama-toplu-uyari-ilerleme', (event, progress) => {
    bulkProgressEl.textContent = `İşleniyor: ${progress.current}/${progress.total}...`;
});

bulkWarnBtn.addEventListener('click', async () => {
    const memberIds = [...selectedIds];
    const reason = bulkReasonEl.value.trim();
    if (memberIds.length === 0 || !reason) return;

    bulkWarnBtn.disabled = true;
    bulkReasonEl.disabled = true;
    bulkProgressEl.textContent = `İşleniyor: 0/${memberIds.length}...`;
    hideError();

    const result = await ipcRenderer.invoke('yoklama-toplu-uyari-ver', memberIds, reason);

    bulkReasonEl.disabled = false;

    if (!result.ok) {
        bulkProgressEl.textContent = '';
        showError(`Toplu uyarı başarısız: ${result.error}`);
        updateSelectedCount();
        return;
    }

    const { warned, skipped, failed, announceError } = result.data;

    warned.forEach(({ id, givenLabel }) => {
        applyGivenRoleToRow(id, givenLabel);
        deselectMember(id);
    });
    skipped.forEach((s) => deselectMember(s.id));
    failed.forEach((f) => deselectMember(f.id));

    let summary = `Tamamlandı: ${warned.length} kişiye uyarı verildi.`;
    if (failed.length) summary += ` ${failed.length} kişide hata oluştu.`;
    if (announceError) summary += ` Duyuru mesajı gönderilemedi: ${announceError}`;
    bulkProgressEl.textContent = summary;

    if (warned.length > 0) {
        bulkReasonEl.value = '';
    }

    if (skipped.length > 0) {
        const names = skipped.map((s) => s.tag).join('\n');
        alert(`Şu kişiler zaten en üst kademede (3x) olduğu için atlandı, rol verilmedi ve duyuru mesajına eklenmedi:\n\n${names}`);
    }

    updateSelectedCount();
});

// Panel açılınca bekleyen bir zamanlama varsa geri say
ipcRenderer.invoke('yoklama-zamanlama-durumu').then((state) => {
    if (state && state.scheduledAt) startCountdown(state.scheduledAt);
});

// Not: Açılışta otomatik tarama YOK - "Taramayı Başlat" butonuna basmak gerekiyor.
