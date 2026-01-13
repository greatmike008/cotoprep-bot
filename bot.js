require('dotenv').config();
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
const { FedaPay, Transaction } = require('fedapay');
const qrcode = require('qrcode-terminal');
const axios = require('axios'); // For the keep-alive ping

const app = express();
app.use(bodyParser.json());

// --- 1. DATABASE CONNECTION ---
const mongoURI = "mongodb+srv://mastergee_db:Mikky%401044@cotoprepdb.cfxxhpa.mongodb.net/?appName=CotoPrepDB";

mongoose.connect(mongoURI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Atlas');
        initializeBot(); 
    })
    .catch(err => {
        console.error('❌ MongoDB Connection Error:', err);
    });

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    name: String,
    total: { type: Number, default: 0 },
    giftClaimed: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('sandbox');

let userSessions = {}; 

// --- 2. BOT INITIALIZATION ---
function initializeBot() {
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000
        }),
        puppeteer: {
            handleSIGINT: false,
            // Removed executablePath to let Puppeteer use the downloaded Chrome
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process'
            ]
        }
    });

    client.on('qr', async (qr) => {
        // 1. BACKUP QR CODE
        console.log('--- QR CODE BACKUP (Zoom out browser to 40% to scan) ---');
        qrcode.generate(qr, { small: false });
        
        // 2. PAIRING CODE (6s delay to prevent window error)
        console.log('--- Waiting for Pairing System (6s)... ---');
        setTimeout(async () => {
            try {
                const pairingCode = await client.requestPairingCode('22943067098'); 
                console.log('--------------------------------------------');
                console.log('🔗 YOUR WHATSAPP LINK CODE:');
                console.log('👉 ' + pairingCode + ' 👈');
                console.log('--------------------------------------------');
            } catch (err) {
                console.error('Pairing Error (Scan the QR above instead):', err);
            }
        }, 6000);
    });

    client.on('ready', () => {
        console.log('🚀 CotoPrep Bot is LIVE and Ready!');
    });
    
    client.on('remote_session_saved', () => {
        console.log('✅ Session saved to Cloud (MongoDB)!');
    });

    // --- 3. MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        const userId = msg.from;
        const text = msg.body.toUpperCase().trim();

        let dbUser = await User.findOne({ userId });

        if (text === 'CLASSEMENT') {
            const topUsers = await User.find().sort({ total: -1 }).limit(5);
            let resp = "🏆 *TOP 5 GÉNIES* 🏆\n\n";
            topUsers.forEach((u, i) => { resp += `${i+1}. ${u.name || "Étudiant"} - ${u.total}pts\n`; });
            return msg.reply(resp);
        }

        if (text === 'QUIZ') {
            msg.reply('Génération du lien de paiement (500 CFA)...');
            try {
                const transaction = await Transaction.create({
                    description: 'Accès Quiz CotoPrep',
                    amount: 500,
                    currency: { iso: 'XOF' },
                    custom_metadata: { phone: userId } 
                });
                const token = await transaction.generateToken();
                msg.reply(`Paye ici pour commencer : ${token.url}`);
            } catch (e) { console.error(e); }
            return;
        }

        if (userSessions[userId]) {
            let session = userSessions[userId];
            if (text === 'ANNULER') { delete userSessions[userId]; return msg.reply("Quiz annulé."); }

            if (!session.subject) {
                const subjects = ['MATHS', 'SVT', 'PCT', 'PHILO', 'FRANCAIS', 'HIST-GEO', 'ANGLAIS', 'ESPAGNOL', 'ALLEMAND'];
                const choice = parseInt(text) - 1;
                if (choice >= 0 && choice < subjects.length) {
                    session.subject = subjects[choice];
                    session.questions = [...quizData[session.subject]].sort(() => Math.random() - 0.5).slice(0, 25);
                    const q = session.questions[0];
                    await msg.reply(`*Q1:* ${q.question}\n\n${q.options.join('\n')}`);
                } else { return msg.reply("Tape 1-9."); }
                return;
            }

            const currentQ = session.questions[session.currentQuestion];
            if (['A', 'B', 'C'].includes(text)) {
                if (text === currentQ.answer) { session.score++; }
                session.currentQuestion++;
                if (session.currentQuestion < session.questions.length) {
                    const nextQ = session.questions[session.currentQuestion];
                    await msg.reply(`*Q${session.currentQuestion+1}:* ${nextQ.question}\n\n${nextQ.options.join('\n')}`);
                } else {
                    const contact = await msg.getContact();
                    if (!dbUser) dbUser = new User({ userId, name: contact.pushname || "Étudiant" });
                    dbUser.total += session.score;
                    await dbUser.save();
                    await msg.reply(`Fini ! Score: ${session.score}/${session.questions.length}. Tes points sont sauvés.`);
                    delete userSessions[userId];
                }
            }
        }
    });

    client.initialize();
}

// --- 4. EXPRESS SERVER & WEBHOOK ---
app.get('/', (req, res) => res.send('Bot is Running'));
app.post('/webhook', async (req, res) => {
    const data = req.body.entity || req.body;
    if (data.status === 'approved') {
        const phone = data.custom_metadata?.phone;
        if (phone) {
            userSessions[phone] = { subject: null, currentQuestion: 0, score: 0 };
            try {
                await client.sendMessage(phone, "Paiement Reçu ! 🎯 Choisis ta matière (1-9):\n1. MATHS\n2. SVT\n3. PCT\n4. PHILO\n5. FRANCAIS\n6. HIST-GEO\n7. ANGLAIS\n8. ESPAGNOL\n9. ALLEMAND");
            } catch (err) { console.error('Webhook Send Error:', err); }
        }
    }
    res.sendStatus(200);
});

// --- 5. KEEP-ALIVE PING ---
setInterval(() => {
    axios.get('https://cotoprep-bot.onrender.com/')
        .then(() => console.log('👋 Self-ping: Staying awake!'))
        .catch(err => console.error('Ping Error:', err.message));
}, 600000); // 10 minutes

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`📡 Server listening on port ${PORT}`));
