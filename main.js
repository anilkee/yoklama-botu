const path = require('path');
const fs = require('fs');

// Bazı ağlarda IPv6 bağlantısı yarım çalışıp isteklerin uzun süre asılı
// kalmasına neden olabiliyor. IPv4'ü önceliklendiriyoruz.
require('dns').setDefaultResultOrder('ipv4first');

const CONFIG_ENV_PATH = path.join(__dirname, 'config.env');
require('dotenv').config({ path: CONFIG_ENV_PATH });

// Uygulama ZIP dosyasının içinden, hiç çıkarılmadan çalıştırılırsa Windows onu
// her seferinde geçici bir klasöre (AppData\Local\Temp altında) yeniden açar,
// o klasördeki config.env de dahil her şey bir sonraki açılışta kaybolur.
function isRunningFromTemporaryLocation() {
    const dirLower = __dirname.toLowerCase();
    return dirLower.includes('\\appdata\\local\\temp\\') || dirLower.includes('/appdata/local/temp/');
}

// Paketlenmiş .exe konsolsuz açıldığı için console.log çıktısı hiçbir yerde
// görünmüyor - aynı satırlar debug.log dosyasına da yazılıyor.
const DEBUG_LOG_PATH = path.join(__dirname, 'debug.log');
const DEBUG_LOG_OLD_PATH = path.join(__dirname, 'debug.log.old');
const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
let debugLogSize = 0;
try {
    debugLogSize = fs.statSync(DEBUG_LOG_PATH).size;
} catch (error) {
    debugLogSize = 0;
}

function writeDebugLog(line) {
    try {
        if (debugLogSize > DEBUG_LOG_MAX_BYTES) {
            try { fs.rmSync(DEBUG_LOG_OLD_PATH); } catch (e) {}
            fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_OLD_PATH);
            debugLogSize = 0;
        }
        const entry = `[${new Date().toISOString()}] ${line}\n`;
        fs.appendFileSync(DEBUG_LOG_PATH, entry);
        debugLogSize += Buffer.byteLength(entry);
    } catch (error) {
        // debug.log'a yazılamıyorsa sessizce geç, konsola zaten basılıyor
    }
}

const originalConsoleLog = console.log;
console.log = (...args) => {
    originalConsoleLog(...args);
    writeDebugLog(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};

const { app, BrowserWindow, ipcMain, dialog } = require('electron');

// Aynı anda birden fazla kopya açılmasını engelliyoruz.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
    process.exit(0);
}

app.setAppUserModelId('com.yoklamabotu.app');

app.on('second-instance', () => {
    const existingWindow = mainWindow || setupWindow || updateProgressWindow;
    if (existingWindow) {
        if (existingWindow.isMinimized()) existingWindow.restore();
        existingWindow.focus();
    }
});

const { Client } = require('discord.js-selfbot-v13');

// --- YOKLAMA (SES KONTROLÜ) AYARLARI ---
// Bu proje tek bir sunucuya özel hazırlandığı için ayarlar koddan sabit veriliyor.
const GUILD_ID = '1469033815518482445';

// Bu rollerden en az birine sahip olan herkes yoklama kontrolüne dahil edilir.
const ATTENDANCE_ROLE_IDS = ['1470230322410160268', '1470230340621697257'];

// Mazaretlerin atıldığı kanal - sadece son EXCUSE_LOOKBACK_MS içindeki
// mesajlara bakılır (eski mazaretler taramaya dahil edilmez).
const EXCUSE_CHANNEL_ID = '1483233161390587986';
const EXCUSE_LOOKBACK_MS = 24 * 60 * 60 * 1000; // son 24 saat

// Rol verme merdiveni - en düşükten en yükseğe sırayla. "Rol Ver" butonuna
// her basıldığında kişinin sahip olduğu en yüksek kademe baz alınıp bir
// sonraki kademe roldeki rol EKLENİR (eski kademe rolleri üzerinde kalır).
const WARNING_ROLES = [
    { id: '1470230364021850194', label: 'Sözlü Uyarı' },
    { id: '1470230364940275793', label: '1x' },
    { id: '1470230365800235121', label: '2x' },
    { id: '1470230366769119354', label: '3x' },
];

