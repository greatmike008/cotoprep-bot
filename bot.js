require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js'); // CHANGED: Use LocalAuth instead
const mongoose = require('mongoose');
const quizData = require('./questions');
const express = require('express');
const bodyParser = require('body-parser');
const { FedaPay, Transaction } = require('fedapay');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

// --- 2. OPTIMIZED BOT INITIALIZATION ---
function initializeBot() {
    // Create session directory if it doesn't exist
    const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: SESSION_DIR
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
                '--disable-dev-tools',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--metrics-recording-only',
                '--mute-audio',
                '--hide-scrollbars',
                '--disable-features=IsolateOrigins,site-per-process',
                '--blink-settings=imagesEnabled=false' // Disable images for faster load
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser'
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });

    // --- EVENT HANDLERS ---
    let initializationTimeout;

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ Loading: ${percent}% - ${message}`);
        
        // Clear any existing timeout
        if (initializationTimeout) clearTimeout(initializationTimeout);
        
        // Set a 2-minute timeout for initialization
        initializationTimeout = setTimeout(() => {
            console.log('⚠️ Initialization taking too long, restarting...');
            client.destroy().then(() => {
                console.log('🔄 Restarting bot...');
                setTimeout(() => initializeBot(), 5000);
            });
        }, 120000); // 2 minutes
    });

    client.on('authenticated', () => {
        console.log('✅ AUTHENTICATED - Session is valid!');
    });

    client.on('auth_failure', msg => {
        console.error('❌ AUTHENTICATION FAILED:', msg);
        // Clear session and restart
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
        setTimeout(() => initializeBot(), 5000);
    });

    client.on('disconnected', (reason) => {
        console.log('⚠️ Client disconnected:', reason);
        clearTimeout(initializationTimeout);
        // Auto-reconnect after 10 seconds
        setTimeout(() => {
            console.log('🔄 Reconnecting...');
            client.initialize();
        }, 10000);
    });

    client.on('qr', async (qr) => {
        clearTimeout(initializationTimeout); // Clear timeout when QR is generated
        
        app.qrCodeImage = await QRCode.toDataURL(qr);
        
        console.log('--------------------------------------------');
        console.log('✨ NEW QR CODE GENERATED ✨');
        console.log('👉 SCAN HERE: https://cotoprep-bot.onrender.com/scan');
        console.log('--------------------------------------------');

        qrcodeTerminal.generate(qr, { small: true });
        
        // Set 60-second timeout for QR scanning
        setTimeout(() => {
            if (app.qrCodeImage) {
                console.log('⏰ QR Code expired, generating new one...');
            }
        }, 60000);
    });

    client.on('ready', () => {
        clearTimeout(initializationTimeout); // Clear timeout on success
        app.qrCodeImage = null;
        console.log('🚀 CotoPrep Bot is LIVE and Ready!');
        console.log('📱 Phone Number:', client.info.wid.user);
        console.log('📲 WhatsApp Name:', client.info.pushname);
    });

    // --- 3. MESSAGE HANDLING ---
    client.on('message', async (msg) => {
        try {
            console.log(`📩 NEW MESSAGE from ${msg.from}: "${msg.body}"`);
            
            const userId = msg.from;
            const text = msg.body.toUpperCase().trim();

            let dbUser = await User.findOne({ userId });

            if (text === 'CLASSEMENT') {
                const topUsers = await User.find().sort({ total: -1 }).limit(5);
                let resp = "🏆 *TOP 5 GÉNIES* 🏆\n\n";
                topUsers.forEach((u, i) => { 
                    resp += `${i+1}. ${u.name || "Étudiant"} - ${u.total}pts\n`; 
                });
                return msg.reply(resp);
            }

            if (text === 'QUIZ') {
                console.log('🎯 QUIZ command received from:', userId);
                await msg.reply('Génération du lien de paiement (500 CFA)...');
                try {
                    const transaction = await Transaction.create({
                        description: 'Accès Quiz CotoPrep',
                        amount: 500,
                        currency: { iso: 'XOF' },
                        custom_metadata: { phone: userId } 
                    });
                    const token = await transaction.generateToken();
                    await msg.reply(`💳 Paye ici pour commencer : ${token.url}`);
                    console.log('✅ Payment link sent successfully');
                } catch (e) { 
                    console.error('❌ FedaPay Error:', e); 
                    await msg.reply('❌ Erreur lors de la génération du paiement. Réessaye plus tard.');
                }
                return;
            }

            if (userSessions[userId]) {
                let session = userSessions[userId];
                
                if (text === 'ANNULER') { 
                    delete userSessions[userId]; 
                    return msg.reply("❌ Quiz annulé."); 
                }

                if (!session.subject) {
                    const subjects = ['MATHS', 'SVT', 'PCT', 'PHILO', 'FRANCAIS', 'HIST-GEO', 'ANGLAIS', 'ESPAGNOL', 'ALLEMAND'];
                    const choice = parseInt(text) - 1;
                    
                    if (choice >= 0 && choice < subjects.length) {
                        session.subject = subjects[choice];
                        session.questions = [...quizData[session.subject]]
                            .sort(() => Math.random() - 0.5)
                            .slice(0, 25);
                        const q = session.questions[0];
                        await msg.reply(`*Q1:* ${q.question}\n\n${q.options.join('\n')}`);
                    } else { 
                        return msg.reply("❌ Tape 1-9."); 
                    }
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
                        if (!dbUser) {
                            dbUser = new User({ 
                                userId, 
                                name: contact.pushname || "Étudiant" 
                            });
                        }
                        dbUser.total += session.score;
                        await dbUser.save();
                        await msg.reply(`✅ Fini ! Score: ${session.score}/${session.questions.length}\n🏆 Tes points sont sauvés.`);
                        delete userSessions[userId];
                    }
                }
            }
        } catch (error) {
            console.error('❌ Error handling message:', error);
        }
    });

    // Initialize the client
    console.log('🔄 Initializing WhatsApp client...');
    client.initialize();
    
    // Make client available globally for webhook
    global.whatsappClient = client;
}

// --- 4. EXPRESS ROUTES ---
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>CotoPrep Bot</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:50px;">
            <h1>🤖 CotoPrep Bot is Running!</h1>
            <p>Status: <strong style="color:green;">Active</strong></p>
            <a href="/scan" style="background:#25D366;color:white;padding:15px 30px;text-decoration:none;border-radius:5px;display:inline-block;margin-top:20px;">
                📱 Scan QR Code
            </a>
        </body>
        </html>
    `);
});

