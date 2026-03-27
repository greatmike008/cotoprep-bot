require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const mongoose = require('mongoose');
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

app.qrCodeImage = null; 
let sock = null;

// --- ADMIN CONFIG ---
const ADMIN_NUMBER = '2290141356526'; // Your WhatsApp admin number
const SISTER_MOMO = '+2290150396598'; // Sister's MTN MoMo number
const QUIZ_PRICE = 500; // CFA

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
    nameConfirmed: { type: Boolean, default: false }, // Has user confirmed their payment name?
    total: { type: Number, default: 0 },
    giftClaimed: { type: Boolean, default: false },
    paidUntil: { type: Date, default: null },
    paymentStatus: { type: String, enum: ['pending', 'approved', 'expired'], default: 'pending' }
});
const User = mongoose.model('User', userSchema);

// Admin registration schema
const adminSchema = new mongoose.Schema({
    whatsappId: { type: String, unique: true }, // The LID or phone format from WhatsApp
    phoneNumber: { type: String, unique: true }, // The actual phone number
    registeredAt: { type: Date, default: Date.now }
});
const Admin = mongoose.model('Admin', adminSchema);

// --- 2. HELPER FUNCTIONS ---
const isAdmin = async (userId) => {
    // Check if this WhatsApp ID is registered as admin
    const adminUser = await Admin.findOne({ whatsappId: userId });
    return !!adminUser;
};

const hasActiveAccess = async (userId) => {
    // userId comes in as [number]@lid or [number]@s.whatsapp.net format from Baileys
    // Just find the exact user
    const user = await User.findOne({ userId });
    
    if (!user) return false;
    if (!user.paidUntil) return false;
    return new Date() < new Date(user.paidUntil);
};

const grantAccess = async (lidNumber) => {
    // LID format: user gives us just the number (e.g., 198350716575759)
    // We need to find the user with userId: [number]@lid
    
    const fullLid = lidNumber + '@lid';
    
    // Find user with exact LID
    let user = await User.findOne({ userId: fullLid });
    
    // If not found, create new one
    if (!user) {
        user = new User({ userId: fullLid, name: 'Utilisateur' });
    }
    
    // Grant 24h access
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    user.paidUntil = tomorrow;
    user.paymentStatus = 'approved';
    await user.save();
    return user;
};

const getPendingPayments = async () => {
    return await User.find({ paymentStatus: 'pending' });
};

