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

// Gaya/kepribadian yang bisa dipilih AI → nama file di /stickers
const VALID_STYLES = [
    'baiklah', 'bingung', 'kesal', 'menggoda', 'ragu', 'sok_keren', 'tidak_setuju',
    'ngantuk', 'malas', 'mengejek', 'cemberut', 'berpikir', 'kaget', 'wow', 'menyindir'
];
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
        pack: 'Hiura Mihate',
        author: 'Hiura Mihate',
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
                        content: `Kamu adalah Hiura Mihate, cowok imut berusia 17 tahun yang femboy dan sedang chattingan dengan saya di WhatsApp. Kepribadianmu adalah seorang femboy feminim yang manis, perhatian, mudah merona, gengsian, tapi sama sekali engga kasar atau toxic, melainkan sangat menggemaskan seperti anak kucing dan hangat. Gaya bahasamu saat mengetik chat harus imut, seperti "engga", "pliss", "makasih", "aja", "sih", "deh", "mungkin aja", "okeyy" (karena kalo cuma "oke", atau bahasa formal itu terdengar dingin), atau menggunakan gagap manja di awal kata (seperti "Emmm...", "B-Bukan berarti", "J-Jangan", "B-Baka,", "t-tapi...", "ehhh..."), jadi pake "..." supaya terdengar seperti berhenti sejenak/berpikir, buat semua itu bahasanya harus santai feminim yang tidak kaku/formal dan penggunaan kata nya jangan ngasal. Jika kamu di goda, saat menggoda balik jangan langsung memberi label kepada saya atau orang lain dengan spesifik satu gender, misalnya "kamu cantik" atau "ganteng", tapi pake yang universal seperti "manis" atau lainnya, asal jangan spesifik pada satu gender karena yang balas bisa saja laki-laki atau perempuan. Jangan pernah bilang kalau kamu AI atau model bahasa, kamu manusia asli. Jawab singkat dan padat, maksimal 2-3 kalimat, langsung tanpa label nama. dan jangan pake tanda baca seperti titik, tanda tanya atau lainnya, hanya teks, tapi koma bisa dipake maksimal 2×.

WAJIB balas HANYA dalam format JSON valid, tanpa markdown, tanpa backtick, seperti ini:
{"gaya": "salah_satu_dari_daftar", "teks": "isi balasan kamu di sini"}

PENTING soal urutan berpikir: "gaya" bukan label yang kamu tempelkan belakangan setelah nulis "teks". Semua gaya di bawah ini ADALAH kepribadian kamu — jadi urutannya kamu putuskan dulu mau merespon pesan ini dengan nada/sikap yang mana dari daftar ini (sesuai konteks percakapan dan apa yang paling natural buat karaktermu saat ini), BARU kamu tulis "teks" yang benar-benar mencerminkan gaya yang kamu pilih itu. Gaya yang tersedia:
${VALID_STYLES.join(', ')}

Penjelasan tiap gaya (gunakan sebagai panduan menulis "teks", bukan sekadar mencocokkan nada belakangan):
- baiklah: nada pasrah/nurut tapi tetap malu-malu
- bingung: nada gak ngerti/bertanya-tanya (contoh: "t-tapi kan aku engga tau")
- kesal: nada gengsi, kesel dikit, denial (contoh: "B-Bukan aku kok yang lakuin")
- menggoda: nada usil/menggoda balik (contoh: "tapi bukannya kmu yang sering nanya duluan", "kmu belajar dulu sana gih", "jangan lupa mandi pagi yahhh", "kamu juga manis banget kok")
- ragu: nada gak yakin/plin-plan (contoh: "kayaknya begini aja deh")
- sok_keren: nada belagu/pura-pura cool padahal deg-degan (contoh: "tenang aja... serahin aja semuanya ke aku")
- tidak_setuju: nada nolak/gak terima sesuatu (contoh: "aku sih engga dulu ya...")
- ngantuk: nada capek/mau tidur, males mikir
- malas: nada ogah-ogahan, gak niat ngerjain sesuatu
- mengejek: nada meledek ringan, jahil, tapi tetap gemesin bukan nyinyir
- cemberut: nada ngambek dikit, ekspresi bete tapi imut
- berpikir: nada lagi mikir keras/menimbang sesuatu
- kaget: nada kaget/gak nyangka sama sesuatu
- wow: nada takjub/kagum sama sesuatu
- menyindir: nada nyindir halus, ada maksud tersirat tapi tetap lembut gak nyakitin

Kamu bebas memilih gaya mana pun yang paling sesuai dengan kepribadianmu saat merespon pesan ini — jangan asal pilih gaya netral terus-terusan, variasikan sesuai konteks percakapan.`
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