// Rol verme doğrudan Discord API'siyle değil, sunucudaki rol botunun
// "/rol-ver" slash komutu bu hesap üzerinden tetiklenerek yapılıyor.
const ROLE_BOT_ID = '1472695273418522657';
const ROLE_COMMAND_CHANNEL_ID = '1504900865507463259';

let mainWindow;
let setupWindow;
let updateProgressWindow;
let discordStatus = 'bağlanıyor'; // 'bağlanıyor' | 'bağlı' | 'hata'
let discordStatusDetail = 'Bağlanıyor...';

function broadcastStatus() {
    if (mainWindow) mainWindow.webContents.send('status', { state: discordStatus, detail: discordStatusDetail });
}

const client = new Client({ checkUpdate: false });

// --- BAĞLANTI TEŞHİS ARAÇLARI ---
// "Bağlanıyor..." durumunda takılı kalma (giriş yapılıyor ama 'ready' hiç
// gelmiyor) sorununu teşhis etmek için: (1) geçen süreyi ekranda gösteriyoruz,
// (2) belli bir süreden sonra olası nedenleri açıkça yazıyoruz, (3) bağlantı
// kurulana kadar Discord gateway'inden gelen ham debug mesajlarını
// debug.log'a yazıyoruz (bağlandıktan sonra logun şişmemesi için kapatıyoruz).
let connectWatchdogTimer = null;
let connectStartedAt = null;
let gatewayDebugHandler = null;

function startGatewayDebugLogging() {
    if (gatewayDebugHandler) return;
    gatewayDebugHandler = (info) => {
        console.log(`[Gateway] ${info}`);
    };
    client.on('debug', gatewayDebugHandler);
}

function stopGatewayDebugLogging() {
    if (gatewayDebugHandler) {
        client.removeListener('debug', gatewayDebugHandler);
        gatewayDebugHandler = null;
    }
}

function stopConnectWatchdog() {
    if (connectWatchdogTimer) {
        clearInterval(connectWatchdogTimer);
        connectWatchdogTimer = null;
    }
}

function startConnectWatchdog() {
    stopConnectWatchdog();
    connectStartedAt = Date.now();
    startGatewayDebugLogging();

    connectWatchdogTimer = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - connectStartedAt) / 1000);
        discordStatusDetail = `Bağlanıyor... (${elapsedSec}sn)`;

        if (elapsedSec === 15 || elapsedSec === 30) {
            console.log(`[Bağlantı] ${elapsedSec} saniyedir "ready" olayı gelmedi, bekleniyor... (ayrıntılar için [Gateway] satırlarına bak)`);
        }
        if (elapsedSec >= 45) {
            console.log(`[Bağlantı] UYARI: ${elapsedSec} saniyedir bağlantı tamamlanmadı. Olası nedenler: (1) token geçersiz/hesapta ek doğrulama isteniyor, (2) ağ/VPN/güvenlik duvarı Discord gateway'ini engelliyor, (3) Discord bu girişte captcha istiyor olabilir. debug.log dosyasındaki [Gateway] satırları daha fazla ipucu verebilir.`);
            discordStatusDetail = `Bağlantı ${elapsedSec} saniyedir tamamlanmadı - debug.log'a bak`;
        }
        broadcastStatus();
    }, 5000);
}

client.on('ready', () => {
    console.log(`[Bağlantı] Giriş yapıldı: ${client.user.tag}`);
    discordStatus = 'bağlı';
    discordStatusDetail = 'Bağlı';
    stopConnectWatchdog();
    stopGatewayDebugLogging();
    broadcastStatus();
});

client.on('error', (error) => {
    console.log(`[Hata] Discord client hatası: ${error.message}`);
    discordStatus = 'hata';
    discordStatusDetail = `Bağlantı hatası: ${error.message}`;
    stopConnectWatchdog();
    broadcastStatus();
});

client.on('disconnect', () => {
    console.log('[Bağlantı] Discord bağlantısı koptu.');
    discordStatus = 'hata';
    discordStatusDetail = 'Discord bağlantısı koptu.';
    stopConnectWatchdog();
    broadcastStatus();
});

// --- İLK KURULUM: sadece Discord token gerekiyor ---
const SETUP_REQUIRED_FIELDS = ['USER_TOKEN'];

