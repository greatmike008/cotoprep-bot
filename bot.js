require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const mongoose = require('mongoose');
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
// --- CHANGE 1: Swapped fedapay for kkiapay ---
const { kkiapay } = require('@kkiapay-org/nodejs-sdk'); 
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

app.qrCodeImage = null;
let sock = null;

// --- 1. DATABASE CONNECTION ---
const mongoURI = "mongodb+srv://mastergee_db:Mikky%401044@cotoprepdb.cfxxhpa.mongodb.net/?appName=CotoPrepDB";

mongoose.connect(mongoURI)
    .then(() => {
        console.log('✅ Connected to MongoDB Atlas');
        startBot();
    })
    .catch(err => {
        console.error('❌ MongoDB Error:', err);
    });

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    name: String,
    total: { type: Number, default: 0 },
    giftClaimed: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

// --- CHANGE 2: KKiaPay Initialization ---
const kkia = kkiapay({
    publickey: process.env.KKIAPAY_PUBLIC_KEY,
    privatekey: process.env.KKIAPAY_PRIVATE_KEY,
    secretkey: process.env.KKIAPAY_SECRET_KEY,
    sandbox: true 
});

let userSessions = {};

// --- 2. BAILEYS BOT INITIALIZATION --- (No changes needed here)
async function startBot() {
    const authDir = path.join(__dirname, 'auth_info_baileys');
    if (!fs.existsSync(authDir)) { fs.mkdirSync(authDir, { recursive: true }); }
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['CotoPrep Bot', 'Chrome', '1.0.0'],
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            app.qrCodeImage = await QRCode.toDataURL(qr);
            qrcodeTerminal.generate(qr, { small: true });
        }
        if (connection === 'open') { app.qrCodeImage = null; console.log('🚀 BOT IS LIVE!'); }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => startBot(), 5000);
        }
    });

    // --- 3. MESSAGE HANDLER ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        try {
            const from = msg.key.remoteJid;
            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const text = messageText.toUpperCase().trim();
            let dbUser = await User.findOne({ userId: from });

            const sendMessage = async (text) => { await sock.sendMessage(from, { text }); };

            if (text === 'CLASSEMENT') {
                const topUsers = await User.find().sort({ total: -1 }).limit(5);
                let resp = "🏆 *TOP 5 GÉNIES* 🏆\n\n";
                topUsers.forEach((u, i) => { resp += `${i+1}. ${u.name || "Étudiant"} - ${u.total}pts\n`; });
                return sendMessage(resp);
            }

            // --- CHANGE 3: Payment Link Generation ---
            if (text === 'QUIZ') {
                await sendMessage('⏳ Génération du lien de paiement (500 CFA)...');
                
                // KKiaPay works best with pre-generated "Payment Links" or the widget.
                // For a bot, we send the user to a checkout URL.
                const paymentUrl = `https://payment.kkiapay.me/api/v1/pay?k=${process.env.KKIAPAY_PUBLIC_KEY}&a=500&s=CotoPrep&p=${from}`;

                await sendMessage(
                    `💳 *PAIEMENT - 500 CFA*\n\n` +
                    `Clique ici: ${paymentUrl}\n\n` +
                    `📱 Utilise Mobile Money (MTN/Moov)\n` +
                    `_Une fois payé, le quiz démarre automatiquement!_`
                );
                return;
            }

            if (text === 'TEST' || text === 'START') {
                userSessions[from] = { subject: null, currentQuestion: 0, score: 0 };
                await sendMessage("🧪 *MODE TEST*\nChoisis ta matière (1-9)");
                return;
            }

            // Quiz Session Handling (Logic remains the same)
            if (userSessions[from]) {
                let session = userSessions[from];
                if (text === 'ANNULER') { delete userSessions[from]; return sendMessage("❌ Quiz annulé."); }

                if (!session.subject) {
                    const subjects = ['MATHS', 'SVT', 'PCT', 'PHILO', 'FRANCAIS', 'HIST-GEO', 'ANGLAIS', 'ESPAGNOL', 'ALLEMAND'];
                    const choice = parseInt(text) - 1;
                    if (choice >= 0 && choice < subjects.length) {
                        session.subject = subjects[choice];
                        session.questions = [...quizData[session.subject]].sort(() => Math.random() - 0.5).slice(0, 25);
                        const q = session.questions[0];
                        await sendMessage(`*Q1/25*\n\n${q.question}\n\n${q.options.join('\n')}\n\n_Tape A, B ou C_`);
                    } else { return sendMessage("❌ Choix invalide. Tape 1-9."); }
                    return;
                }

                const currentQ = session.questions[session.currentQuestion];
                if (['A', 'B', 'C'].includes(text)) {
                    if (text === currentQ.answer) session.score++;
                    session.currentQuestion++;
                    if (session.currentQuestion < session.questions.length) {
                        const nextQ = session.questions[session.currentQuestion];
                        await sendMessage(`${text === currentQ.answer ? '✅' : '❌ Faux!'} \n*Q${session.currentQuestion+1}/25*\n\n${nextQ.question}\n\n${nextQ.options.join('\n')}`);
                    } else {
                        const userName = msg.pushName || "Étudiant";
                        if (!dbUser) { dbUser = new User({ userId: from, name: userName }); }
                        dbUser.total += session.score;
                        await dbUser.save();
                        await sendMessage(`🎉 *FINI!* Score: ${session.score}/25\nTotal Points: ${dbUser.total}`);
                        delete userSessions[from];
                    }
                }
            }
        } catch (error) { console.error('❌ Error:', error); }
    });
    global.whatsappSocket = sock;
}

// --- 4. EXPRESS ROUTES ---
app.get('/', (req, res) => { res.send('<h1>CotoPrep Bot Online</h1>'); });
app.get('/scan', (req, res) => { /* QR code logic remains the same as your file */ });

// --- CHANGE 4: Updated Webhook for KKiaPay ---
app.post('/webhook', async (req, res) => {
    try {
        const { transactionId } = req.body;
        const response = await kkia.verify(transactionId);
        
        if (response.status === 'SUCCESS') {
            const phone = response.partnerId; // This is 'from' we passed in the URL
            
            if (phone && global.whatsappSocket) {
                userSessions[phone] = { subject: null, currentQuestion: 0, score: 0 };
                await global.whatsappSocket.sendMessage(phone, {
                    text: "✅ *Paiement Confirmé!* \nChoisis ta matière (1-9)"
                });
            }
        }
    } catch (err) { console.error('❌ Webhook Error:', err); }
    res.sendStatus(200);
});

// Keep-Alive and Listener (No changes)
setInterval(() => { axios.get('https://cotoprep-bot.onrender.com/').catch(() => {}); }, 300000);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`📡 Port ${PORT}`); });