const getTimeRemaining = async (userId) => {
    const user = await User.findOne({ userId });
    
    if (!user || !user.paidUntil) return null;
    const now = new Date();
    const remaining = user.paidUntil - now;
    if (remaining <= 0) return null;
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
};

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
            console.log(`📩 Message from: ${from}`); 

            const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const text = messageText.toUpperCase().trim();
            
            const sendMessage = async (text) => { await sock.sendMessage(from, { text }); };

            // Check if user is new or needs name confirmation
            const existingUser = await User.findOne({ userId: from });
            
            // NEW USER - Ask for name
            if (!existingUser) {
                const newUser = new User({ 
                    userId: from, 
                    name: null,
                    nameConfirmed: false,
                    paymentStatus: 'pending' 
                });
                await newUser.save();
                return sendMessage(`👋 *BIENVENUE SUR COTOPREP!*\n\n📝 Avant de commencer, quel est ton *NOM COMPLET*?\n\nC'est important car tu devras écrire EXACTEMENT ce nom dans la description de ton virement!\n\nExemple: Si tu réponds "Ahmed Mohamed", tu devras écrire "Ahmed Mohamed" dans le message de paiement.`);
            }
            
            // USER EXISTS BUT NAME NOT CONFIRMED - Save their response as name
            if (!existingUser.nameConfirmed) {
                existingUser.name = messageText.trim(); // Save their exact response
                existingUser.nameConfirmed = true;
                await existingUser.save();
                return sendMessage(`✅ *Parfait!*\n\n📌 Ton nom de paiement: *${existingUser.name}*\n\nAssure-toi d'écrire *EXACTEMENT* ceci dans la description du virement:\n"${existingUser.name}"\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎓 *BIENVENUE SUR COTOPREP!* 🎓\n\nSalut! 👋 Je suis ton assistant d'études pour l'examen BAAC.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎯 *COMMENT ÇA MARCHE?*\n\n1️⃣ Tape *DÉMARRER* pour commencer\n2️⃣ Paie 500 CFA à ${SISTER_MOMO}\n3️⃣ Écris "${existingUser.name}" dans le message de virement\n4️⃣ Envoie-moi la confirmation\n5️⃣ J'active ton accès (24h)\n6️⃣ Étudie sans limites! 📚\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📋 *MES COMMANDES:*\n\n📚 *DÉMARRER* - Accéder aux quiz\n🏆 *CLASSEMENT* - Top 5 des meilleurs étudiants\n⏱️ *TEMPS* - Voir ton temps restant\n💡 *AIDE* - Questions fréquentes\n📱 *CONTACT* - Besoin d'aide? (Admin)\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n👉 *Prêt?* Tape *DÉMARRER* pour commencer! 🚀`);
            }

            // REGISTER_ADMIN command - admin registers their own LID
            if (text.startsWith('REGISTER_ADMIN ')) {
                const lidNumber = text.split(' ')[1];
                if (!lidNumber) {
                    return sendMessage('❌ Format: REGISTER_ADMIN [LID_number]\nExemple: REGISTER_ADMIN 198350716575759\n\nUse your LID number (the one shown in chat info)');
                }
                
                try {
                    // Check if already registered
                    const existingAdmin = await Admin.findOne({ whatsappId: from });
                    if (existingAdmin) {
                        return sendMessage(`⚠️ Tu es déjà enregistré comme admin!\n\nTon LID: ${existingAdmin.phoneNumber}`);
                    }
                    
                    // Register new admin
                    const newAdmin = new Admin({ whatsappId: from, phoneNumber: lidNumber });
                    await newAdmin.save();
                    return sendMessage(`✅ *ADMIN ENREGISTRÉ!*\n\n🔐 Ton LID: ${lidNumber}\n\nTu peux maintenant utiliser:\n• *APPROVE* [LID_number]\n• *PENDING* - Voir les paiements en attente\n• *INFO* - Statistiques`);
                } catch (err) {
                    console.error('Admin registration error:', err);
                    return sendMessage('❌ Erreur lors de l\'enregistrement. LID déjà utilisé?');
                }
            }

            // --- ADMIN COMMANDS ---
            const isAdminUser = await isAdmin(from);
            if (isAdminUser) {
                // APPROVE command (using LID format)
                if (text.startsWith('APPROVE ')) {
                    const lidNumber = text.split(' ')[1];
                    if (!lidNumber) {
                        return sendMessage('❌ Format: APPROVE [LID_number]\n\nTape *PENDING* pour voir les LID des utilisateurs en attente\nExemple: APPROVE 198350716575759');
                    }
                    
                    try {
                        const user = await grantAccess(lidNumber);
                        await sendMessage(`✅ *Accès APPROUVÉ!*\n\n📱 LID: ${lidNumber}\n⏰ Valide 24h jusqu'à demain\n\nLe message de confirmation a été envoyé à l'utilisateur.`);
                        
                        // Send confirmation to user
                        const fullLid = lidNumber + '@lid';
                        try {
                            await sock.sendMessage(fullLid, { 
                                text: `✅ *PAIEMENT CONFIRMÉ!*\n\n🎉 Ton accès est activé!\n⏰ Valide pour 24h\n\nTape *DÉMARRER* pour commencer! 🚀` 
                            });
                        } catch (err) {
                            console.log('Could not send confirmation to user, but approval is done');
                        }
                        return;
                    } catch (err) {
                        console.error('APPROVE error:', err);
                        return sendMessage('❌ Erreur lors de l\'approbation. Vérifie le LID!');
                    }
                }

                // PENDING command
                if (text === 'PENDING') {
                    const pending = await getPendingPayments();
                    if (pending.length === 0) {
                        return sendMessage('✅ Aucun paiement en attente!');
                    }
                    let resp = `⏳ *PAIEMENTS EN ATTENTE* (${pending.length})\n\n`;
                    pending.forEach((u, i) => {
                        // Extract just the number from the LID
                        const lidNumber = u.userId.split('@')[0];
                        resp += `${i+1}. 📝 Nom: *${u.name || 'N/A'}*\n   🆔 LID: ${lidNumber}\n\n`;
                    });
                    resp += '━━━━━━━━━━━━━━━━━━━━━━\n📝 Utilise: *APPROVE [LID_number]*\nExemple: APPROVE 198350716575759';
                    return sendMessage(resp);
                }

                // INFO command (admin only)
                if (text === 'INFO') {
                    const totalUsers = await User.countDocuments();
                    const approvedUsers = await User.countDocuments({ paymentStatus: 'approved' });
                    const pendingUsers = await User.countDocuments({ paymentStatus: 'pending' });
                    return sendMessage(`📊 *STATISTIQUES*\n\n👥 Total utilisateurs: ${totalUsers}\n✅ Approuvés: ${approvedUsers}\n⏳ En attente: ${pendingUsers}`);
                }


            }

            // 1. Handle Global Commands
            if (text === 'CLASSEMENT') {
                const topUsers = await User.find().sort({ total: -1 }).limit(5);
                let resp = "🏆 *TOP 5 GÉNIES* 🏆\n\n";
                topUsers.forEach((u, i) => { resp += `${i+1}. ${u.name || "Étudiant"} - ${u.total}pts\n`; });
                return sendMessage(resp);
            }

            if (text === 'DÉMARRER') {
                // Check if user already has active access
                const hasAccess = await hasActiveAccess(from);
                if (hasAccess) {
                    userSessions[from] = { subject: null, questions: [], currentQuestion: 0, score: 0 };
                    const timeLeft = await getTimeRemaining(from);
                    await sendMessage(`⏱️ *Tu as un accès actif!*\n\n⏰ Temps restant: ${timeLeft}\n\n🎓 *Choisis ta matière* (1-9):\n\n1. 🔢 MATHS\n2. 🧬 SVT\n3. ⚗️ PCT\n4. 🤔 PHILO\n5. 📖 FRANÇAIS\n6. 🌍 HIST-GEO\n7. 🇬🇧 ANGLAIS\n8. 🇪🇸 ESPAGNOL\n9. 🇩🇪 ALLEMAND`);
                    return;
                }

                // User needs to pay - get their confirmed name
                const user = await User.findOne({ userId: from });
                const paymentName = user && user.nameConfirmed ? user.name : 'TON NOM';

                await sendMessage(`💳 *PAIEMENT REQUIS - ${QUIZ_PRICE} CFA*\n\n📱 *Envoie un virement MTN MoMo à:*\n\n┌─────────────────────┐\n│ ${SISTER_MOMO}  │\n└─────────────────────┘\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📝 *IMPORTANT - À FAIRE ABSOLUMENT:*\n\nDans la description ou le message de ton virement, écris *EXACTEMENT*:\n\n"${paymentName}"\n\n⚠️ Doit être EXACT, sinon on ne pourra pas t'identifier!\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n✅ *Après avoir payé:*\nEnvoie-moi une confirmation et j'activerai ton accès immédiatement!\n\n⏰ *Tu auras accès pendant 24h*\n💪 Tu pourras faire autant de quiz que tu veux!\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🆘 *Besoin d'aide?* Tape *CONTACT*`);
                return;
            }

            if (text === 'AIDE') {
                return sendMessage(`❓ *COMMENT ÇA MARCHE?*\n\n1️⃣ Tape *DÉMARRER*\n2️⃣ Paie 500 CFA à ${SISTER_MOMO}\n3️⃣ Écris ton NOM CONFIRMÉ dans la description du virement\n4️⃣ Dis-moi que tu as payé\n5️⃣ J'active ton accès (24h)\n6️⃣ Commence à étudier! 📚\n\n💡 *Pendant 24h tu peux faire autant de quizz que tu veux!*\n\n📚 *9 matières disponibles:*\nMATHS • SVT • PCT • PHILO • FRANÇAIS • HIST-GEO • ANGLAIS • ESPAGNOL • ALLEMAND\n\n🏆 *Suivi de tes progrès* avec le *CLASSEMENT*\n\n*Autre question?* Tape *CONTACT*`);
            }

            if (text === 'CONTACT') {
                return sendMessage(`📞 *BESOIN D'AIDE?*\n\nPour toute question ou problème:\n\n👤 *Admin* - Contact direct via WhatsApp\n⏱️ *Réponse rapide* - 24h/24\n\n━━━━━━━━━━━━━━━━━━━━━━━\n\n🤔 *Questions courantes:*\n\n❓ Je ne reçois pas de confirmation?\n→ Assure-toi d'avoir écrit TON NOM EXACT dans la description du virement!\n\n❓ Combien de temps dure l'accès?\n→ 24 heures après approbation\n\n❓ Combien de quiz je peux faire?\n→ ILLIMITÉ! ✨\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\nPour d'autres questions, tape *AIDE* ou contacte directement l'admin! 😊`);
            }

            if (text === 'TEMPS') {
                const timeLeft = await getTimeRemaining(from);
                if (!timeLeft) {
                    return sendMessage('⏰ *Ton accès a expiré.*\n\nTape *DÉMARRER* pour renouveler ton accès (500 CFA)');
                }
                return sendMessage(`⏱️ *TEMPS RESTANT*\n\n${timeLeft}\n\n💪 Continue à étudier! 📚`);
            }

            if (text === 'TEST' || text === 'START') {
                const hasAccess = await hasActiveAccess(from);
                if (!hasAccess) {
                    return sendMessage(`❌ *Accès expiré!*\n\nTape *DÉMARRER* pour renouveler (500 CFA)`);
                }
                userSessions[from] = { subject: null, questions: [], currentQuestion: 0, score: 0 };
                await sendMessage("🧪 *MODE TEST*\n\n🎓 *Choisis ta matière* (1-9):\n\n1. 🔢 MATHS\n2. 🧬 SVT\n3. ⚗️ PCT\n4. 🤔 PHILO\n5. 📖 FRANÇAIS\n6. 🌍 HIST-GEO\n7. 🇬🇧 ANGLAIS\n8. 🇪🇸 ESPAGNOL\n9. 🇩🇪 ALLEMAND");
                return;
            }

            // 2. Handle Active Quiz Sessions
            if (userSessions[from]) {
                let session = userSessions[from];
                
                if (text === 'ANNULER') { 
                    delete userSessions[from]; 
                    return sendMessage("❌ Quiz annulé."); 
                }

                // Stage A: Selecting Subject
                if (!session.subject) {
                    const subjects = ['MATHS', 'SVT', 'PCT', 'PHILO', 'FRANCAIS', 'HIST-GEO', 'ANGLAIS', 'ESPAGNOL', 'ALLEMAND'];
                    const choice = parseInt(text) - 1;
                    
                    if (!isNaN(choice) && choice >= 0 && choice < subjects.length) {
                        const selectedSub = subjects[choice];
                        const rawQuestions = quizData[selectedSub] || [];
                        
                        if (rawQuestions.length === 0) {
                            delete userSessions[from];
                            return sendMessage(`❌ Erreur: Aucune question trouvée pour ${selectedSub}.`);
                        }

                        session.subject = selectedSub;
                        session.questions = [...rawQuestions].sort(() => Math.random() - 0.5).slice(0, 25);
                        session.currentQuestion = 0;

                        const q = session.questions[0];
                        return sendMessage(`📚 *MATIÈRE: ${session.subject}*\n\n*Q1/${session.questions.length}*\n\n${q.question}\n\n${q.options.map((opt, i) => `${String.fromCharCode(65+i)}. ${opt}`).join('\n')}\n\n_Réponds par A, B ou C_`);
                    } else { 
                        return sendMessage("❌ Choix invalide. Tape un chiffre de 1 à 9."); 
                    }
                }

                // Stage B: Answering Questions
                const currentQ = session.questions[session.currentQuestion];
                if (['A', 'B', 'C'].includes(text)) {
                    const isCorrect = text === currentQ.answer.toUpperCase();
                    let feedback = isCorrect ? "✅ *Correct !*" : `❌ *Faux !*\nLa réponse était: *${currentQ.answer}*`;
                    
                    if (currentQ.explanation) feedback += `\n\n💡 ${currentQ.explanation}`;

                    if (isCorrect) session.score++;
                    session.currentQuestion++;

                    if (session.currentQuestion < session.questions.length) {
                        const nextQ = session.questions[session.currentQuestion];
                        await sendMessage(`${feedback}\n\n------------------\n\n*Q${session.currentQuestion+1}/${session.questions.length}*\n\n${nextQ.question}\n\n${nextQ.options.map((opt, i) => `${String.fromCharCode(65+i)}. ${opt}`).join('\n')}`);
                    } else {
                        // End of Quiz - find user by exact ID
                        let dbUser = await User.findOne({ userId: from });
                        if (!dbUser) { dbUser = new User({ userId: from, name: msg.pushName || "Étudiant" }); }
                        
                        dbUser.total += session.score;
                        await dbUser.save();
                        
                        const percentage = Math.round((session.score / session.questions.length) * 100);
                        let emoji = '🌟';
                        if (percentage < 60) emoji = '💪';
                        else if (percentage < 80) emoji = '👍';
                        
                        await sendMessage(`🎉 *QUIZ TERMINÉ !*\n\n📊 Score: ${session.score}/${session.questions.length} (${percentage}%)\n💯 Total cumulé: ${dbUser.total} pts\n\n${emoji} ${percentage >= 80 ? 'Excellent travail!' : percentage >= 60 ? 'Pas mal!' : 'Continue tes efforts!'}\n\n━━━━━━━━━━━━━━━━━━━━━━\n\nTape:\n📚 *DÉMARRER* - Nouveau quiz\n🏆 *CLASSEMENT* - Top 5\n📱 *CONTACT* - Questions`);
                        delete userSessions[from];
                    }
                } else {
                    return sendMessage("⚠️ Réponds par *A*, *B* ou *C*.");
                }
                return;
            }

            // Fallback: Unknown command
            return sendMessage(`❌ Commande non reconnue.\n\n📋 *COMMANDES DISPONIBLES:*\n\n📚 *DÉMARRER* - Commencer un quiz\n🏆 *CLASSEMENT* - Top 5\n⏱️ *TEMPS* - Temps restant\n💡 *AIDE* - Questions fréquentes\n📞 *CONTACT* - Besoin d'aide?\n\n👉 Tape *DÉMARRER* pour commencer! 🚀`);

        } catch (error) { 
            console.error('❌ Error in message handler:', error); 
        }
    });
    global.whatsappSocket = sock;
}

