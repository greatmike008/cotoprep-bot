require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
const { FedaPay, Transaction } = require('fedapay');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

app.qrCodeImage = null;

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
    console.log('🔄 Initializing WhatsApp client...');
    
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'cotoprep-main'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        }
    });

    let initTimeout;

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ Loading: ${percent}% - ${message}`);
        
        clearTimeout(initTimeout);
        initTimeout = setTimeout(() => {
            console.log('⚠️ Initialization timeout - restarting...');
            client.destroy().then(() => setTimeout(() => initializeBot(), 5000));
        }, 180000); // 3 minutes max
    });

    client.on('authenticated', () => {
        console.log('✅ AUTHENTICATED');
        clearTimeout(initTimeout);
    });

    client.on('auth_failure', msg => {
        console.error('❌ AUTH FAILED:', msg);
        clearTimeout(initTimeout);
    });

    client.on('disconnected', (reason) => {
        console.log('⚠️ Disconnected:', reason);
        clearTimeout(initTimeout);
        setTimeout(() => {
            console.log('🔄 Reconnecting...');
            client.initialize();
        }, 10000);
    });

    client.on('qr', async (qr) => {
        clearTimeout(initTimeout);
        app.qrCodeImage = await QRCode.toDataURL(qr);
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✨ QR CODE READY ✨');
        console.log('👉 https://cotoprep-bot.onrender.com/scan');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('ready', () => {
        clearTimeout(initTimeout);
        app.qrCodeImage = null;
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🚀 BOT IS LIVE AND READY!');
        console.log('📱 Number:', client.info.wid.user);
        console.log('👤 Name:', client.info.pushname);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    });

    // --- MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        try {
            console.log(`📩 [${new Date().toLocaleTimeString()}] ${msg.from}: "${msg.body}"`);
            
            const userId = msg.from;
            const text = msg.body.toUpperCase().trim();

            let dbUser = await User.findOne({ userId });

            // CLASSEMENT Command
            if (text === 'CLASSEMENT') {
                const topUsers = await User.find().sort({ total: -1 }).limit(5);
                let resp = "🏆 *TOP 5 GÉNIES* 🏆\n\n";
                topUsers.forEach((u, i) => { 
                    resp += `${i+1}. ${u.name || "Étudiant"} - ${u.total}pts\n`; 
                });
                return msg.reply(resp);
            }

            // QUIZ Command
            if (text === 'QUIZ') {
                console.log('🎯 QUIZ triggered by:', userId);
                await msg.reply('⏳ Génération du lien de paiement (500 CFA)...');
                
                try {
                    const transaction = await Transaction.create({
                        description: 'Accès Quiz CotoPrep',
                        amount: 500,
                        currency: { iso: 'XOF' },
                        custom_metadata: { phone: userId } 
                    });
                    const token = await transaction.generateToken();
                    await msg.reply(`💳 *Paye ici pour commencer:*\n${token.url}`);
                    console.log('✅ Payment link sent');
                } catch (e) { 
                    console.error('❌ FedaPay Error:', e.message); 
                    await msg.reply('❌ Erreur paiement. Réessaye.');
                }
                return;
            }

            // Quiz Session Handling
            if (userSessions[userId]) {
                let session = userSessions[userId];
                
                if (text === 'ANNULER') { 
                    delete userSessions[userId]; 
                    return msg.reply("❌ Quiz annulé."); 
                }

                // Subject Selection
                if (!session.subject) {
                    const subjects = ['MATHS', 'SVT', 'PCT', 'PHILO', 'FRANCAIS', 'HIST-GEO', 'ANGLAIS', 'ESPAGNOL', 'ALLEMAND'];
                    const choice = parseInt(text) - 1;
                    
                    if (choice >= 0 && choice < subjects.length) {
                        session.subject = subjects[choice];
                        session.questions = [...quizData[session.subject]]
                            .sort(() => Math.random() - 0.5)
                            .slice(0, 25);
                        const q = session.questions[0];
                        await msg.reply(`*Q1/${session.questions.length}*\n\n${q.question}\n\n${q.options.join('\n')}\n\n_Tape A, B ou C_`);
                        console.log(`📚 Subject selected: ${session.subject}`);
                    } else { 
                        return msg.reply("❌ Choix invalide. Tape 1-9."); 
                    }
                    return;
                }

                // Answer Handling
                const currentQ = session.questions[session.currentQuestion];
                if (['A', 'B', 'C'].includes(text)) {
                    const isCorrect = text === currentQ.answer;
                    if (isCorrect) session.score++;
                    
                    session.currentQuestion++;
                    
                    if (session.currentQuestion < session.questions.length) {
                        const nextQ = session.questions[session.currentQuestion];
                        const progress = `${session.currentQuestion + 1}/${session.questions.length}`;
                        await msg.reply(`${isCorrect ? '✅' : '❌'}\n\n*Q${progress}*\n\n${nextQ.question}\n\n${nextQ.options.join('\n')}`);
                    } else {
                        // Quiz Complete
                        const contact = await msg.getContact();
                        if (!dbUser) {
                            dbUser = new User({ 
                                userId, 
                                name: contact.pushname || "Étudiant" 
                            });
                        }
                        dbUser.total += session.score;
                        await dbUser.save();
                        
                        const percentage = Math.round((session.score / session.questions.length) * 100);
                        await msg.reply(
                            `🎉 *QUIZ TERMINÉ!*\n\n` +
                            `Score: ${session.score}/${session.questions.length} (${percentage}%)\n` +
                            `🏆 Total Points: ${dbUser.total}\n\n` +
                            `Tape *CLASSEMENT* pour voir le top 5!`
                        );
                        
                        console.log(`✅ Quiz completed - Score: ${session.score}/${session.questions.length}`);
                        delete userSessions[userId];
                    }
                }
            }
        } catch (error) {
            console.error('❌ Message Error:', error);
            msg.reply('❌ Erreur. Réessaye ou tape ANNULER.');
        }
    });

    client.initialize();
    global.whatsappClient = client;
}

// --- EXPRESS ROUTES ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>CotoPrep Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: 'Segoe UI', Tahoma, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    text-align: center;
                    padding: 50px 20px;
                    margin: 0;
                }
                .container {
                    max-width: 500px;
                    margin: 0 auto;
                    background: rgba(255,255,255,0.1);
                    padding: 40px;
                    border-radius: 20px;
                    backdrop-filter: blur(10px);
                }
                h1 { font-size: 2.5em; margin: 0; }
                .status { 
                    color: #4ade80; 
                    font-weight: bold; 
                    font-size: 1.2em;
                    margin: 20px 0;
                }
                .btn {
                    display: inline-block;
                    background: #25D366;
                    color: white;
                    padding: 15px 40px;
                    text-decoration: none;
                    border-radius: 50px;
                    font-size: 1.1em;
                    margin-top: 30px;
                    transition: transform 0.2s;
                }
                .btn:hover { transform: scale(1.05); }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 CotoPrep Bot</h1>
                <p class="status">✅ ONLINE</p>
                <p>Bot de quiz pour préparation aux examens</p>
                <a href="/scan" class="btn">📱 Scanner QR Code</a>
            </div>
        </body>
        </html>
    `);
});

