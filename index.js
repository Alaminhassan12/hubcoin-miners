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

// +++ নতুন এবং আপগ্রেড করা bot.start ফাংশন +++
bot.start(async (ctx) => {
    const referrerId = ctx.startPayload;
    const newUser = ctx.from;
    const userRef = db.collection('users').doc(String(newUser.id));
    const userDoc = await userRef.get();

    // ১. ব্যবহারকারীর প্রোফাইল ছবির URL নিয়ে আসুন
    let photoUrl = `https://i.pravatar.cc/150?u=${newUser.id}`; // ডিফল্ট ছবি
    try {
        const userProfilePhotos = await ctx.telegram.getUserProfilePhotos(newUser.id);
        if (userProfilePhotos.total_count > 0) {
            // সবচেয়ে ভালো কোয়ালিটির ছবিটি (সাধারণত শেষেরটি) নিন
            const fileId = userProfilePhotos.photos[0].pop().file_id;
            const fileLink = await ctx.telegram.getFileLink(fileId);
            photoUrl = fileLink.href;
        }
    } catch (error) {
        console.log(`Could not fetch profile photo for user ${newUser.id}:`, error.message);
    }

    // ২. ব্যবহারকারী নতুন হলে তাকে তৈরি করুন
    if (!userDoc.exists) {
        console.log(`New user detected: ${newUser.first_name} (ID: ${newUser.id})`);
        
        const newUserPayload = {
            name: newUser.first_name,
            username: newUser.username || '',
            photoUrl: photoUrl, // +++ নতুন ফিল্ড যোগ করা হলো +++
            balance: 25,
            gems: 0,
            unclaimedGems: 0,
            refs: 0,
            adWatch: 0,
            todayIncome: 0,
            totalWithdrawn: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            referredBy: referrerId || null,
            lastClaimDate: null, // This and below are for gem claims
            claimedGemsToday: 0,
            completedTasks: [], // For bonus tasks
            leaderboardUnlocked: false // <-- শুধু এই লাইনটি যোগ করুন
        };

        try {
            const batch = db.batch();
            batch.set(userRef, newUserPayload);

            const transactionRef = db.collection('transactions').doc();
            batch.set(transactionRef, {
                userId: String(newUser.id),
                description: 'স্বাগতম বোনাস',
                amount: 25,
                type: 'credit',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            if (referrerId) {
                const referrerRef = db.collection('users').doc(referrerId);
                const referrerDoc = await referrerRef.get();
                if (referrerDoc.exists) {
                    console.log(`User was referred by: ${referrerId}`);
                    batch.update(referrerRef, {
                        balance: admin.firestore.FieldValue.increment(25),
                        unclaimedGems: admin.firestore.FieldValue.increment(2),
                        refs: admin.firestore.FieldValue.increment(1)
                    });

                    // Notify referrer outside the batch
                    ctx.telegram.sendMessage(referrerId, `🎉 অভিনন্দন! আপনার লিঙ্কের মাধ্যমে একজন নতুন ব্যবহারকারী, ${newUser.first_name}, জয়েন করেছে। আপনি 25 টাকা এবং 2টি জেম পেয়েছেন!`)
                        .catch(err => console.log(`Failed to notify referrer ${referrerId}:`, err.message));
                }
            }

            await batch.commit();
            console.log(`Successfully created new user ${newUser.id} with photo URL.`);
        } catch (error) {
            console.error("Error during new user creation:", error);
        }
    // ৩. ব্যবহারকারী পুরনো হলে, শুধু তার নাম এবং ছবি আপডেট করুন
    } else {
        await userRef.update({
            name: newUser.first_name,
            photoUrl: photoUrl // ব্যবহারকারী ছবি পরিবর্তন করলে যেন আপডেট হয়ে যায়
        });
    }

    // Send welcome message to all users (new and old) on /start
    const miniAppUrl = process.env.FRONTEND_URL;

    // ছবির মতো নতুন ক্যাপশন
    const newCaption = `🌟 **HubCoin-এ স্বাগতম, ${newUser.first_name}!**
আপনার প্রতিদিনের আয়ের যাত্রা এখন শুরু।

💰 **যেভাবে আয় করবেন:**
- **বিজ্ঞাপন দেখুন:** প্রতিটি বিজ্ঞাপনের জন্য ৳15 আয় করুন।
- **বন্ধুদের রেফার করুন:** প্রতিটি রেফারের জন্য ৳25 পান।

💸 **টাকা উত্তোলন:**
- খুব সহজে বিকাশ, নগদ, বা বাইন্যান্সের মাধ্যমে ক্যাশ আউট করুন।`;

    await ctx.replyWithPhoto(
        'https://i.postimg.cc/J4YSvR0M/start-image.png', // আপনি চাইলে ছবির URL পরিবর্তন করতে পারেন
        {
            caption: newCaption,
            parse_mode: 'Markdown', // এই লাইনটি খুবই গুরুত্বপূর্ণ

            reply_markup: {
                inline_keyboard: [
                    // সারি ১: আগের বাটনটি
                    [{ text: '🚀 মিনি অ্যাপ খুলুন', web_app: { url: miniAppUrl } }],
                    
                    // সারি ২: নতুন জয়েন চ্যানেল বাটন
                    [{ text: 'চ্যানেলে যোগ দিন', url: 'https://t.me/HubCoin_miner' }],
                    
                    // সারি ৩: নতুন ইউটিউব বাটন
                    [{ text: 'কিভাবে কাজ করবেন!', url: 'https://www.facebook.com/share/v/1GXX4q7CSi/' }]
                ]
            }
        }
    );
});


// --- API ENDPOINT FOR MINI APP ---

app.post('/claim-gems', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: "ব্যবহারকারীর আইডি প্রয়োজন।" });
    }

    const userRef = db.collection('users').doc(String(userId));

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("ব্যবহারকারীকে খুঁজে পাওয়া যায়নি।");
            }

            const userData = userDoc.data();
            const { unclaimedGems, lastClaimDate, claimedGemsToday } = userData;
            
            if (unclaimedGems <= 0) {
                throw new Error("আপনার ক্লেইম করার মতো কোনো জেম নেই।");
            }

            const today = new Date().toISOString().slice(0, 10); // Format: YYYY-MM-DD
            let currentClaimCount = claimedGemsToday || 0;

            // If it's a new day, reset the daily claim count
            if (lastClaimDate !== today) {
                currentClaimCount = 0;
            }
            
            if (currentClaimCount >= 6) {
                throw new Error("আপনি জেম ক্লেইম করার দৈনিক সীমা (৬টি) অতিক্রম করেছেন।");
            }
            
            const gemsToClaim = Math.min(unclaimedGems, 6 - currentClaimCount);

            transaction.update(userRef, {
                unclaimedGems: admin.firestore.FieldValue.increment(-gemsToClaim),
                gems: admin.firestore.FieldValue.increment(gemsToClaim),
                claimedGemsToday: admin.firestore.FieldValue.increment(gemsToClaim),
                lastClaimDate: today
            });
        });

        res.status(200).json({ message: "সফলভাবে জেম ক্লেইম করা হয়েছে!" });

    } catch (error) {
        console.error(`Error claiming gems for user ${userId}:`, error.message);
        res.status(400).json({ message: error.message });
    }
});

