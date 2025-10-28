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
            balance: 25, // Welcome bonus
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

        try {
            // Use a batch to ensure all initial operations succeed or fail together
            const batch = db.batch();

            // 1. Create the new user
            batch.set(userRef, newUserPayload);

            // 2. Create a transaction for the new user's welcome bonus
            const transactionRef = db.collection('transactions').doc();
            batch.set(transactionRef, {
                userId: String(newUser.id),
                description: 'Welcome Bonus',
                amount: 25,
                type: 'credit',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // 3. If referred by someone, process the reward
            if (referrerId) {
                const referrerRef = db.collection('users').doc(referrerId);
                const referrerDoc = await referrerRef.get();

                if (referrerDoc.exists) {
                    console.log(`User was referred by: ${referrerId}`);
                    // Add referrer reward to the batch
                    batch.update(referrerRef, {
                        balance: admin.firestore.FieldValue.increment(25),
                        unclaimedGems: admin.firestore.FieldValue.increment(2),
                        refs: admin.firestore.FieldValue.increment(1)
                    });
                }
            }

            await batch.commit();
            console.log(`Successfully created new user ${newUser.id}.`);

            // 4. Notify the referrer (outside the batch) if they exist
            if (referrerId && (await db.collection('users').doc(referrerId).get()).exists) {
                await ctx.telegram.sendMessage(referrerId, `🎉 Congratulations! A new user, ${newUser.first_name}, has joined using your link. You've earned 25 TK and 2 Gems!`);
                console.log(`Successfully rewarded and notified referrer ${referrerId}`);
            }
        } catch (error) {
            console.error("Error during new user creation/referral processing:", error);
        }
    }

    // Send welcome message to all users (new and old) on /start
    const welcomeMessage = `👋 Welcome, ${newUser.first_name}!`;
    const miniAppUrl = process.env.FRONTEND_URL;

    // নতুন টেক্সট এবং বাটনসহ মেসেজ
    const newCaption = `${welcomeMessage}\n\n💎 Earn daily by watching ads & referring friends. Withdraw easily to bKash, Nagad, or Binance 🚀\nPer refer 25৳\nPer ads 15৳`;

    await ctx.replyWithPhoto(
        'https://i.postimg.cc/J4YSvR0M/start-image.png',
        {
            caption: newCaption, // এখানে নতুন ক্যাপশন ব্যবহার করা হয়েছে
            reply_markup: {
                inline_keyboard: [
                    // সারি ১: আগের বাটনটি
                    [{ text: '🚀 Open Mini App', web_app: { url: miniAppUrl } }],
                    
                    // সারি ২: নতুন জয়েন চ্যানেল বাটন
                    [{ text: 'Join Channel', url: 'https://t.me/HubCoin_miner' }],
                    
                    // সারি ৩: নতুন ইউটিউব বাটন
                    [{ text: 'কিভাবে কাজ করবেন!', url: 'https://youtube.com/@hubcoin_miner?si=LDCKadRWDKsGqG0j' }]
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


// --- ADVANCED MAILING/BROADCAST FEATURE WITH CONFIRMATION ---

const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID);

// This object will store the state of the admin's mailing process
const mailingState = {};

// --- Step 1: Admin starts the process with /mailing ---
bot.command('mailing', (ctx) => {
    if (ctx.from.id !== ADMIN_USER_ID) {
        return ctx.reply('Sorry, you are not authorized to use this command.');
    }

    // Set the state: Bot is now waiting for the message content from the admin
    mailingState[ADMIN_USER_ID] = { step: 'awaiting_message' };
    
    // Ask the admin to send the message
    ctx.reply('❇️ Send the message you want to broadcast to all users.');
});

// --- Step 2: Bot listens for the next message from the admin ---
bot.on('message', async (ctx) => {
    // Check if the message is from the admin AND if the admin is in the mailing process
    if (ctx.from.id === ADMIN_USER_ID && mailingState[ADMIN_USER_ID]?.step === 'awaiting_message') {
        
        // Store the message to be sent and move to the confirmation step
        mailingState[ADMIN_USER_ID].message = ctx.message;
        mailingState[ADMIN_USER_ID].step = 'awaiting_confirmation';

        // Show the confirmation prompt
        await ctx.reply('❇️ Please check the message below and confirm the broadcast...');
        
        // Forward the exact message to the admin for confirmation
        await ctx.telegram.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id);

        // Add "Send" and "Cancel" buttons
        await ctx.reply('Are you sure you want to send this to all users?', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Send', callback_data: 'confirm_broadcast' },
                        { text: '❌ Cancel', callback_data: 'cancel_broadcast' }
                    ]
                ]
            }
        });
    }
});


// --- Step 3: Admin clicks "Send" or "Cancel" button ---

// If "Cancel" is clicked
bot.action('cancel_broadcast', (ctx) => {
    if (ctx.from.id !== ADMIN_USER_ID) return;

    // Clear the state
    delete mailingState[ADMIN_USER_ID];
    
    ctx.editMessageText('Mailing cancelled.');
});

// If "Send" is clicked
bot.action('confirm_broadcast', async (ctx) => {
    if (ctx.from.id !== ADMIN_USER_ID) return;

    const messageToSend = mailingState[ADMIN_USER_ID]?.message;
    if (!messageToSend) {
        return ctx.editMessageText('Something went wrong. Please start over with /mailing.');
    }

    // Clear the state immediately to prevent double sending
    delete mailingState[ADMIN_USER_ID];
    
    await ctx.editMessageText('Broadcast started... I will send you a report when finished.');

    // --- The actual broadcasting logic starts here ---
    try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
            return ctx.reply('No users found in the database.');
        }

        let successCount = 0;
        let failureCount = 0;
        const promises = [];

        usersSnapshot.forEach(doc => {
            const userId = doc.id;
            // Use copyMessage to send any type of message (text, photo, etc.)
            const promise = ctx.telegram.copyMessage(userId, messageToSend.chat.id, messageToSend.message_id)
                .then(() => successCount++)
                .catch(err => {
                    console.log(`Failed to send to ${userId}:`, err.message);
                    failureCount++;
                });
            promises.push(promise);
        });
        
        await Promise.all(promises);

        await ctx.reply(
            `Broadcast finished.\n` +
            `✅ Successfully sent to: ${successCount} users.\n` +
            `❌ Failed to send to: ${failureCount} users.`
        );

    } catch (error) {
        console.error("Broadcast error:", error);
        await ctx.reply('An error occurred during the broadcast.');
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