function isConfigComplete() {
    const missing = SETUP_REQUIRED_FIELDS.filter((key) => !process.env[key]);
    if (missing.length) {
        console.log(`[Kurulum] config.env yolu: ${CONFIG_ENV_PATH} (dosya var mı: ${fs.existsSync(CONFIG_ENV_PATH)}). Eksik alanlar: ${missing.join(', ')}.`);
    }
    return missing.length === 0;
}

function showSetupWindow() {
    setupWindow = new BrowserWindow({
        width: 420,
        height: 320,
        title: 'Yoklama Botu - İlk Kurulum',
        autoHideMenuBar: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    setupWindow.loadFile('setup.html');
}

ipcMain.on('save-setup', (event, values) => {
    const token = String(values.USER_TOKEN || '').trim();
    if (!token) {
        event.reply('setup-error', '"Discord Token" alanı boş bırakılamaz.');
        return;
    }

    const escaped = token.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
        fs.writeFileSync(CONFIG_ENV_PATH, `USER_TOKEN="${escaped}"\n`);
    } catch (error) {
        event.reply('setup-error', `config.env yazılamadı: ${error.message}`);
        return;
    }

    if (setupWindow) {
        setupWindow.close();
        setupWindow = null;
    }

    // Yeni config.env ile temiz bir başlangıç için uygulamayı yeniden başlat.
    app.relaunch();
    app.exit();
});

function startApp() {
    console.log('[Sistem] Yoklama Botu başlatılıyor...');
    mainWindow = new BrowserWindow({
        width: 900,
        height: 680,
        title: 'Yoklama Botu',
        autoHideMenuBar: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('yoklama.html');
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    startConnectWatchdog();
    client.login(process.env.USER_TOKEN).catch((error) => {
        console.log(`[Hata] Discord'a giriş yapılamadı: ${error.message}`);
        discordStatus = 'hata';
        discordStatusDetail = `Giriş yapılamadı: ${error.message}`;
        stopConnectWatchdog();
        broadcastStatus();
        dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Giriş Yapılamadı',
            message: `Discord'a giriş yapılamadı, token geçersiz olabilir:\n${error.message}\n\nAyarlar dosyasını (config.env) silip programı tekrar açarak token'ı yeniden girebilirsin.`,
            buttons: ['Tamam']
        });
    });
}

// --- YOKLAMA MANTIĞI ---

function getWarningTierIndex(member) {
    let highest = -1;
    WARNING_ROLES.forEach((role, index) => {
        if (member.roles.cache.has(role.id)) highest = Math.max(highest, index);
    });
    return highest;
}

function getNextWarningRole(member) {
    const currentIndex = getWarningTierIndex(member);
    if (currentIndex >= WARNING_ROLES.length - 1) return null;
    return WARNING_ROLES[currentIndex + 1];
}

// Mazaret kanalındaki son EXCUSE_LOOKBACK_MS içindeki mesajları tarar ve
// her yazardan en son mesajı (metin + tepkiler) bir Map'te toplar.
// Discord mesaj listesi en yeniden en eskiye doğru geldiği için, süre
// sınırının dışına çıkan bir mesaj görülünce tarama güvenle durdurulur.
async function fetchRecentExcuses() {
    const excuseByAuthor = new Map();

    let channel;
    try {
        channel = await client.channels.fetch(EXCUSE_CHANNEL_ID);
    } catch (error) {
        console.log(`[Yoklama] Mazaret kanalı alınamadı: ${error.message}`);
        return excuseByAuthor;
    }
    if (!channel) return excuseByAuthor;

    const cutoff = Date.now() - EXCUSE_LOOKBACK_MS;
    let beforeId;
    const MAX_PAGES = 10; // güvenlik sınırı: en fazla ~1000 mesaj taransın

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const options = { limit: 100 };
        if (beforeId) options.before = beforeId;

        let batch;
        try {
            // eslint-disable-next-line no-await-in-loop
            batch = await channel.messages.fetch(options);
        } catch (error) {
            // Mesaj geçmişi okunamıyorsa (izin sorunu vb.) taramanın tamamını
            // çökertmek yerine o ana kadar toplananlarla devam ediyoruz.
            console.log(`[Yoklama] Mazaret kanalı mesajları alınamadı (sayfa ${page + 1}), o ana kadar toplananlarla devam ediliyor: ${error.message}`);
            break;
        }
        if (batch.size === 0) break;

        let reachedCutoff = false;
        for (const message of batch.values()) {
            if (message.createdTimestamp < cutoff) {
                reachedCutoff = true;
                break;
            }
            const existing = excuseByAuthor.get(message.author.id);
            if (!existing || message.createdTimestamp > existing.createdTimestamp) {
                excuseByAuthor.set(message.author.id, {
                    content: message.content,
                    createdTimestamp: message.createdTimestamp,
                    reactions: [...message.reactions.cache.values()].map((reaction) => ({
                        emoji: reaction.emoji.name || reaction.emoji.toString(),
                        count: reaction.count,
                    })),
                });
            }
        }

        beforeId = batch.last() ? batch.last().id : undefined;
        if (reachedCutoff || batch.size < 100) break;
    }

    return excuseByAuthor;
}

