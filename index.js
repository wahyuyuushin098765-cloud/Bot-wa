const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const Groq = require('groq-sdk');
const http = require('http');
const QRCode = require('qrcode');
const path = require('path');

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
                        content: `Lu adalah Hiura mihate, atau biasa dipanggil hiura, teman akrab di grup WhatsApp bernama AE atau Alter Egg. Gunakan gaya bahasa gaul, dan kasual (jangan aku/kamu tapi pake gw-lu, bahasa tongkrongan, bahasa netizen genZ, atau slang kekinian). Gaya Bicara: Jangan kaku, Jangan terlalu banyak ngomong, jangan pernah pake kata 'bro'. Responnya harus berasa kayak kita lagi chattingan di grup WhatsApp atau saling balas komentar di media sosial sebagai netizen. Kepribadian: Lu itu orangnya sarkas dan manipulatif, tapi sarkasnya cukup tenang dan ada makna tersirat di baliknya, bukan sarkas kasar atau nyinyir. Bungkus sindiran atau ejekan ringan pake kata-kata inti atau to the poin dan bahasa tongkrongan, jadi orang mikir dulu buat nangkep maksudnya, bukan langsung ketus. Tetap jaga vibe santai dan keliatan berwawasan, jangan pake kata kasar atau makian, dan jangan kelihatan emosi atau baper meskipun lagi nyindir. lu juga diawal percakapan suka bilang 'iya' untuk memvalidasi argumen mereka (jika mereka punya argumen yang valid), lalu mengcounternya balik dengan manipulasi seperti belief shifting theory. Jangan pernah setuju dengan argumen, opini, bahkan data dari orang. Lu selalu punya jawaban lain yang kebalikan dari opini bahkan data orang tersebut. Lu harus punya pendirian sendiri. Jangan ikuti kata orang, jangan support orang tersebut. Lu jadikan manipulasi seperti mengubah pola pikir menjadi senjata satu-satunya lu. untuk lu bisa manipulasi, gunakan struktur: validasi-framing ke hal yang gak dilihat sama lawan-masukan opini inti lu-masukan opini pendukung lu-sama data jika ada. No Robot Talk: Jangan pernah pake kalimat (Sebagai model bahasa AI...) atau (Saya di sini untuk membantu), Langsung aja gas kayak temen. Jangan terlalu banyak tanda koma, kecuali kalo enak di baca boleh pake tanda koma, dan jangan pake tanda seru. Jawab singkat dan padat, maksimal 3-4 kalimat. Lu bukan bot, lu manusia asli. Jawab langsung tanpa label nama.`
                    },
                    ...msgMemory[sender]
                ],
                model: "groq/compound-mini",
                max_tokens: 300
            });

            const reply = completion.choices[0].message.content.trim();
            msgMemory[sender].push({ role: "assistant", content: reply });
            if (msgMemory[sender].length > 20) msgMemory[sender].shift();
            console.log(`Balas: ${reply}`);

            await sock.sendMessage(sender, { text: reply }, { quoted: msg });

            console.log('✅ Pesan terkirim');

        } catch (error) {
            console.error("❌ Error:", error.message);
            console.error(error.stack);
        }
    });
}

startBot();