/**
 * AdsGram থেকে পাঠানো রিওয়ার্ড কলব্যাক গ্রহণ করে Firestore-এ ব্যালেন্স আপডেট করার API এন্ডপয়েন্ট।
 */
app.get('/api/adsgram-reward', async (req, res) => {
    try {
        // ধাপ ১: URL থেকে ব্যবহারকারীর আইডি (userId) বের করা
        const userId = req.query.userid;

        if (!userId) {
            console.error("AdsGram callback: User ID is missing.");
            return res.status(400).json({ message: 'User ID is missing.' });
        }

        console.log(`[AdsGram] Received reward callback for user: ${userId}`);

        // ধাপ ২: Firestore-এ নির্দিষ্ট ব্যবহারকারীকে খুঁজে বের করা
        const userRef = db.collection('users').doc(String(userId));
        
        // পুরস্কারের পরিমাণ
        const rewardAmount = 15; // প্রতিটি বিজ্ঞাপনের জন্য ১৫ টাকা

        // ধাপ ৩: Firestore-এ ব্যবহারকারীর ব্যালেন্স নিরাপদে বাড়িয়ে দেওয়া
        await userRef.update({
            balance: admin.firestore.FieldValue.increment(rewardAmount)
        });
        
        // ধাপ ৪: সফলভাবে পুরস্কার দেওয়ার পর AdsGram-কে একটি সফল বার্তা পাঠানো
        console.log(`[AdsGram] Successfully rewarded ${rewardAmount} to user ${userId}.`);
        res.status(200).send('Reward granted.');

    } catch (error) {
        console.error('[AdsGram] Error processing reward for Firestore:', error);
        res.status(500).send('Internal Server Error.');
    }
});

