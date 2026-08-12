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
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    writeDebugLog(line);
    // Panelde canlı log gösterebilmek için her satırı ekrana da yolluyoruz.
    // mainWindow henüz yoksa (kurulum ekranı, güncelleme aşaması vb.) sorun
    // değil - sadece debug.log'a yazılmış olur.
    try {
        if (typeof mainWindow !== 'undefined' && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('log-entry', { time: Date.now(), message: line });
        }
    } catch (error) {
        // pencere henüz hazır değilse sessizce geç
    }
};

// Discord kütüphanesi içinde (örn. gateway paket işleyicilerinde) sessizce
// reddedilen bir promise ya da fırlatılan bir istisna olursa daha önce
// hiçbir yere yazılmıyordu - "ready" hiç gelmeden bağlantının takılı kalması
// büyük ihtimalle böyle bir şeyden kaynaklanıyor. Artık bunları da yakalayıp
// debug.log'a yazıyoruz.
process.on('unhandledRejection', (reason) => {
    console.log(`[Hata] Yakalanmamış promise reddi: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on('uncaughtException', (error) => {
    console.log(`[Hata] Yakalanmamış istisna: ${error && error.stack ? error.stack : error}`);
});

const { app, BrowserWindow, ipcMain, dialog } = require('electron');

// Aynı anda birden fazla kopya açılmasını engelliyoruz.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
    process.exit(0);
}

app.setAppUserModelId('com.pvpyoklamabotu.app');

app.on('second-instance', () => {
    const existingWindow = mainWindow || setupWindow || updateProgressWindow;
    if (existingWindow) {
        if (existingWindow.isMinimized()) existingWindow.restore();
        existingWindow.focus();
    }
});

const { Client } = require('discord.js-selfbot-v13');

// --- KÜTÜPHANE YAMASI: READY paketinde çökmeyi önle ---
// KÖK NEDEN (debug.log ile teşhis edildi): Bazı hesaplarda Discord,
// READY paketinde "friend_source_flags" alanını null gönderiyor.
// discord.js-selfbot-v13'ün ClientUserSettingManager._patch metodu bunu
// kontrolsüz okuyup "Cannot read properties of null (reading 'all')" ile
// çöküyor. Bu çökme READY.js içinde yakalanmadığı için, sunucu bilgisi hiç
// önbelleğe düşmüyor ve uygulama sonsuza kadar "bağlanıyor" görünüyor.
// Kütüphaneyi değiştiremeyeceğimiz için sorunlu metodu burada, Client
// oluşturulmadan önce, hatayı yutacak şekilde yamıyoruz.
try {
    // eslint-disable-next-line global-require
    const ClientUserSettingManager = require('discord.js-selfbot-v13/src/managers/ClientUserSettingManager');
    const originalSettingsPatch = ClientUserSettingManager.prototype._patch;
    ClientUserSettingManager.prototype._patch = function patchedSettingsPatch(data) {
        try {
            return originalSettingsPatch.call(this, data);
        } catch (error) {
            console.log(`[Yama] Kullanıcı ayarları işlenirken hata oluştu, atlanıp devam ediliyor (uygulamanın çalışmasını etkilemez): ${error.message}`);
            return this;
        }
    };
    console.log('[Yama] ClientUserSettingManager._patch çökmeye karşı korumaya alındı.');
} catch (error) {
    console.log(`[Yama] ClientUserSettingManager yaması uygulanamadı (kütüphane sürümü değişmiş olabilir, atlanıyor): ${error.message}`);
}

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

// Toplu uyarı verildiğinde duyuru mesajının (# Uyarı alan / # Uyarı veren ...)
// gönderileceği kanal.
const WARNING_ANNOUNCE_CHANNEL_ID = '1483232323674701835';

// Toplu uyarı verilen kişi başına gönderimler arasında küçük bir bekleme -
// arka arkaya çok hızlı slash komutu göndermek rate limit/şüpheli davranış
// riskini artırır.
const BULK_WARNING_DELAY_MS = 1200;

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

        // Not: Bazı hesaplarda ilk bağlantı normalden çok uzun sürebiliyor
        // (soket seviyesinde bağlantı hemen kuruluyor ama kütüphane hesap
        // verisini işlerken yavaş kalabiliyor). Pencere kapatılırsa (uygulama
        // "kapanınca herşey kapansın" şeklinde tasarlandığı için) süreç
        // tamamen sonlanıyor ve bağlanma şansı kalmıyor - bu yüzden burada
        // kullanıcıyı asla "bir şey bozuk" gibi göstermeyip beklemesini
        // istiyoruz; hedef sunucu önbelleğe düşer düşmez otomatik devam eder.
        if (elapsedSec < 60) {
            discordStatusDetail = `Bağlanıyor... (${elapsedSec}sn) - kapatma, sürebilir`;
        } else {
            discordStatusDetail = `Hâlâ bağlanıyor (${elapsedSec}sn) - lütfen pencereyi kapatmadan bekle`;
        }

        if (elapsedSec === 15 || elapsedSec === 30 || elapsedSec === 60 || elapsedSec === 120) {
            console.log(`[Bağlantı] ${elapsedSec} saniyedir "ready" olayı gelmedi. Bu hesapta bilinen bir davranış olabilir - pencere kapatılmadığı sürece arka planda denemeye devam ediyor, hedef sunucu önbelleğe düşünce otomatik devam edecek. (ayrıntılar için [Gateway] ve [Hata] satırlarına bak)`);
        }
        broadcastStatus();
    }, 5000);
}

// "ready" olayı hiç gelmese bile (bkz. yukarıdaki not), bize gerçekten lazım
// olan tek şey hedef sunucunun önbellekte olması - bu genelde kütüphanenin
// kendi "ready" olayından çok daha erken gerçekleşiyor. Bu yüzden ayrıca bunu
// da bağımsız olarak yokluyoruz; hangisi önce olursa "bağlı" sayıyoruz.
let readyPollTimer = null;

function markConnected(source) {
    if (discordStatus === 'bağlı') return;
    console.log(`[Bağlantı] Giriş yapıldı (${source}): ${client.user ? client.user.tag : 'bilinmiyor'}`);
    discordStatus = 'bağlı';
    discordStatusDetail = 'Bağlı';
    stopConnectWatchdog();
    stopGatewayDebugLogging();
    if (readyPollTimer) {
        clearInterval(readyPollTimer);
        readyPollTimer = null;
    }
    broadcastStatus();
}

function startReadyPolling() {
    if (readyPollTimer) clearInterval(readyPollTimer);
    readyPollTimer = setInterval(() => {
        if (client.user && client.guilds.cache.has(GUILD_ID)) {
            markConnected('yedek kontrol - hedef sunucu önbellekte');
        }
    }, 1000);
}

client.on('ready', () => markConnected('ready olayı'));

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
        title: 'PvP Yoklama Botu - İlk Kurulum',
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
    console.log('[Sistem] PvP Yoklama Botu başlatılıyor...');
    mainWindow = new BrowserWindow({
        width: 960,
        height: 720,
        title: 'PvP Yoklama Botu',
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
    startReadyPolling();
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

    // Mazaret sadece sesde OLMAYANLAR için anlamlı olduğundan, kanalı yine de
    // tarıyoruz ama sesde olanlara eşleştirmiyoruz.
    const excuseByAuthor = await fetchRecentExcuses();

    const results = [...attendanceMembers.values()].map((member) => {
        const inVoice = inVoiceIds.has(member.id);
        const excuse = !inVoice ? (excuseByAuthor.get(member.id) || null) : null;
        const nextRole = getNextWarningRole(member);
        const currentTierIndex = getWarningTierIndex(member);
        return {
            id: member.id,
            displayName: member.displayName,
            tag: member.user.tag,
            avatarURL: member.displayAvatarURL({ size: 64 }),
            inVoice,
            excuseText: excuse ? excuse.content : null,
            excuseReactions: excuse ? excuse.reactions : [],
            excuseAt: excuse ? excuse.createdTimestamp : null,
            currentTierLabel: currentTierIndex >= 0 ? WARNING_ROLES[currentTierIndex].label : null,
            nextTierLabel: nextRole ? nextRole.label : null,
            isMaxTier: !nextRole,
        };
    });

    // Sesde olmayanlar (dikkat gerektirenler) üstte, sesde olanlar altta.
    results.sort((a, b) => {
        if (a.inVoice !== b.inVoice) return a.inVoice ? 1 : -1;
        return a.displayName.localeCompare(b.displayName, 'tr');
    });

    const totalInVoice = results.filter((m) => m.inVoice).length;
    console.log(`[Yoklama] Tarama tamamlandı: ${results.length} yetkili kontrol edildi, ${totalInVoice} sesde, ${results.length - totalInVoice} sesde değil.`);

    return {
        scannedAt: Date.now(),
        totalChecked: results.length,
        totalInVoice,
        members: results,
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

async function giveNextWarningRole(memberId, reason) {
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

    // Tekli akıştan (bulk değil) çağrıldıysa - yani bir sebep verildiyse - hemen
    // burada duyuru mesajını da gönder. Toplu akış kendi toplu duyurusunu ayrı
    // gönderdiği için bu fonksiyonu reason olmadan çağırıyor, burada tekrar
    // duyuru göndermiyoruz (aksi halde toplu uyarıda kişi başı ayrı mesaj çıkardı).
    let announceError = null;
    if (reason) {
        try {
            const channel = await client.channels.fetch(WARNING_ANNOUNCE_CHANNEL_ID);
            if (!channel) throw new Error('Uyarı kanalı bulunamadı, WARNING_ANNOUNCE_CHANNEL_ID hatalı olabilir.');
            await channel.send(buildSingleWarningAnnounceMessage(memberId, nextRole.id, reason));
        } catch (error) {
            announceError = error.message;
            console.log(`[Yoklama] Tekli uyarı duyuru mesajı gönderilemedi: ${error.message}`);
        }
    }

    return { ok: true, givenLabel: nextRole.label, botReply, announceError };
}

function formatWarningEndDate() {
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const day = String(end.getDate()).padStart(2, '0');
    const month = String(end.getMonth() + 1).padStart(2, '0');
    const year = end.getFullYear();
    return `${day}.${month}.${year}`;
}

// Tekli uyarıda toplu uyarıdan farklı olarak "# Uyarı :" satırında tüm
// merdiven değil, o kişiye o an verilen tek rol gösterilir (hangisi verildiği
// zaten kesin biliniyor).
function buildSingleWarningAnnounceMessage(memberId, givenRoleId, reason) {
    const selfId = client.user.id;
    return [
        `# Uyarı alan :  <@${memberId}>`,
        `# Uyarı veren : <@${selfId}>`,
        `# Uyarı sebebi : ${reason}`,
        `# Uyarı :  <@&${givenRoleId}>`,
        `# Uyarı bitiş tarihi : ${formatWarningEndDate()}`,
    ].join('\n');
}

function buildWarningAnnounceMessage(warnedMemberIds, reason) {
    const warnedMentions = warnedMemberIds.map((id) => `<@${id}>`).join('  ');
    const ladderMentions = WARNING_ROLES.map((role) => `<@&${role.id}>`).join(' Olanlara ');
    const selfId = client.user.id;
    return [
        `# Uyarı alan :  ${warnedMentions}`,
        `# Uyarı veren : <@${selfId}>`,
        `# Uyarı sebebi : ${reason}`,
        `# Uyarı : ${ladderMentions}`,
        `# Uyarı bitiş tarihi : ${formatWarningEndDate()}`,
    ].join('\n');
}

// Seçilen birden fazla kişiye tek tek (kendi merdiven kademesine göre) rol
// verir, en üst kademede olanları atlayıp bildirir, ardından tek bir duyuru
// mesajı gönderir. İlerlemeyi mainWindow'a olaylarla bildirir.
async function giveBulkWarning(memberIds, reason) {
    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
    if (!guild) throw new Error('Sunucu bulunamadı, GUILD_ID hatalı olabilir.');
    if (!guild.shard) {
        throw new Error('Bu sunucu için gateway bağlantısı (shard) henüz hazır değil - hesap sunucuya tam bağlanamamış olabilir.');
    }

    const warned = []; // { id, givenLabel }
    const skipped = []; // { id, tag } - zaten en üst kademede olanlar
    const failed = []; // { id, error }

    for (let i = 0; i < memberIds.length; i += 1) {
        const memberId = memberIds[i];

        if (mainWindow) {
            mainWindow.webContents.send('yoklama-toplu-uyari-ilerleme', {
                current: i + 1,
                total: memberIds.length,
            });
        }

        try {
            // eslint-disable-next-line no-await-in-loop
            const result = await giveNextWarningRole(memberId);
            if (result.ok) {
                warned.push({ id: memberId, givenLabel: result.givenLabel });
            } else if (result.reason === 'max') {
                let tag = memberId;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const member = await guild.members.fetch(memberId);
                    tag = member.user.tag;
                } catch (error) {
                    // tag alınamazsa ID ile devam
                }
                skipped.push({ id: memberId, tag });
            }
        } catch (error) {
            failed.push({ id: memberId, error: error.message });
        }

        if (i < memberIds.length - 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, BULK_WARNING_DELAY_MS));
        }
    }

    let announceError = null;
    if (warned.length > 0) {
        try {
            const channel = await client.channels.fetch(WARNING_ANNOUNCE_CHANNEL_ID);
            if (!channel) throw new Error('Uyarı kanalı bulunamadı, WARNING_ANNOUNCE_CHANNEL_ID hatalı olabilir.');
            await channel.send(buildWarningAnnounceMessage(warned.map((w) => w.id), reason));
            console.log(`[Yoklama] Toplu uyarı duyurusu gönderildi: ${warned.length} kişi.`);
        } catch (error) {
            announceError = error.message;
            console.log(`[Yoklama] Toplu uyarı duyuru mesajı gönderilemedi: ${error.message}`);
        }
    }

    return { warned, skipped, failed, announceError };
}

