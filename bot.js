require('dotenv').config();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
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

FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
FedaPay.setEnvironment('sandbox');

let userSessions = {};

// --- 2. BAILEYS BOT INITIALIZATION ---
async function startBot() {
    const authDir = path.join(__dirname, 'auth_info_baileys');
    
    // Create auth directory if it doesn't exist
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log('🔄 Initializing Baileys WhatsApp Bot...');
    console.log('📱 Using WA version:', version);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }), // Silent mode - no spam logs
        browser: ['CotoPrep Bot', 'Chrome', '1.0.0'],
        markOnlineOnConnect: true
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR CODE
        if (qr) {
            app.qrCodeImage = await QRCode.toDataURL(qr);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✨ QR CODE READY ✨');
            console.log('👉 https://cotoprep-bot.onrender.com/scan');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            qrcodeTerminal.generate(qr, { small: true });
        }

        // CONNECTION CLOSED
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            console.log('⚠️ Connection closed:', lastDisconnect?.error?.message);
            
            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 5 seconds...');
                setTimeout(() => startBot(), 5000);
            } else {
                console.log('❌ Logged out. Delete auth_info_baileys folder and restart.');
            }
        }

        // CONNECTED
        if (connection === 'open') {
            app.qrCodeImage = null;
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🚀 BOT IS LIVE AND READY!');
            console.log('📱 Connected Successfully');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }
    });

    // --- 3. MESSAGE HANDLER ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        try {
            const from = msg.key.remoteJid;
            const messageText = msg.message.conversation || 
                               msg.message.extendedTextMessage?.text || '';
            
            const text = messageText.toUpperCase().trim();
            
            console.log(`📩 [${new Date().toLocaleTimeString()}] ${from}: "${messageText}"`);

            let dbUser = await User.findOne({ userId: from });

            // Helper function to send message
            const sendMessage = async (text) => {
                await sock.sendMessage(from, { text });
            };

            // CLASSEMENT Command
            if (text === 'CLASSEMENT') {
                const topUsers = await User.find().sort({ total: -1 }).limit(5);
                let resp = "🏆 *TOP 5 GÉNIES* 🏆\n\n";
                topUsers.forEach((u, i) => { 
                    resp += `${i+1}. ${u.name || "Étudiant"} - ${u.total}pts\n`; 
                });
                return sendMessage(resp);
            }

            // QUIZ Command
            if (text === 'QUIZ') {
                console.log('🎯 QUIZ triggered by:', from);
                await sendMessage('⏳ Génération du lien de paiement (500 CFA)...');
                
                try {
                    // Extract phone number from WhatsApp JID
                    const phoneNumber = from.split('@')[0]; // Gets "22997123456" from "22997123456@s.whatsapp.net"
                    
                    const transaction = await Transaction.create({
                        description: 'Accès Quiz CotoPrep',
                        amount: 500,
                        currency: { iso: 'XOF' },
                        callback_url: 'https://cotoprep-bot.onrender.com/webhook',
                        custom_metadata: { 
                            phone: from,
                            whatsapp_number: phoneNumber 
                        }
                    });
                    
                    const token = await transaction.generateToken({
                        // Force Mobile Money only
                        mode: 'mtn', // or 'moov' - This removes card/bank options
                        mobile: {
                            number: phoneNumber.startsWith('229') ? phoneNumber : '229' + phoneNumber
                        }
                    });
                    
                    await sendMessage(
                        `💳 *Paiement Mobile Money - 500 CFA*\n\n` +
                        `Clique ici: ${token.url}\n\n` +
                        `📱 Ton numéro: ${phoneNumber}\n` +
                        `_Le paiement s'ouvrira directement avec ton numéro._`
                    );
                    console.log('✅ Payment link sent for:', phoneNumber);
                } catch (e) { 
                    console.error('❌ FedaPay Error:', e.message); 
                    await sendMessage('❌ Erreur paiement. Réessaye plus tard.');
                }
                return;
            }

            // Quiz Session Handling
            if (userSessions[from]) {
                let session = userSessions[from];
                
                if (text === 'ANNULER') { 
                    delete userSessions[from]; 
                    return sendMessage("❌ Quiz annulé."); 
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
                        await sendMessage(
                            `*Q1/${session.questions.length}*\n\n` +
                            `${q.question}\n\n` +
                            `${q.options.join('\n')}\n\n` +
                            `_Tape A, B ou C_`
                        );
                        console.log(`📚 Subject: ${session.subject}`);
                    } else { 
                        return sendMessage("❌ Choix invalide. Tape 1-9."); 
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
                        await sendMessage(
                            `${isCorrect ? '✅ Correct!' : '❌ Faux! Réponse: ' + currentQ.answer}\n\n` +
                            `*Q${progress}*\n\n` +
                            `${nextQ.question}\n\n` +
                            `${nextQ.options.join('\n')}`
                        );
                    } else {
                        // Quiz Complete
                        const userName = msg.pushName || "Étudiant";
                        if (!dbUser) {
                            dbUser = new User({ 
                                userId: from, 
                                name: userName 
                            });
                        }
                        dbUser.total += session.score;
                        await dbUser.save();
                        
                        const percentage = Math.round((session.score / session.questions.length) * 100);
                        await sendMessage(
                            `🎉 *QUIZ TERMINÉ!*\n\n` +
                            `${isCorrect ? '✅' : '❌'}\n` +
                            `Score: ${session.score}/${session.questions.length} (${percentage}%)\n` +
                            `🏆 Total Points: ${dbUser.total}\n\n` +
                            `Tape *CLASSEMENT* pour voir le top 5!`
                        );
                        
                        console.log(`✅ Quiz done - ${session.score}/${session.questions.length}`);
                        delete userSessions[from];
                    }
                }
            }
        } catch (error) {
            console.error('❌ Message Error:', error);
            await sock.sendMessage(msg.key.remoteJid, { 
                text: '❌ Erreur. Réessaye ou tape ANNULER.' 
            });
        }
    });

    // Make socket globally available
    global.whatsappSocket = sock;
}