// --- ADVANCED MAILING/BROADCAST FEATURE WITH CONFIRMATION ---

const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID);

// This object will store the state of the admin's mailing process
const mailingState = {};

// --- Step 1: Admin starts the process with /mailing ---
bot.command('mailing', (ctx) => {
    if (ctx.from.id !== ADMIN_USER_ID) {
        return ctx.reply('দুঃখিত, এই কমান্ডটি ব্যবহার করার অনুমতি আপনার নেই।');
    }

    // Set the state: Bot is now waiting for the message content from the admin
    mailingState[ADMIN_USER_ID] = { step: 'awaiting_message' };
    ctx.reply('❇️ সকল ব্যবহারকারীকে যে বার্তাটি পাঠাতে চান, তা সেন্ড করুন।');
    // Ask the admin to send the message
});

// --- Step 2: Bot listens for the next message from the admin ---
bot.on('message', async (ctx) => {
    // Check if the message is from the admin AND if the admin is in the mailing process
    if (ctx.from.id === ADMIN_USER_ID && mailingState[ADMIN_USER_ID]?.step === 'awaiting_message') {
        
        // Store the message to be sent and move to the confirmation step
        mailingState[ADMIN_USER_ID].message = ctx.message;
        mailingState[ADMIN_USER_ID].step = 'awaiting_confirmation';

        await ctx.reply('❇️ অনুগ্রহ করে নীচের বার্তাটি যাচাই করুন এবং ব্রডকাস্ট নিশ্চিত করুন...');
        
        // Forward the exact message to the admin for confirmation
        await ctx.telegram.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id);


        // Add "Send" and "Cancel" buttons
        await ctx.reply('Are you sure you want to send this to all users?', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Send', callback_data: 'confirm_broadcast' },
                        { text: '❌ বাতিল করুন', callback_data: 'cancel_broadcast' }
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
    ctx.editMessageText('মেইলিং বাতিল করা হয়েছে।');
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
    await ctx.editMessageText('ব্রডকাস্ট শুরু হয়েছে... শেষ হলে আমি আপনাকে একটি রিপোর্ট পাঠাবো।');


    // --- The actual broadcasting logic starts here ---
    try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
            return ctx.reply('ডাটাবেসে কোনো ব্যবহারকারী পাওয়া যায়নি।');
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
            `ব্রডকাস্ট সম্পন্ন হয়েছে।\n` +
            `✅ সফলভাবে পাঠানো হয়েছে: ${successCount} জন ব্যবহারকারীকে।\n` +
            `❌ পাঠাতে ব্যর্থ হয়েছে: ${failureCount} জন ব্যবহারকারীকে।`
        );
    } catch (error) {
        console.error("Broadcast error:", error);
        await ctx.reply('ব্রডকাস্ট করার সময় একটি ত্রুটি ঘটেছে।');
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