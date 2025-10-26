require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');

// --- INITIALIZATION ---

// 1. Initialize Firebase Admin SDK
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Error initializing Firebase Admin SDK:", error);
    process.exit(1); // Stop the server if Firebase can't connect
}
const db = admin.firestore();

// 2. Initialize Express App for Mini App API
const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL })); // Allow requests from your frontend

// 3. Initialize Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- TELEGRAM BOT LOGIC ---

bot.start(async (ctx) => {
    const referrerId = ctx.startPayload; // User A's ID
    const newUser = ctx.from; // User B's info

    const userRef = db.collection('users').doc(String(newUser.id));
    const userDoc = await userRef.get();

    // Check if the user is new
    if (!userDoc.exists) {
        console.log(`New user detected: ${newUser.first_name} (ID: ${newUser.id})`);
        
        const newUserPayload = {
            name: newUser.first_name,
            username: newUser.username || '',
            balance: 0,
            gems: 0,
            unclaimedGems: 0,
            refs: 0,
            adWatch: 0,
            todayIncome: 0,
            totalWithdrawn: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            referredBy: referrerId || null,
            lastClaimDate: null,
            claimedGemsToday: 0
        };

        // If referred by someone, process the reward
        if (referrerId) {
            console.log(`User was referred by: ${referrerId}`);
            const referrerRef = db.collection('users').doc(referrerId);
            const referrerDoc = await referrerRef.get();

            if (referrerDoc.exists) {
                try {
                    // Using a batch to ensure both operations succeed or fail together
                    const batch = db.batch();
                    
                    // 1. Create the new user
                    batch.set(userRef, newUserPayload);
                    
                    // 2. Reward the referrer
                    batch.update(referrerRef, {
                        balance: admin.firestore.FieldValue.increment(25),
                        unclaimedGems: admin.firestore.FieldValue.increment(2),
                        refs: admin.firestore.FieldValue.increment(1)
                    });
                    
                    await batch.commit();
                    console.log(`Successfully rewarded referrer ${referrerId}`);

                    // 3. Notify the referrer
                    await ctx.telegram.sendMessage(
                        referrerId,
                        `🎉 Congratulations! A new user, ${newUser.first_name}, has joined using your link. You've earned 25 TK and 2 Gems!`
                    );
                } catch (error) {
                    console.error("Error processing referral reward:", error);
                }
            }
        } else {
            // If not referred, just create the user
            await userRef.set(newUserPayload);
        }
    }

    // Send welcome message to all users (new and old) on /start
    const welcomeMessage = `👋 Welcome, ${newUser.first_name}!`;
    const miniAppUrl = process.env.FRONTEND_URL;

    await ctx.replyWithPhoto(
        'https://i.postimg.cc/J4YSvR0M/start-image.png',
        {
            caption: welcomeMessage,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 Open Mini App', web_app: { url: miniAppUrl } }]
                ]
            }
        }
    );
});


// --- API ENDPOINT FOR MINI APP ---

app.post('/claim-gems', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: "User ID is required." });
    }

    const userRef = db.collection('users').doc(String(userId));

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("User not found.");
            }

            const userData = userDoc.data();
            const { unclaimedGems, lastClaimDate, claimedGemsToday } = userData;
            
            if (unclaimedGems <= 0) {
                throw new Error("You have no gems to claim.");
            }

            const today = new Date().toISOString().slice(0, 10); // Format: YYYY-MM-DD
            let currentClaimCount = claimedGemsToday || 0;

            // If it's a new day, reset the daily claim count
            if (lastClaimDate !== today) {
                currentClaimCount = 0;
            }
            
            if (currentClaimCount >= 6) {
                throw new Error("You have reached your daily claim limit of 6 gems.");
            }
            
            const gemsToClaim = Math.min(unclaimedGems, 6 - currentClaimCount);

            transaction.update(userRef, {
                unclaimedGems: admin.firestore.FieldValue.increment(-gemsToClaim),
                gems: admin.firestore.FieldValue.increment(gemsToClaim),
                claimedGemsToday: admin.firestore.FieldValue.increment(gemsToClaim),
                lastClaimDate: today
            });
        });

        res.status(200).json({ message: "Gems claimed successfully!" });

    } catch (error) {
        console.error(`Error claiming gems for user ${userId}:`, error.message);
        res.status(400).json({ message: error.message });
    }
});


// --- START SERVER AND BOT ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

bot.launch().then(() => {
    console.log("Telegram bot started successfully.");
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));