async function runYoklamaScan() {
    let guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        try {
            guild = await client.guilds.fetch(GUILD_ID);
        } catch (error) {
            throw new Error(`Sunucu alınamadı (GUILD_ID yanlış olabilir ya da bu hesap o sunucuda değil): ${error.message}`);
        }
    }
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!guild.shard) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) henüz hazır değil - hesap sunucuya tam bağlanamamış olabilir. Birkaç saniye bekleyip tekrar dene; sorun devam ederse hesabın gerçekten bu sunucuda üye olduğundan emin ol.');
    }

    try {
        await guild.members.fetch();
    } catch (error) {
        throw new Error(`Üye listesi alınamadı - "Missing Access" ise büyük ihtimalle bu hesabın sunucuda üye listesini görme yetkisi yok (Rol Yönetimi, Üyeleri At/Yasakla gibi bir yetkisi olması gerekebilir): ${error.message}`);
    }

    const inVoiceIds = new Set();
    guild.channels.cache.forEach((channel) => {
        if (channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE') {
            channel.members.forEach((member) => inVoiceIds.add(member.id));
        }
    });

    const attendanceMembers = guild.members.cache.filter((member) => (
        ATTENDANCE_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))
    ));

    const absentees = [...attendanceMembers.values()].filter((member) => !inVoiceIds.has(member.id));

    const excuseByAuthor = await fetchRecentExcuses();

    const results = absentees.map((member) => {
        const excuse = excuseByAuthor.get(member.id) || null;
        const nextRole = getNextWarningRole(member);
        const currentTierIndex = getWarningTierIndex(member);
        return {
            id: member.id,
            displayName: member.displayName,
            tag: member.user.tag,
            avatarURL: member.displayAvatarURL({ size: 64 }),
            excuseText: excuse ? excuse.content : null,
            excuseReactions: excuse ? excuse.reactions : [],
            excuseAt: excuse ? excuse.createdTimestamp : null,
            currentTierLabel: currentTierIndex >= 0 ? WARNING_ROLES[currentTierIndex].label : null,
            nextTierLabel: nextRole ? nextRole.label : null,
            isMaxTier: !nextRole,
        };
    });

    results.sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));

    console.log(`[Yoklama] Tarama tamamlandı: ${attendanceMembers.size} kişi kontrol edildi, ${results.length} kişi sesde değil.`);

    return {
        scannedAt: Date.now(),
        totalChecked: attendanceMembers.size,
        totalInVoice: attendanceMembers.size - absentees.length,
        absentees: results,
    };
}

// Komut gönderildikten sonra rol botunun aynı kanala düşürdüğü cevabı en
// fazla birkaç saniye bekleyip yakalamaya çalışır (best-effort). Bot cevap
// vermezse ya da yakalanamazsa null döner, bu durumda komutun Discord'a
// başarıyla iletildiği (ama sonucun doğrulanamadığı) kabul edilir.
function waitForRoleBotReply(timeoutMs = 6000) {
    return new Promise((resolve) => {
        const onMessage = (message) => {
            if (message.channelId !== ROLE_COMMAND_CHANNEL_ID) return;
            if (message.author.id !== ROLE_BOT_ID) return;
            cleanup();
            const embedText = message.embeds && message.embeds[0]
                ? (message.embeds[0].description || message.embeds[0].title || '')
                : '';
            resolve(message.content || embedText || null);
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve(null);
        }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            client.removeListener('messageCreate', onMessage);
        }
        client.on('messageCreate', onMessage);
    });
}

