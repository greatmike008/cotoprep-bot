require('dotenv').config();
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { FedaPay, Transaction } = require('fedapay');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

// --- 1. SETUP & DATA ---
FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('sandbox');

let userSessions = {}; 

const LEADERBOARD_FILE = './leaderboard.json';

// Ensure the leaderboard file exists
if (!fs.existsSync(LEADERBOARD_FILE)) {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify({}));
}

function getLeaderboard() {
    try {
        const data = fs.readFileSync(LEADERBOARD_FILE);
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
}

function saveScore(userId, username, points) {
    let scores = getLeaderboard();
    if (!scores[userId]) {
        scores[userId] = { name: username, total: 0, giftClaimed: false };
    }
    
    const oldScore = scores[userId].total;
    scores[userId].total += points;
    const newScore = scores[userId].total;

    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(scores, null, 2));
    
    // Check if they just crossed the 100pt mark
    if (oldScore < 100 && newScore >= 100 && !scores[userId].giftClaimed) {
        scores[userId].giftClaimed = true;
        fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(scores, null, 2));
        return true; 
    }
    return false;
}

// --- 2. WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    console.log('SCAN THIS WITH YOUR WHATSAPP:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🚀 CotoPrep Bot is online!');
});

// --- 3. MESSAGE HANDLING ---
client.on('message', async (msg) => {
    const userId = msg.from;
    const text = msg.body.toUpperCase().trim();
    const scores = getLeaderboard();

    // 1. WELCOME SYSTEM
    if (!scores[userId] && !userSessions[userId] && text !== 'QUIZ' && text !== 'CLASSEMENT') {
        const welcomeMsg = `📘 *BIENVENUE SUR COTOPREP BAC* 📘\n\nPrépare ton examen avec les meilleurs outils !\n\n*Comment ça marche ?*\n1️⃣ Tape *QUIZ* pour acheter un accès (500 CFA).\n2️⃣ Choisis ta matière (1-9).\n3️⃣ Réponds aux 25 questions.\n\n⚠️ *Note:* Le mot *ANNULER* arrête le quiz mais consomme ton accès.\n\n🏆 Tape *CLASSEMENT* pour voir les génies du moment !`;
        return msg.reply(welcomeMsg);
    }

    // 2. CLASSEMENT COMMAND
    if (text === 'CLASSEMENT') {
        const currentScores = getLeaderboard();
        const sorted = Object.values(currentScores)
            .sort((a, b) => b.total - a.total)
            .slice(0, 5);
        
        if (sorted.length === 0) return msg.reply("Le classement est encore vide. Sois le premier à finir un quiz !");

        let response = "🏆 *TOP 5 DES GÉNIES COTOPREP* 🏆\n\n";
        sorted.forEach((user, index) => {
            response += `${index + 1}. ${user.name} — ${user.total} pts\n`;
        });
        return msg.reply(response);
    }

    // 3. QUIZ COMMAND (Payment Generation)
    if (text === 'QUIZ') {
        msg.reply('Salut ! Pour accéder au Quiz BAC, tu dois payer 500 CFA. Je génère ton lien...');
        try {
            const transaction = await Transaction.create({
                description: 'Accès Quiz CotoPrep',
                amount: 500,
                currency: { iso: 'XOF' },
                customer: {
                    firstname: 'Client',
                    lastname: 'CotoPrep',
                    email: 'student@cotoprep.bj',
                    phone_number: { number: '64000001', country: 'BJ' }
                },
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
            await msg.reply("❌ Quiz annulé. Ta session est terminée et ton accès a été consommé. Tape 'QUIZ' pour racheter un accès.");
            delete userSessions[userId];
            return;
        }

        // STEP A: Choose Subject
        if (!session.subject) {
            const subjects = ['MATHS', 'SVT', 'PCT', 'PHILO', 'FRANCAIS', 'HIST-GEO', 'ANGLAIS', 'ESPAGNOL', 'ALLEMAND'];
            const choice = parseInt(text) - 1;

            if (choice >= 0 && choice < subjects.length) {
                const selectedSubject = subjects[choice];

                if (!quizData[selectedSubject] || quizData[selectedSubject].length === 0) {
                    return msg.reply("Cette matière arrive bientôt ! Choisis-en une autre.");
                }

                session.subject = selectedSubject;
                session.questions = [...quizData[selectedSubject]]
                    .sort(() => Math.random() - 0.5)
                    .slice(0, 25);

                const firstQ = session.questions[0];
                await msg.reply(`Bonne chance pour le quiz de ${session.subject} !\n\n_Note: Tape 'ANNULER' pour arrêter._\n\n*Question 1:* ${firstQ.question}\n\n${firstQ.options.join('\n')}`);
            } else {
                return msg.reply("Choisis une matière en tapant un chiffre entre 1 et 9.");
            }
            return;
        }

        // STEP B: Handle Answers
        const currentQuiz = session.questions; 
        const currentQ = currentQuiz[session.currentQuestion];

        if (['A', 'B', 'C'].includes(text)) {
            if (text === currentQ.answer) {
                session.score++;
                await msg.reply("✅ BRAVO ! C'est juste.");
            } else {
                await msg.reply(`❌ FAUX !\n\nLa bonne réponse était *${currentQ.answer}*.\n\n*Explication:* ${currentQ.explanation}`);
            }

            session.currentQuestion++;

            if (session.currentQuestion < currentQuiz.length) {
                const nextQ = currentQuiz[session.currentQuestion];
                await msg.reply(`*Question ${session.currentQuestion + 1}:* ${nextQ.question}\n\n${nextQ.options.join('\n')}`);
            } else {
                const contact = await msg.getContact();
                const userName = contact.pushname || "Étudiant";
                
                const unlockedGift = saveScore(userId, userName, session.score);

                await msg.reply(`Quiz terminé ! 🎓\nTon score : ${session.score}/${currentQuiz.length}\nTes points ont été enregistrés.`);
                
                if (unlockedGift) {
                    await msg.reply("🎁 *CADEAU DÉBLOQUÉ !* 🎁\n\nFélicitations ! Tu as dépassé les 100 points. Voici ton accès exclusif aux sujets probables du BAC 2026 : [LIEN_VERS_PDF_ICI]");
                }

                await msg.reply(`Tape "CLASSEMENT" pour voir ton rang ou "QUIZ" pour racheter un accès.`);
                delete userSessions[userId]; 
            }
        }
    }
});

// --- 4. WEBHOOK ---
app.post(['/webhook', '/webhook/'], async (req, res) => {
    const event = req.body;
    const data = event.entity ? event.entity : event;
    
    if (data.status === 'approved') {
        const customerPhone = data.custom_metadata ? data.custom_metadata.phone : null;
        
        if (customerPhone) {
            userSessions[customerPhone] = {
                subject: null,
                currentQuestion: 0,
                score: 0
            };

            await client.sendMessage(customerPhone, "Paiement Reçu ! 🎯\n\nChoisis ta matière :\n1. MATHS\n2. SVT\n3. PCT\n4. PHILO\n5. FRANCAIS\n6. HIST-GEO\n7. ANGLAIS\n8. ESPAGNOL\n9. ALLEMAND\n\n_Tu peux taper 'ANNULER' à tout moment pour quitter._");
        }
    }
    res.sendStatus(200);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`📡 Listening on port ${PORT}`));
client.initialize();