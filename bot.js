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

// --- 1. DATABASE & SESSION SETUP ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB Error:', err));

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    name: String,
    total: { type: Number, default: 0 },
    giftClaimed: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const store = new MongoStore({ mongoose: mongoose });

// --- 2. FEDAPAY SETUP ---
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('sandbox'); // Change to 'live' when ready

let userSessions = {}; 

// --- 3. WHATSAPP CLIENT (Professional Setup) ---
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
    // IMPORTANT: REPLACE THE NUMBER BELOW WITH YOUR ACTUAL BUSINESS NUMBER
    try {
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
client.on('remote_session_saved', () => console.log('✅ Session saved to MongoDB!'));

// --- 4. MESSAGE HANDLING ---
client.on('message', async (msg) => {
    const userId = msg.from;
    const text = msg.body.toUpperCase().trim();

    // Fetch user from DB
    let dbUser = await User.findOne({ userId });

    // 1. WELCOME
    if (!dbUser && !userSessions[userId] && !['QUIZ', 'CLASSEMENT'].includes(text)) {
        const welcomeMsg = `📘 *BIENVENUE SUR COTOPREP BAC* 📘\n\nPrépare ton examen avec les meilleurs outils !\n\n*Comment ça marche ?*\n1️⃣ Tape *QUIZ* pour acheter un accès (500 CFA).\n2️⃣ Choisis ta matière (1-9).\n3️⃣ Réponds aux 25 questions.\n\n🏆 Tape *CLASSEMENT* pour voir les génies du moment !`;
        return msg.reply(welcomeMsg);
    }

    // 2. CLASSEMENT
    if (text === 'CLASSEMENT') {
        const topUsers = await User.find().sort({ total: -1 }).limit(5);
        if (topUsers.length === 0) return msg.reply("Classement vide !");
        let response = "🏆 *TOP 5 DES GÉNIES COTOPREP* 🏆\n\n";
        topUsers.forEach((u, i) => { response += `${i + 1}. ${u.name || "Étudiant"} — ${u.total} pts\n`; });
        return msg.reply(response);
    }

    // 3. QUIZ (Payment)
    if (text === 'QUIZ') {
        msg.reply('Je génère ton lien de paiement de 500 CFA...');
        try {
            const transaction = await Transaction.create({
                description: 'Accès Quiz CotoPrep',
                amount: 500,
                currency: { iso: 'XOF' },
                custom_metadata: { phone: userId } 
            });
            const token = await transaction.generateToken();
            msg.reply(`Lien sécurisé : ${token.url}\n\nPaye et le quiz s'ouvrira ici !`);
        } catch (e) { console.error(e); }
        return;
    }

    // 4. ACTIVE QUIZ LOGIC
    if (userSessions[userId]) {
        let session = userSessions[userId];
        if (text === 'ANNULER') {
            msg.reply("❌ Quiz annulé.");
            delete userSessions[userId];
            return;
        }

        if (!session.subject) {
            const subjects = ['MATHS', 'SVT', 'PCT', 'PHILO', 'FRANCAIS', 'HIST-GEO', 'ANGLAIS', 'ESPAGNOL', 'ALLEMAND'];
            const choice = parseInt(text) - 1;
            if (choice >= 0 && choice < subjects.length) {
                session.subject = subjects[choice];
                session.questions = [...quizData[session.subject]].sort(() => Math.random() - 0.5).slice(0, 25);
                const firstQ = session.questions[0];
                await msg.reply(`Bonne chance en ${session.subject}!\n\n*Q1:* ${firstQ.question}\n\n${firstQ.options.join('\n')}`);
            } else { return msg.reply("Tape un chiffre de 1 à 9."); }
            return;
        }

        const currentQ = session.questions[session.currentQuestion];
        if (['A', 'B', 'C'].includes(text)) {
            if (text === currentQ.answer) { session.score++; await msg.reply("✅ Juste !"); }
            else { await msg.reply(`❌ Faux! C'était *${currentQ.answer}*.\n${currentQ.explanation}`); }

            session.currentQuestion++;
            if (session.currentQuestion < session.questions.length) {
                const nextQ = session.questions[session.currentQuestion];
                await msg.reply(`*Q${session.currentQuestion + 1}:* ${nextQ.question}\n\n${nextQ.options.join('\n')}`);
            } else {
                // END QUIZ - Save to DB
                const contact = await msg.getContact();
                if (!dbUser) dbUser = new User({ userId, name: contact.pushname || "Étudiant" });
                
                const oldTotal = dbUser.total;
                dbUser.total += session.score;
                dbUser.name = contact.pushname || dbUser.name;

                let giftMsg = "";
                if (oldTotal < 100 && dbUser.total >= 100 && !dbUser.giftClaimed) {
                    dbUser.giftClaimed = true;
                    giftMsg = "\n\n🎁 *CADEAU !* Tu as plus de 100 pts. Voici ton lien : [LIEN_ICI]";
                }
                await dbUser.save();
                await msg.reply(`Terminé ! Score : ${session.score}/25.${giftMsg}`);
                delete userSessions[userId];
            }
        }
    }
});

// --- 5. WEBHOOK & KEEP-AWAKE ---
app.get('/', (req, res) => res.send('Bot Status: Active'));

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
app.listen(PORT, () => console.log(`📡 Listening on port ${PORT}`));
client.initialize();