ipcMain.handle('yoklama-toplu-uyari-ver', async (event, memberIds, reason) => {
    try {
        return { ok: true, data: await giveBulkWarning(memberIds, reason) };
    } catch (error) {
        console.log(`[Yoklama] Toplu uyarı hatası: ${error.message}`);
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('yoklama-tara', async () => {
    try {
        const data = await runYoklamaScan();
        return { ok: true, data };
    } catch (error) {
        console.log(`[Yoklama] Tarama hatası: ${error.message}`);
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('yoklama-rol-ver', async (event, memberId, reason) => {
    try {
        return await giveNextWarningRole(memberId, reason);
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
        title: 'PvP Yoklama Botu - Güncelleniyor',
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
        // ve kendini silen küçük bir betik. WAITCOUNT ile bekleme süresine üst
        // sınır koyuyoruz - süreç bir türlü kapanmazsa sonsuza kadar takılı
        // kalmak yerine 90 saniye sonra yine de kopyalamaya geçiyor.
        const batPath = path.join(stagingDir, 'apply-update.bat');
        const vbsPath = path.join(stagingDir, 'apply-update.vbs');
        const batContent = [
            '@echo off',
            'setlocal enabledelayedexpansion',
            'set /a WAITCOUNT=0',
            ':wait',
            `tasklist /FI "PID eq ${pid}" 2>NUL | find /I "${pid}" >NUL`,
            'if not errorlevel 1 (',
            '  set /a WAITCOUNT+=1',
            '  if !WAITCOUNT! GEQ 90 goto copy',
            '  timeout /t 1 /nobreak >NUL',
            '  goto wait',
            ')',
            ':copy',
            `xcopy /E /Y /I /Q "${extractDir}\\*" "${installRoot}\\" >NUL`,
            `start "" "${path.join(installRoot, exeName)}"`,
            `del "${vbsPath}"`,
            'del "%~f0"',
        ].join('\r\n');
        fs.writeFileSync(batPath, batContent);

        // cmd.exe'yi doğrudan spawn etmek Windows'ta windowsHide:true'ya rağmen
        // bazen kısa süreliğine boş/metin akan bir konsol penceresi
        // bırakabiliyordu (bildirilen "cmd penceresi geliyor" sorunu). Bunun
        // yerine .bat'ı WScript.Shell üzerinden tamamen gizli (0 = pencere yok)
        // çalıştıran bir .vbs betiği kullanıyoruz - Windows'ta bir komutu
        // görünmez şekilde başlatmanın en güvenilir yolu bu.
        const vbsContent = [
            'Set objShell = CreateObject("WScript.Shell")',
            `objShell.Run """${batPath}""", 0, False`,
        ].join('\r\n');
        fs.writeFileSync(vbsPath, vbsContent);

        console.log(`[Güncelleme] v${latestVersion} kuruluyor, uygulama yeniden başlatılacak...`);
        setUpdateProgressText('Kuruluyor, birazdan yeniden açılacak...');

        spawn('wscript.exe', [vbsPath], {
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
                message: 'PvP Yoklama Botu şu an geçici bir klasörden çalışıyor gibi görünüyor (muhtemelen ZIP dosyasının içinden, hiç çıkarmadan açıldı).\n\nBu durumda girdiğin ayarlar (Discord token) her açılışta sıfırlanır - çünkü Windows bu klasörü her seferinde yeniden, geçici olarak oluşturuyor.\n\nÇözüm: klasörü ZIP dosyasının içinden Masaüstü gibi kalıcı bir klasöre çıkar (klasöre sağ tık → "Tümünü Çıkart") ve programı oradan çalıştır.',
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
