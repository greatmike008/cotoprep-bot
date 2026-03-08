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
        if (connection === 'open') { 
            app.qrCodeImage = null; 
            console.log('🚀 BOT IS LIVE!'); 
        }
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
                const paymentUrl = `https://payment.kkiapay.me/api/v1/pay?k=${process.env.KKIAPAY_PUBLIC_KEY}&a=500&s=CotoPrep&p=${from}`;
                await sendMessage(`💳 *PAIEMENT - 500 CFA*\n\nClique ici: ${paymentUrl}\n\n_Une fois payé, le quiz démarre automatiquement!_`);
                return;
            }

            if (text === 'TEST' || text === 'START') {
                userSessions[from] = { subject: null, currentQuestion: 0, score: 0 };
                await sendMessage("🧪 *MODE TEST*\nChoisis ta matière (1-9)");
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

// --- 3. EXPRESS ROUTES (FIXED /SCAN) ---
app.get('/', (req, res) => { res.send('<h1>CotoPrep Bot Online</h1><p>Visit <a href="/scan">/scan</a> to link WhatsApp.</p>'); });

app.get('/scan', (req, res) => {
    if (app.qrCodeImage) {
        res.send(`<html><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
            <h2>Scan to Link CotoPrep Bot</h2>
            <img src="${app.qrCodeImage}" style="border:10px solid white;box-shadow:0 0 10px rgba(0,0,0,0.1);">
            <p>Refresh page if code expires.</p></body></html>`);
    } else {
        res.send('<h1>No QR Code available</h1><p>Bot is either already connected or starting up.</p>');
    }
});

// --- MANUAL BYPASS FOR LOCKED WEBHOOK ---
// --- IMPROVED MANUAL BYPASS ROUTE ---
app.get('/test-payment/:phone', async (req, res) => {
    const phone = req.params.phone; 
    
    // Check if the socket exists in the global scope or the local 'sock' variable
    const activeSocket = global.whatsappSocket || sock;

    if (activeSocket) {
        try {
            // Force create the session
            userSessions[phone] = { subject: null, currentQuestion: 0, score: 0 };
            
            // Send the message
            await activeSocket.sendMessage(phone, {
                text: "✅ *Paiement Test Approuvé!* \n\nPrêt pour le quiz? Choisis ta matière (1-9):\n1. MATHS\n2. SVT\n3. PCT\n4. PHILO\n5. FRANCAIS\n6. HIST-GEO\n7. ANGLAIS\n8. ESPAGNOL\n9. ALLEMAND"
            });
            
            res.send(`🚀 Message sent to ${phone}! Check your WhatsApp.`);
        } catch (err) {
            console.error("Failed to send WhatsApp message:", err);
            res.status(500).send("Error sending message: " + err.message);
        }
    } else {
        res.status(500).send("Bot is not connected. Please go to /scan and link your device first.");
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const { transactionId } = req.body;
        const response = await kkia.verify(transactionId);
        if (response.status === 'SUCCESS') {
            const phone = response.partnerId;
            if (phone && global.whatsappSocket) {
                userSessions[phone] = { subject: null, currentQuestion: 0, score: 0 };
                await global.whatsappSocket.sendMessage(phone, { text: "✅ *Paiement Confirmé!* \nChoisis ta matière (1-9)" });
            }
        }
    } catch (err) { console.error('❌ Webhook Error:', err); }
    res.sendStatus(200);
});

setInterval(() => { axios.get('https://cotoprep-bot.onrender.com/').catch(() => {}); }, 300000);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`📡 Port ${PORT}`); });

