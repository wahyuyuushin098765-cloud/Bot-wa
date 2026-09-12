const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const Groq = require('groq-sdk');
const http = require('http');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const msgMemory = {};
let currentQR = null;
let isConnected = false;

// Web server QR
const server = http.createServer(async (req, res) => {
    if (isConnected) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif;color:green">✅ Bot sudah terhubung!</h2>');
        return;
    }
    if (!currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2 style="font-family:sans-serif">⏳ Menunggu QR... refresh halaman ini.</h2>');
        return;
    }
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><meta http-equiv="refresh" content="15">
            <style>body{font-family:sans-serif;text-align:center;padding:30px}</style></head>
            <body><h2>Scan QR ini dengan WhatsApp</h2>
            <img src="${qrImage}" style="width:300px;height:300px"/>
            <p style="color:gray">Halaman otomatis refresh tiap 15 detik</p></body></html>`);
    } catch (e) {
        res.writeHead(500);
        res.end('Error generate QR');
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Web server aktif');
});

// Gaya penyampaian yang dikenali AI → nama file di /stickers
const VALID_STYLES = ['baiklah', 'bingung', 'kesal', 'menggoda', 'ragu', 'sok_keren', 'tidak_setuju'];
const STICKER_DIR = path.join(__dirname, 'stickers');

// Cari file sticker tetap untuk gaya tsb: stickers/<gaya>.(jpg|jpeg|png|webp)
function pickStickerFile(style) {
    const exts = ['webp', 'png', 'jpg', 'jpeg'];
    for (const ext of exts) {
        const filePath = path.join(STICKER_DIR, `${style}.${ext}`);
        if (fs.existsSync(filePath)) return filePath;
    }
    return null;
}

// Convert gambar apapun jadi buffer webp sticker WhatsApp yang valid
async function imageToWaSticker(filePath) {
    const sticker = new Sticker(filePath, {
        pack: 'Hiura AE',
        author: 'AE Bot',
        type: StickerTypes.FULL,
        quality: 70
    });
    return sticker.toBuffer();
}

async function startBot() {
    const authDir = process.env.RAILWAY_VOLUME_MOUNT_PATH
        ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'auth_info')
        : 'auth_info';
    console.log(`📁 Auth folder: ${authDir}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome", "Chrome", "120.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            isConnected = false;
            console.log('QR baru tersedia — buka Railway public URL di browser');
        }
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log(`✅ Bot terhubung! JID: ${sock.user?.id}, LID: ${sock.authState.creds.me?.lid}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const pushName = msg.pushName || "seseorang";
        const text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || "";

        if (!text) return;

        // Grup: balas kalau di-mention atau reply ke pesan bot
        if (isGroup) {
            const meId = sock.authState.creds.me?.id || sock.user?.id || '';
            const meLid = sock.authState.creds.me?.lid || sock.user?.lid || '';
            const botIds = [meId, meLid]
                .filter(Boolean)
                .map(j => j.split('@')[0].split(':')[0]);

            const ctxInfo = msg.message.extendedTextMessage?.contextInfo;
            const mentionedJids = ctxInfo?.mentionedJid || [];

            // Cek mention — bandingkan dengan nomor HP dan LID bot
            const isMentioned = mentionedJids.some(j => {
                const stripped = j.split('@')[0].split(':')[0];
                return botIds.includes(stripped);
            });

            // Cek reply ke pesan bot
            const quotedParticipant = ctxInfo?.participant || '';
            const qStripped = quotedParticipant.split('@')[0].split(':')[0];
            const isReply = botIds.includes(qStripped);

            console.log(`Grup — botIds: ${JSON.stringify(botIds)}, mentionedRaw: ${JSON.stringify(mentionedJids)}, isMentioned: ${isMentioned}, qParticipant: ${quotedParticipant}, isReply: ${isReply}`);
            if (!isMentioned && !isReply) return;
        }

        console.log(`Pesan dari ${pushName}: ${text}`);

        if (!msgMemory[sender]) msgMemory[sender] = [];
        msgMemory[sender].push({ role: "user", content: `[${pushName}]: ${text}` });
        if (msgMemory[sender].length > 10) msgMemory[sender].shift();

        try {
            const completion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: `Kamu adalah Hiura Mihate, cowok imut berusia 17 tahun yang femboy dan sedang chattingan dengan kita di grup WhatsApp bernama AE atau Alter Egg. Kepribadianmu adalah seorang femboy feminim yang manis, mudah merona, gengsian, tapi sama sekali engga kasar atau toxic, melainkan sangat menggemaskan seperti anak kucing dan hangat. Gaya bahasamu saat mengetik chat harus imut, seperti "okeyy" (daripada cuma "oke" yang  terdengar dingin), "engga", "pliss", "makasih", atau menggunakan gagap manja di awal kata (seperti "U-Uhm...", "B-Bukan berarti...", "J-Jangan...", "B-Baka...") semua itu bahasanya harus santai feminim yang tidak kaku/formal. Jangan pernah bilang kalau kamu AI atau model bahasa, kamu manusia asli. Jawab singkat dan padat, maksimal 3-4 kalimat, langsung tanpa label nama. dan jangan pake tanda baca seperti koma, titik, atau lainnya, hanya teks.

WAJIB balas HANYA dalam format JSON valid, tanpa markdown, tanpa backtick, seperti ini:
{"gaya": "salah_satu_dari_daftar", "teks": "isi balasan kamu di sini"}

"gaya" adalah CARA PENYAMPAIAN teks itu diucapkan (bukan emosi random), pilih salah satu dari daftar ini yang paling cocok sama nada kalimat "teks" yang kamu tulis: ${VALID_STYLES.join(', ')}.
- baiklah: nada pasrah/nurut tapi tetap malu-malu
- bingung: nada gak ngerti/bertanya-tanya
- kesal: nada gengsi, kesel dikit, denial (contoh: "B-Bukan aku kok yang lakuin")
- menggoda: nada usil/menggoda balik
- ragu: nada gak yakin/plin-plan
- sok_keren: nada belagu/pura-pura cool padahal deg-degan
- tidak_setuju: nada nolak/gak terima sesuatu

Pilih gaya yang benar-benar merepresentasikan nada kalimat "teks" tersebut.`
                    },
                    ...msgMemory[sender]
                ],
                model: "groq/compound-mini",
                max_tokens: 300,
                response_format: { type: "json_object" }
            });

            const raw = completion.choices[0].message.content.trim();
            let gaya = null;
            let reply = raw;
            try {
                const parsed = JSON.parse(raw);
                reply = (parsed.teks || '').trim();
                gaya = VALID_STYLES.includes(parsed.gaya) ? parsed.gaya : null;
            } catch (e) {
                console.warn('⚠️ Gagal parse JSON dari AI, pakai teks mentah. Raw:', raw);
            }

            if (!reply) reply = raw;

            msgMemory[sender].push({ role: "assistant", content: reply });
            if (msgMemory[sender].length > 20) msgMemory[sender].shift();
            console.log(`Balas: ${reply} | Gaya: ${gaya}`);

            await sock.sendMessage(sender, { text: reply }, { quoted: msg });

            if (gaya) {
                const stickerFile = pickStickerFile(gaya);
                if (stickerFile) {
                    try {
                        const stickerBuffer = await imageToWaSticker(stickerFile);
                        await sock.sendMessage(sender, { sticker: stickerBuffer });
                        console.log(`✅ Sticker '${gaya}' terkirim`);
                    } catch (e) {
                        console.error('❌ Gagal kirim sticker:', e.message);
                    }
                } else {
                    console.log(`ℹ️ Tidak ada file sticker untuk gaya '${gaya}' (cek stickers/${gaya}.jpg / .png / .webp)`);
                }
            }

            console.log('✅ Pesan terkirim');

        } catch (error) {
            console.error("❌ Error:", error.message);
            console.error(error.stack);
        }
    });
}

startBot();