app.get('/scan', (req, res) => {
    if (app.qrCodeImage) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Scan QR - CotoPrep</title>
                <meta http-equiv="refresh" content="30">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body {
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        background: #0b141a;
                        color: white;
                        font-family: sans-serif;
                        margin: 0;
                        padding: 20px;
                    }
                    .qr-container {
                        background: white;
                        padding: 30px;
                        border-radius: 20px;
                        box-shadow: 0 10px 50px rgba(0,0,0,0.5);
                    }
                    img { width: 300px; height: 300px; display: block; }
                    h2 { margin: 20px 0 10px; }
                    .refresh { font-size: 12px; color: #888; margin-top: 20px; }
                </style>
            </head>
            <body>
                <div class="qr-container">
                    <img src="${app.qrCodeImage}" alt="QR Code"/>
                </div>
                <h2>📱 Scannez avec WhatsApp</h2>
                <p>Ouvrez WhatsApp → Appareils connectés → Scanner</p>
                <p class="refresh">⏱️ Auto-refresh dans 30s...</p>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>CotoPrep Bot</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body {
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        background: #0b141a;
                        color: white;
                        font-family: sans-serif;
                    }
                    h1 { color: #25D366; }
                </style>
            </head>
            <body>
                <h1>✅ Bot Connecté!</h1>
                <p>Pas besoin de rescanner.</p>
                <a href="/" style="color: #25D366; margin-top: 20px;">← Retour</a>
            </body>
            </html>
        `);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body.entity || req.body;
        console.log('📥 Webhook:', JSON.stringify(data, null, 2));
        
        if (data.status === 'approved') {
            const phone = data.custom_metadata?.phone;
            if (phone && global.whatsappClient) {
                userSessions[phone] = { 
                    subject: null, 
                    currentQuestion: 0, 
                    score: 0 
                };
                
                await global.whatsappClient.sendMessage(
                    phone, 
                    "✅ *Paiement Confirmé!* 🎯\n\n" +
                    "Choisis ta matière:\n" +
                    "1️⃣ MATHS\n2️⃣ SVT\n3️⃣ PCT\n4️⃣ PHILO\n" +
                    "5️⃣ FRANCAIS\n6️⃣ HIST-GEO\n7️⃣ ANGLAIS\n" +
                    "8️⃣ ESPAGNOL\n9️⃣ ALLEMAND\n\n" +
                    "_Tape le numéro (1-9)_"
                );
                console.log('✅ Quiz started for:', phone);
            }
        }
    } catch (err) { 
        console.error('❌ Webhook Error:', err); 
    }
    res.sendStatus(200);
});

// Keep-Alive
setInterval(() => {
    axios.get('https://cotoprep-bot.onrender.com/')
        .catch(() => {});
}, 600000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🌐 https://cotoprep-bot.onrender.com/scan`);
});