async function giveNextWarningRole(memberId) {
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!guild.shard) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) henüz hazır değil - hesap sunucuya tam bağlanamamış olabilir. Birkaç saniye bekleyip tekrar dene.');
    }

    let member;
    try {
        member = await guild.members.fetch(memberId);
    } catch (error) {
        throw new Error(`Kişi bilgisi alınamadı: ${error.message}`);
    }

    const nextRole = getNextWarningRole(member);
    if (!nextRole) {
        return { ok: false, reason: 'max', currentTierLabel: WARNING_ROLES[WARNING_ROLES.length - 1].label };
    }

    let commandChannel;
    try {
        commandChannel = await client.channels.fetch(ROLE_COMMAND_CHANNEL_ID);
    } catch (error) {
        throw new Error(`Komut kanalı alınamadı (ROLE_COMMAND_CHANNEL_ID yanlış olabilir ya da hesap bu kanalı göremiyor): ${error.message}`);
    }
    if (!commandChannel) throw new Error('Komut kanalı bulunamadı, ROLE_COMMAND_CHANNEL_ID hatalı olabilir.');

    const replyPromise = waitForRoleBotReply();
    await commandChannel.sendSlash(ROLE_BOT_ID, 'rol-ver', memberId, nextRole.id);
    const botReply = await replyPromise;

    console.log(`[Yoklama] ${member.user.tag} (${memberId}) için "/rol-ver" gönderildi: ${nextRole.label} (${nextRole.id}). Bot cevabı: ${botReply || '(yakalanamadı)'}`);
    return { ok: true, givenLabel: nextRole.label, botReply };
}

ipcMain.handle('yoklama-tara', async () => {
    try {
        const data = await runYoklamaScan();
        return { ok: true, data };
    } catch (error) {
        console.log(`[Yoklama] Tarama hatası: ${error.message}`);
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('yoklama-rol-ver', async (event, memberId) => {
    try {
        return await giveNextWarningRole(memberId);
    } catch (error) {
        console.log(`[Yoklama] Rol verme hatası (${memberId}): ${error.message}`);
        return { ok: false, error: error.message };
    }
});

// --- TEK SEFERLİK MANUEL TARAMA ZAMANLAYICISI ---
let scheduledScanTimer = null;
let scheduledScanAt = null;

ipcMain.handle('yoklama-zamanla', (event, ms) => {
    if (scheduledScanTimer) clearTimeout(scheduledScanTimer);

    scheduledScanAt = Date.now() + ms;
    scheduledScanTimer = setTimeout(async () => {
        scheduledScanTimer = null;
        scheduledScanAt = null;
        console.log('[Yoklama] Zamanlanmış tarama başlıyor...');
        try {
            const data = await runYoklamaScan();
            if (mainWindow) mainWindow.webContents.send('yoklama-otomatik-sonuc', { ok: true, data });
        } catch (error) {
            console.log(`[Yoklama] Zamanlanmış tarama hatası: ${error.message}`);
            if (mainWindow) mainWindow.webContents.send('yoklama-otomatik-sonuc', { ok: false, error: error.message });
        }
    }, ms);

    console.log(`[Yoklama] Sonraki tarama zamanlandı: ${new Date(scheduledScanAt).toLocaleString('tr-TR')}`);
    return { ok: true, scheduledAt: scheduledScanAt };
});

ipcMain.handle('yoklama-zamanlamayi-iptal-et', () => {
    if (scheduledScanTimer) {
        clearTimeout(scheduledScanTimer);
        scheduledScanTimer = null;
        scheduledScanAt = null;
        return { ok: true };
    }
    return { ok: false };
});

ipcMain.handle('yoklama-zamanlama-durumu', () => ({ scheduledAt: scheduledScanAt }));

ipcMain.on('request-status', () => broadcastStatus());

// --- OTOMATİK GÜNCELLEME ---
// Uygulama her açıldığında GitHub'daki en son release ile kendi versiyonunu
// karşılaştırır; yeni bir sürüm varsa indirir, kurar ve uygulamayı yeniden başlatır.
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');

const APP_VERSION = require('./package.json').version;
const UPDATE_REPO_OWNER = 'anilkee';
const UPDATE_REPO_NAME = 'yoklama-botu';
const UPDATE_ASSET_NAME = 'YoklamaBotu-win32-x64.zip';

function compareVersions(a, b) {
    const partsA = String(a).split('.').map(Number);
    const partsB = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

function httpsGetJson(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('Çok fazla yönlendirme.'));
            return;
        }
        https.get(url, { headers: { 'User-Agent': 'YoklamaBotu-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                httpsGetJson(res.headers.location, redirectCount + 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

function httpsDownloadFile(url, destPath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) {
            reject(new Error('Çok fazla yönlendirme.'));
            return;
        }
        https.get(url, { headers: { 'User-Agent': 'YoklamaBotu-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                httpsDownloadFile(res.headers.location, destPath, redirectCount + 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => fileStream.close(() => resolve()));
            fileStream.on('error', reject);
        }).on('error', reject);
    });
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`"${command}" çıkış kodu ${code}: ${stderr}`));
        });
    });
}

