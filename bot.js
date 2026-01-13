require('dotenv').config();
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
const { FedaPay, Transaction } = require('fedapay');

const app = express();
app.use(bodyParser.json());

// --- 1. DATABASE CONNECTION ---
// We define the connection first
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB Atlas');
        initializeBot(); // Only start the bot once DB is ready
    })
    .catch(err => {
        console.error('❌ MongoDB Connection Error. Check your MONGODB_URI in Render settings!');
        console.error(err);
    });

// Define User Schema
const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    name: String,
    total: { type: Number, default: 0 },
    giftClaimed: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

// --- 2. FEDAPAY SETUP ---
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('sandbox');

let userSessions = {}; 

// --- 3. BOT INITIALIZATION FUNCTION ---
function initializeBot() {
    const store = new MongoStore({ mongoose: mongoose });

    const client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000
        }),
        puppeteer: {
            handleSIGINT: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', async (qr) => {
        try {
            // REPLACE WITH YOUR NUMBER (ex: 22964000000)
            const pairingCode = await client.requestPairingCode('229XXXXXXXX'); 
            console.log('--------------------------------------------');
            console.log('🔗 VOTRE CODE DE COUPLAGE WHATSAPP :');
            console.log(pairingCode);
            console.log('--------------------------------------------');
        } catch (err) {
            console.error('Erreur Pairing Code:', err);
        }
    });

    client.on('ready', () => console.log('🚀 CotoPrep Bot is LIVE!'));
    
    client.on('remote_session_saved', () => {
        console.log('✅ Session sauvegardée dans MongoDB !');
    });

    // --- 4. MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        const userId = msg.from;
        const text = msg.body.toUpperCase().trim();

        let dbUser = await User.findOne({ userId });

        if (text === 'CLASSEMENT') {
            const topUsers = await User.find().sort({ total: -1 }).limit(5);
            let resp = "🏆 *TOP 5 GÉNIES* 🏆\n\n";
            topUsers.forEach((u, i) => { resp += `${i+1}. ${u.name || "Pro"} - ${u.total}pts\n`; });
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
                if (session.currentQuestion < 25) {
                    const nextQ = session.questions[session.currentQuestion];
                    await msg.reply(`*Q${session.currentQuestion+1}:* ${nextQ.question}\n\n${nextQ.options.join('\n')}`);
                } else {
                    const contact = await msg.getContact();
                    if (!dbUser) dbUser = new User({ userId, name: contact.pushname || "Étudiant" });
                    dbUser.total += session.score;
                    await dbUser.save();
                    await msg.reply(`Fini ! Score: ${session.score}/25. Tes points sont sauvés.`);
                    delete userSessions[userId];
                }
            }
        }
    });

    client.initialize();
}

// --- 5. SERVER ---
app.get('/', (req, res) => res.send('Bot Active'));
app.post('/webhook', async (req, res) => {
    const data = req.body.entity || req.body;
    if (data.status === 'approved') {
        const phone = data.custom_metadata?.phone;
        if (phone) {
            userSessions[phone] = { subject: null, currentQuestion: 0, score: 0 };
            await client.sendMessage(phone, "Paiement Reçu ! 🎯 Choisis ta matière (1-9).");
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 Server port ${PORT}`));