app.get('/scan', (req, res) => {
    if (app.qrCodeImage) {
        res.send(`
            <html>
                <head>
                    <title>Scan QR Code - CotoPrep</title>
                    <meta http-equiv="refresh" content="30">
                </head>
                <body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;background:#121b22;color:white;font-family:sans-serif;">
                    <div style="background:white;padding:30px;border-radius:20px;">
                        <img src="${app.qrCodeImage}" style="width:300px;height:300px;"/>
                    </div>
                    <h2 style="margin-top:20px;">📱 Scannez avec WhatsApp</h2>
                    <p>Une fois scanné, le bot démarrera automatiquement.</p>
                    <p style="font-size:12px;color:#888;">Cette page se rafraîchit automatiquement...</p>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>QR Code - CotoPrep</title>
                    <meta http-equiv="refresh" content="5">
                </head>
                <body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;background:#121b22;color:white;font-family:sans-serif;">
                    <h1>⏳ Le bot est connecté!</h1>
                    <p>Pas besoin de scanner à nouveau.</p>
                    <a href="/" style="color:#25D366;margin-top:20px;">Retour à l'accueil</a>
                </body>
            </html>
        `);
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body.entity || req.body;
        console.log('📥 Webhook received:', JSON.stringify(data, null, 2));
        
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
                    "✅ Paiement Reçu ! 🎯\n\nChoisis ta matière (1-9):\n1️⃣ MATHS\n2️⃣ SVT\n3️⃣ PCT\n4️⃣ PHILO\n5️⃣ FRANCAIS\n6️⃣ HIST-GEO\n7️⃣ ANGLAIS\n8️⃣ ESPAGNOL\n9️⃣ ALLEMAND"
                );
                console.log('✅ Quiz session started for:', phone);
            }
        }
    } catch (err) { 
        console.error('❌ Webhook Error:', err); 
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
app.listen(PORT, () => {
    console.log(`📡 Server listening on port ${PORT}`);
    console.log(`🌐 Visit: https://cotoprep-bot.onrender.com/scan`);
});