// Bir promise'i belirtilen sürede tamamlanmazsa reddeder - indirme/açma gibi
// adımların sonsuza kadar asılı kalıp uygulamayı hiç açılmaz hale getirmesini
// engellemek için (bkz. "bot açılmıyor" raporu: Expand-Archive büyük zip'lerde
// çok yavaş kalabiliyor, hiçbir görünür pencere olmadan).
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} zaman aşımına uğradı (${Math.round(ms / 1000)}sn)`));
        }, ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

// Windows 10/11'de yerleşik gelen tar.exe (bsdtar), PowerShell'in
// Expand-Archive'ından çok daha hızlı - node_modules gibi binlerce küçük
// dosya içeren zip'lerde Expand-Archive dakikalarca sürüp hiçbir geri
// bildirim vermeden asılı kalabiliyordu. tar başarısız olursa Expand-Archive'a
// geri dönüyoruz.
async function extractZip(zipPath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    try {
        await runCommand('tar.exe', ['-xf', zipPath, '-C', destDir]);
        return;
    } catch (error) {
        console.log(`[Güncelleme] tar.exe ile açılamadı, PowerShell Expand-Archive deneniyor: ${error.message}`);
    }
    await runCommand('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ]);
}

function showUpdateProgressWindow() {
    if (updateProgressWindow) return;
    updateProgressWindow = new BrowserWindow({
        width: 380,
        height: 150,
        title: 'Yoklama Botu - Güncelleniyor',
        autoHideMenuBar: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    updateProgressWindow.loadFile('update-progress.html');
    updateProgressWindow.on('closed', () => {
        updateProgressWindow = null;
    });
}

function setUpdateProgressText(text) {
    if (updateProgressWindow) updateProgressWindow.webContents.send('update-progress', text);
}

// Yeni sürüm bulunup uygulama kapatılmak üzereyse true döner (çağıran taraf
// bu durumda pencere açma gibi normal başlangıç adımlarını atlamalı).
async function checkForUpdates() {
    if (!app.isPackaged) {
        console.log('[Güncelleme] Geliştirme ortamında çalışıyor (paketlenmemiş), güncelleme kontrolü atlanıyor.');
        return false;
    }

    console.log(`[Güncelleme] Mevcut sürüm: ${APP_VERSION}. GitHub'dan kontrol ediliyor...`);
    let release;
    try {
        release = await withTimeout(
            httpsGetJson(`https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/latest`),
            20000,
            'Sürüm bilgisi alma',
        );
    } catch (error) {
        console.log(`[Güncelleme] Sürüm bilgisi alınamadı, mevcut sürümle devam ediliyor: ${error.message}`);
        return false;
    }

    const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
    if (!latestVersion || compareVersions(latestVersion, APP_VERSION) <= 0) {
        console.log(`[Güncelleme] Güncel (GitHub'daki en son sürüm: ${latestVersion || 'bilinmiyor'}).`);
        return false;
    }

    const asset = (release.assets || []).find((a) => a.name === UPDATE_ASSET_NAME);
    if (!asset) {
        console.log(`[Güncelleme] v${latestVersion} bulundu ama release'de "${UPDATE_ASSET_NAME}" adında dosya yok, atlanıyor.`);
        return false;
    }

    console.log(`[Güncelleme] Yeni sürüm bulundu: v${latestVersion}. İndiriliyor...`);
    showUpdateProgressWindow();
    setUpdateProgressText(`Yeni sürüm indiriliyor (v${latestVersion})...`);

    const stagingDir = path.join(os.tmpdir(), 'yoklama-botu-update');
    const zipPath = path.join(stagingDir, 'update.zip');
    const extractDir = path.join(stagingDir, 'extracted');

    try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.mkdirSync(stagingDir, { recursive: true });

        await withTimeout(httpsDownloadFile(asset.browser_download_url, zipPath), 8 * 60 * 1000, 'İndirme');
        console.log('[Güncelleme] İndirme tamamlandı, açılıyor...');
        setUpdateProgressText('İndirme tamamlandı, açılıyor...');

        await withTimeout(extractZip(zipPath, extractDir), 4 * 60 * 1000, 'Açma işlemi');

        const installRoot = path.dirname(process.execPath);
        const exeName = path.basename(process.execPath);
        const pid = process.pid;

        // Bu süreç tamamen kapanana kadar bekleyip (exe dosya kilidi bırakılsın
        // diye), yeni dosyaların üzerine kopyalayıp uygulamayı yeniden açan
        // ve kendini silen küçük bir betik.
        const batPath = path.join(stagingDir, 'apply-update.bat');
        const batContent = [
            '@echo off',
            ':wait',
            `tasklist /FI "PID eq ${pid}" 2>NUL | find /I "${pid}" >NUL`,
            'if not errorlevel 1 (',
            '  timeout /t 1 /nobreak >NUL',
            '  goto wait',
            ')',
            `xcopy /E /Y /I "${extractDir}\\*" "${installRoot}\\" >NUL`,
            `start "" "${path.join(installRoot, exeName)}"`,
            'del "%~f0"',
        ].join('\r\n');
        fs.writeFileSync(batPath, batContent);

        console.log(`[Güncelleme] v${latestVersion} kuruluyor, uygulama yeniden başlatılacak...`);
        setUpdateProgressText('Kuruluyor, birazdan yeniden açılacak...');

        spawn('cmd.exe', ['/c', batPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        }).unref();

        app.quit();
        return true;
    } catch (error) {
        console.log(`[Güncelleme] Güncelleme uygulanamadı, mevcut sürümle devam ediliyor: ${error.message}`);
        if (updateProgressWindow) {
            updateProgressWindow.close();
            updateProgressWindow = null;
        }
        return false;
    }
}