// --- 3. EXPRESS ROUTES ---
app.get('/', (req, res) => { res.send('<h1>CotoPrep Bot Online</h1><p>Visit <a href="/scan">/scan</a> to link WhatsApp.</p>'); });

app.get('/scan', (req, res) => {
    if (app.qrCodeImage) {
        res.send(`<html>
<head>
    <title>CotoPrep Bot - Scan QR Code</title>
    <style>
        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 15px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            text-align: center;
        }
        h1 {
            color: #333;
            margin: 0 0 10px 0;
            font-size: 28px;
        }
        p {
            color: #666;
            margin: 10px 0;
            font-size: 14px;
        }
        img {
            border: 5px solid #667eea;
            border-radius: 10px;
            padding: 15px;
            background: white;
            margin: 20px 0;
            box-shadow: 0 5px 20px rgba(0,0,0,0.1);
            max-width: 400px;
            width: 100%;
        }
        .refresh-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 12px 30px;
            font-size: 16px;
            border-radius: 5px;
            cursor: pointer;
            margin-top: 20px;
            transition: background 0.3s;
        }
        .refresh-btn:hover {
            background: #764ba2;
        }
        .status {
            font-size: 12px;
            color: #999;
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 Scan to Link CotoPrep Bot</h1>
        <p>Point your phone's camera at this QR code</p>
        <img src="${app.qrCodeImage}" alt="QR Code">
        <p>✅ Use your WhatsApp app to scan</p>
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh QR Code</button>
        <div class="status">QR code expires after ~60 seconds</div>
    </div>
</body>
</html>`);
    } else {
        res.send(`<html>
<head>
    <title>CotoPrep Bot - Status</title>
    <style>
        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 15px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            text-align: center;
        }
        h1 {
            color: #333;
            margin: 0;
        }
        p {
            color: #666;
            font-size: 16px;
        }
        .refresh-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 12px 30px;
            font-size: 16px;
            border-radius: 5px;
            cursor: pointer;
            margin-top: 20px;
        }
        .refresh-btn:hover {
            background: #764ba2;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔌 Bot Status</h1>
        <p>✅ Bot is connected or starting up</p>
        <p>No QR code available at the moment</p>
        <button class="refresh-btn" onclick="location.reload()">🔄 Check Again</button>
    </div>
</body>
</html>`);
    }
});

app.post('/webhook', async (req, res) => {
    // Placeholder for future payment gateway integration if needed
    res.sendStatus(200);
});

setInterval(() => { axios.get('https://cotoprep-bot.onrender.com/').catch(() => {}); }, 300000);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`📡 Port ${PORT}`); });
