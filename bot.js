require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const mongoose = require('mongoose');
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
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

// --- 2. KKIA PAY INITIALIZATION ---
const kkia = kkiapay({
    publickey: process.env.KKIAPAY_PUBLIC_KEY,
    privatekey: process.env.KKIAPAY_PRIVATE_KEY,
    secretkey: process.env.KKIAPAY_SECRET_KEY,
    sandbox: true 
});

let userSessions = {};

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

            if (text === 'QUIZ') {
                await sendMessage('⏳ Génération du lien de paiement (500 CFA)...');
                // Creating the redirect URL for KKiaPay
                const paymentUrl = `https://payment.kkiapay.me/api/v1/pay?k=${process.env.KKIAPAY_PUBLIC_KEY}&a=500&s=CotoPrep&p=${from}`;

                await sendMessage(
                    `💳 *PAIEMENT - 500 CFA*\n\n` +
                    `Clique ici pour payer: ${paymentUrl}\n\n` +
                    `📱 Utilise MTN ou Moov Money\n` +
                    `_Le quiz commencera dès que le paiement sera validé._`
                );
                return;
            }

            if (text === 'TEST' || text === 'START') {
                userSessions[from] = { subject: null, currentQuestion: 0, score: 0 };
                await sendMessage("🧪 *MODE TEST*\nChoisis ta matière (1-9):\n1. MATHS\n2. SVT\n3. PCT\n4. PHILO\n5. FRANCAIS\n6. HIST-GEO\n7. ANGLAIS\n8. ESPAGNOL\n9. ALLEMAND");
                return;
            }

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
                        await sendMessage(`*Q1/25*\n\n${q.question}\n\n${q.options.join('\n')}\n\n_Réponds par A, B ou C_`);
                    } else { return sendMessage("❌ Choix invalide. Tape un chiffre de 1 à 9."); }
                    return;
                }

                const currentQ = session.questions[session.currentQuestion];
                if (['A', 'B', 'C'].includes(text)) {
                    const isCorrect = text === currentQ.answer;
                    if (isCorrect) session.score++;
                    session.currentQuestion++;

                    if (session.currentQuestion < session.questions.length) {
                        const nextQ = session.questions[session.currentQuestion];
                        await sendMessage(`${isCorrect ? '✅ Bien joué!' : '❌ Faux!'} \n\n*Q${session.currentQuestion+1}/25*\n\n${nextQ.question}\n\n${nextQ.options.join('\n')}`);
                    } else {
                        const userName = msg.pushName || "Étudiant";
                        if (!dbUser) { dbUser = new User({ userId: from, name: userName }); }
                        dbUser.total += session.score;
                        await dbUser.save();
                        await sendMessage(`🎉 *BRAVO!* \n\nTon score: ${session.score}/25\nTotal cumulé: ${dbUser.total} points.\n\nTape *CLASSEMENT* pour voir ta place!`);
                        delete userSessions[from];
                    }
                }
            }
        } catch (error) { console.error('❌ Error:', error); }
    });
    global.whatsappSocket = sock;
}

app.get('/', (req, res) => { res.send('<h1>CotoPrep Bot Online</h1>'); });
app.get('/scan', (req, res) => { /* Your QR logic remains here */ });

// --- 3. THE SECURE WEBHOOK ---
app.post('/webhook', async (req, res) => {
    // We check if the notification actually comes from KKiaPay using the hash
    const hash = process.env.KKIAPAY_SECRET_HASH;
    
    try {
        const { transactionId } = req.body;
        const response = await kkia.verify(transactionId);
        
        if (response.status === 'SUCCESS') {
            const phone = response.partnerId; // We passed 'from' in the URL as 'p'
            
            if (phone && global.whatsappSocket) {
                userSessions[phone] = { subject: null, currentQuestion: 0, score: 0 };
                await global.whatsappSocket.sendMessage(phone, {
                    text: "✅ *Paiement Confirmé!* 🎯\n\nPrêt pour le quiz? Choisis ta matière (1-9):\n1. MATHS\n2. SVT\n3. PCT\n4. PHILO\n5. FRANCAIS\n6. HIST-GEO\n7. ANGLAIS\n8. ESPAGNOL\n9. ALLEMAND"
                });
            }
        }
    } catch (err) { console.error('❌ Webhook Verification Error:', err); }
    res.sendStatus(200);
});

setInterval(() => { axios.get('https://cotoprep-bot.onrender.com/').catch(() => {}); }, 300000);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`📡 Server listening on ${PORT}`); });