app.on('ready', async () => {
    const isUpdating = await checkForUpdates().catch((error) => {
        console.log(`[Güncelleme] Beklenmeyen hata: ${error.message}`);
        return false;
    });
    if (isUpdating) return;

    if (isConfigComplete()) {
        startApp();
    } else {
        console.log('[Kurulum] config.env eksik, kurulum ekranı gösteriliyor...');
        if (isRunningFromTemporaryLocation()) {
            console.log(`[Kurulum] UYARI: Uygulama geçici bir klasörden çalışıyor (${__dirname}) - ayarlar kalıcı olmayabilir.`);
            await dialog.showMessageBox({
                type: 'warning',
                title: 'Geçici Klasörden Çalışıyor',
                message: 'Yoklama Botu şu an geçici bir klasörden çalışıyor gibi görünüyor (muhtemelen ZIP dosyasının içinden, hiç çıkarmadan açıldı).\n\nBu durumda girdiğin ayarlar (Discord token) her açılışta sıfırlanır - çünkü Windows bu klasörü her seferinde yeniden, geçici olarak oluşturuyor.\n\nÇözüm: klasörü ZIP dosyasının içinden Masaüstü gibi kalıcı bir klasöre çıkar (klasöre sağ tık → "Tümünü Çıkart") ve programı oradan çalıştır.',
                buttons: ['Anladım']
            });
        }
        showSetupWindow();
    }
});

app.on('window-all-closed', () => {
    app.quit();
});

// Pencere kapanınca arkada Discord bağlantısı/soket açık kalmasın diye
// süreç tamamen çıkmadan önce client'ı düzgünce kapatıyoruz.
app.on('before-quit', () => {
    try {
        client.destroy();
    } catch (error) {
        // zaten kapanıyor, önemli değil
    }
});
