// electron-packager, Electron/Chromium'un ~55 dil için .pak dosyasını olduğu
// gibi pakete kopyalıyor (~37 MB) - uygulama tamamen Türkçe ve menü çubuğu
// zaten gizli (autoHideMenuBar) olduğu için bu dosyaların neredeyse tamamı
// hiç kullanılmıyor. Build sonrasında sadece tr/en-US dışındakileri silerek
// paket boyutunu (ve dolayısıyla hem yayınlama hem indirme süresini) önemli
// ölçüde küçültüyoruz.
const fs = require('fs');
const path = require('path');

const KEEP_LOCALES = new Set(['tr.pak', 'en-US.pak']);

function findLocalesDirs(root) {
    const found = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (entry.name === 'locales') {
                found.push(path.join(root, entry.name));
            } else if (entry.name !== 'node_modules') {
                found.push(...findLocalesDirs(path.join(root, entry.name)));
            }
        }
    }
    return found;
}

const buildRoot = path.join(__dirname, '..', 'build');
if (!fs.existsSync(buildRoot)) {
    console.log('[trim-locales] build/ klasörü yok, atlanıyor.');
    process.exit(0);
}

const localesDirs = findLocalesDirs(buildRoot);
if (localesDirs.length === 0) {
    console.log('[trim-locales] locales klasörü bulunamadı, atlanıyor.');
    process.exit(0);
}

let removedCount = 0;
let removedBytes = 0;

for (const dir of localesDirs) {
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.pak') || KEEP_LOCALES.has(file)) continue;
        const filePath = path.join(dir, file);
        removedBytes += fs.statSync(filePath).size;
        fs.rmSync(filePath);
        removedCount += 1;
    }
}

console.log(`[trim-locales] ${removedCount} dil dosyası silindi (${(removedBytes / 1024 / 1024).toFixed(1)} MB), sadece ${[...KEEP_LOCALES].join(', ')} bırakıldı.`);