// --- 4. EXPRESS ROUTES ---
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
                <p class="status">✅ ONLINE (Baileys)</p>
                <p>Bot de quiz ultra-rapide ⚡</p>
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
                    .steps {
                        text-align: left;
                        max-width: 400px;
                        margin: 20px 0;
                        line-height: 1.8;
                    }
                    .refresh { font-size: 12px; color: #888; margin-top: 20px; }
                </style>
            </head>
            <body>
                <div class="qr-container">
                    <img src="${app.qrCodeImage}" alt="QR Code"/>
                </div>
                <h2>📱 Comment scanner ?</h2>
                <div class="steps">
                    1️⃣ Ouvre WhatsApp<br>
                    2️⃣ Va dans Paramètres<br>
                    3️⃣ Appareils connectés<br>
                    4️⃣ Connecter un appareil<br>
                    5️⃣ Scanne ce QR code
                </div>
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
                <p>Le QR code n'est plus nécessaire.</p>
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
            if (phone && global.whatsappSocket) {
                userSessions[phone] = { 
                    subject: null, 
                    currentQuestion: 0, 
                    score: 0 
                };
                
                await global.whatsappSocket.sendMessage(phone, {
                    text: "✅ *Paiement Confirmé!* 🎯\n\n" +
                          "Choisis ta matière:\n" +
                          "1️⃣ MATHS\n2️⃣ SVT\n3️⃣ PCT\n4️⃣ PHILO\n" +
                          "5️⃣ FRANCAIS\n6️⃣ HIST-GEO\n7️⃣ ANGLAIS\n" +
                          "8️⃣ ESPAGNOL\n9️⃣ ALLEMAND\n\n" +
                          "_Tape le numéro (1-9)_"
                });
                console.log('✅ Quiz started for:', phone);
            }
        }
    } catch (err) { 
        console.error('❌ Webhook Error:', err); 
    }
    res.sendStatus(200);
});

// 🧪 TEST ROUTE - Simulate payment approval (SANDBOX ONLY!)
app.get('/test-payment/:phone', async (req, res) => {
    try {
        const phone = req.params.phone;
        
        // Simulate webhook data
        const fakeWebhook = {
            entity: {
                status: 'approved',
                custom_metadata: { phone: phone }
            }
        };
        
        // Trigger the same logic as webhook
        if (global.whatsappSocket) {
            userSessions[phone] = { 
                subject: null, 
                currentQuestion: 0, 
                score: 0 
            };
            
            await global.whatsappSocket.sendMessage(phone, {
                text: "✅ *Paiement Test Approuvé!* 🎯\n\n" +
                      "Choisis ta matière:\n" +
                      "1️⃣ MATHS\n2️⃣ SVT\n3️⃣ PCT\n4️⃣ PHILO\n" +
                      "5️⃣ FRANCAIS\n6️⃣ HIST-GEO\n7️⃣ ANGLAIS\n" +
                      "8️⃣ ESPAGNOL\n9️⃣ ALLEMAND\n\n" +
                      "_Tape le numéro (1-9)_"
            });
            
            res.json({ 
                success: true, 
                message: `Test payment approved for ${phone}`,
                note: 'Quiz session started!' 
            });
            console.log('🧪 TEST: Quiz started for:', phone);
        } else {
            res.status(500).json({ error: 'WhatsApp not connected' });
        }
    } catch (err) {
        console.error('❌ Test Payment Error:', err);
        res.status(500).json({ error: err.message });
    }
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

