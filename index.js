require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const axios = require('axios'); // ফাইলটির উপরে ইমপোর্ট করতে হবে (npm install axios)

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

// এই ফাংশনটি ফাইলের শুরুতে বা bot.start এর আগে যোগ করতে পারেন (অথবা bot.start এর ভেতরেও রাখতে পারেন)
function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

bot.start(async (ctx) => {
    const referrerId = ctx.startPayload;
    const newUser = ctx.from;
    const userRef = db.collection('users').doc(String(newUser.id));
    const userDoc = await userRef.get();

    // ১. ব্যবহারকারীর প্রোফাইল ছবির URL নিয়ে আসুন
    let photoUrl = `https://i.pravatar.cc/150?u=${newUser.id}`; 
    try {
        const userProfilePhotos = await ctx.telegram.getUserProfilePhotos(newUser.id);
        if (userProfilePhotos.total_count > 0) {
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
            photoUrl: photoUrl,
            balance: 25,
            gems: 0,
            unclaimedGems: 0,
            refs: 0,
            totalAdsWatched: 0,
            adWatch: 0,
            todayIncome: 0,
            totalWithdrawn: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            referredBy: referrerId || null,
            lastClaimDate: null,
            claimedGemsToday: 0,
            completedTasks: [],
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
                
                await db.runTransaction(async (t) => {
                    const referrerDoc = await t.get(referrerRef);
                    if (referrerDoc.exists) {
                        const refData = referrerDoc.data();
                        const today = new Date().toISOString().slice(0, 10);
                        
                        // দৈনিক রেফার কাউন্ট লজিক
                        let newDailyCount = 1;
                        let currentVouchers = { v9: false, v19: false }; // ডিফল্ট

                        if (refData.lastRefDate === today) {
                            newDailyCount = (refData.dailyRefCount || 0) + 1;
                            currentVouchers = refData.dailyVouchers || { v9: false, v19: false };
                        }

                        t.update(referrerRef, {
                            balance: admin.firestore.FieldValue.increment(25),
                            unclaimedGems: admin.firestore.FieldValue.increment(2),
                            refs: admin.firestore.FieldValue.increment(1),
                            
                            // নতুন ফিল্ডগুলো আপডেট
                            dailyRefCount: newDailyCount,
                            lastRefDate: today,
                            dailyVouchers: currentVouchers
                        });
                    }
                });
                
                // ... (Notification sending code remains same)
            }

            await batch.commit();
            console.log(`Successfully created new user ${newUser.id}.`);
        } catch (error) {
            console.error("Error during new user creation:", error);
        }
        // Notify referrer safely (moved outside transaction)
        try {
            await ctx.telegram.sendMessage(referrerId, `🎉 অভিনন্দন! আপনার লিঙ্কের মাধ্যমে একজন নতুন ব্যবহারকারী, ${escapeHtml(newUser.first_name)}, জয়েন করেছে। আপনি 25 টাকা এবং 2টি জেম পেয়েছেন!`);
        } catch (err) {
            console.log(`Failed to notify referrer ${referrerId}:`, err.message);
        }
    } else {
        await userRef.update({
            name: newUser.first_name,
            photoUrl: photoUrl
        });
    }

    const miniAppUrl = process.env.FRONTEND_URL;

    // নামের মধ্যে থাকা বিশেষ ক্যারেক্টারগুলো HTML এ কনভার্ট করা হলো যাতে এরর না দেয়
    const safeName = escapeHtml(newUser.first_name);

    // 👇 এখানে পরিবর্তন করা হয়েছে: ** এর বদলে <b> ব্যবহার করা হয়েছে এবং parse_mode: 'HTML' দেওয়া হয়েছে
    const newCaption = `🌟 <b>HubCoin-এ স্বাগতম, ${safeName}!</b>
আপনার প্রতিদিনের আয়ের যাত্রা এখন শুরু।

💰 <b>যেভাবে আয় করবেন:</b>
- <b>বিজ্ঞাপন দেখুন:</b> প্রতিটি বিজ্ঞাপনের জন্য ৳15 আয় করুন।
- <b>বন্ধুদের রেফার করুন:</b> প্রতিটি রেফারের জন্য ৳25 পান।

💸 <b>টাকা উত্তোলন:</b>
- খুব সহজে বিকাশ, নগদ, বা বাইন্যান্সের মাধ্যমে ক্যাশ আউট করুন।`;

    // 👇 এখানে আপনার নতুন ফায়ারবেস ইমেজের লিংকটি বসানো হলো
    await ctx.replyWithPhoto(
        'https://firebasestorage.googleapis.com/v0/b/hub-coin-94aff.firebasestorage.app/o/start-photo.jpg?alt=media&token=be5e1f04-6228-4ef5-9c5d-e1c56b83e56f',
        {
            caption: newCaption,
            parse_mode: 'HTML', // HTML মোড চালু থাকবে

            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 মিনি অ্যাপ খুলুন', web_app: { url: miniAppUrl } }],
                    [{ text: 'চ্যানেলে যোগ দিন', url: 'https://t.me/HubCoin_miner' }],
                    [{ text: 'কিভাবে কাজ করবেন!', url: 'https://www.facebook.com/share/v/1DKbo61opw/' }]
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

// +++ নতুন Adsgram Task Ad-এর জন্য API Endpoint +++
// Adsgram এই URL-এ রিকোয়েস্ট পাঠিয়ে পুরস্কার দেবে
app.get('/api/grant-reward-firestore', async (req, res) => {
    const { userid } = req.query;
    const REWARD_GEMS = 1; // +++ পুরস্কার পরিবর্তন করে ১ জেম করা হলো +++

    if (!userid) {
        console.log('Adsgram Callback Error: userid পাওয়া যায়নি।');
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }

    console.log(`Adsgram থেকে পুরস্কারের রিকোয়েস্ট এসেছে: User ${userid}`);

    try {
        const userRef = db.collection('users').doc(String(userid));
        await userRef.update({
            // +++ balance এর পরিবর্তে gems বাড়ানো হচ্ছে +++
            gems: admin.firestore.FieldValue.increment(REWARD_GEMS) 
        });
        console.log(`সফলভাবে ${REWARD_GEMS} জেম পুরস্কার দেওয়া হয়েছে: User ${userid}`);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error(`Adsgram Callback Error (User ${userid}):`, error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// ✅ API: CHECK BALANCE (For HubCoin Verification)
app.post('/api/check-balance', async (req, res) => {
    const { userId } = req.body;

    try {
        const userRef = db.collection('users').doc(String(userId));
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const data = userSnap.data();
        const balance = data.balance || 0; // Using 'balance' to match your schema

        // Return the balance
        res.json({ success: true, balance: balance });

    } catch (error) {
        console.error("Balance Check Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// HubCoin Backend - index.js (Express App এর ভেতরে)

// ...

app.post('/verify-pocket-money', async (req, res) => {
    const { userId, taskId } = req.body;
    
    // Pocket Money ব্যাকএন্ড URL (আপনার Pocket Money অ্যাপের আসল লিংক দিন)
    // উদাহরণ: "https://pocket-quiz.onrender.com/api/check-balance"
    const POCKET_MONEY_API = "https://pocket-quiz.onrender.com/api/check-balance"; 

    try {
        // ১. HubCoin এ চেক: ইউজার কি অলরেডি রিওয়ার্ড পেয়েছে?
        const userRef = db.collection('users').doc(String(userId));
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found" });
        if (userDoc.data().completedTasks && userDoc.data().completedTasks.includes(taskId)) {
            return res.json({ success: true, message: "Already completed." });
        }

        // ২. Pocket Money অ্যাপে রিকোয়েস্ট পাঠানো (ব্যালেন্স চেক করার জন্য)
        const pmResponse = await axios.post(POCKET_MONEY_API, { userId: userId });
        
        // ৩. ব্যালেন্স ভ্যালিডেশন (২০০ টাকা বা বেশি)
        const pmBalance = pmResponse.data.balance || 0;
        
        if (pmBalance >= 200) {
            // শর্ত পূরণ হয়েছে: ১০ জেম দিন
            await userRef.update({
                gems: admin.firestore.FieldValue.increment(10),
                completedTasks: admin.firestore.FieldValue.arrayUnion(taskId)
            });
            
            // ট্রানজেকশন হিস্ট্রিতেও রাখতে পারেন
            // ...

            return res.json({ success: true, message: "Task Verified!" });
        } else {
            return res.json({ 
                success: false, 
                message: `আপনার Pocket Money ব্যালেন্স ${pmBalance}৳। টাস্কের জন্য ২০০৳ প্রয়োজন।` 
            });
        }

    } catch (error) {
        console.error("Verification API Error:", error.message);
        return res.json({ success: false, message: "যাচাইকরণে ত্রুটি হয়েছে। অনুগ্রহ করে Pocket Money অ্যাপটি চেক করুন।" });
    }
});

// --- API: Verify Human ---
app.post('/api/verify-human', async (req, res) => {
    const { userId, name, age, district } = req.body;

    if (!userId || !name || !age || !district) {
        return res.status(400).json({ success: false, message: "সব তথ্য প্রদান করুন।" });
    }

    const userRef = db.collection('users').doc(String(userId));

    try {
        await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) {
                throw new Error("ব্যবহারকারী পাওয়া যায়নি।");
            }
            
            const userData = userDoc.data();
            if (userData.isVerified) {
                throw new Error("আপনি ইতিমধ্যেই ভেরিফাইড।");
            }

            // আপডেট করা
            transaction.update(userRef, {
                isVerified: true,
                verificationData: { // ইউজারের সাবমিট করা ডাটা সেভ করা
                    submittedName: name,
                    age: age,
                    district: district,
                    verifiedAt: admin.firestore.FieldValue.serverTimestamp()
                },
                completedTasks: admin.firestore.FieldValue.arrayUnion('verify_human_task') // টাস্ক কমপ্লিট হিসেবে মার্ক করা
            });
        });

        res.json({ success: true, message: "Verification Successful" });

    } catch (error) {
        console.error("Verify API Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
});

// --- নতুন API: ভাউচার ক্লেইম করার জন্য (index.js এর শেষে যোগ করুন) ---

app.post('/api/claim-ref-voucher', async (req, res) => {
    const { userId, voucherType } = req.body; // voucherType হবে 'v9' অথবা 'v19'

    try {
        const userRef = db.collection('users').doc(String(userId));
        
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");

            const data = userDoc.data();
            const today = new Date().toISOString().slice(0, 10);

            // চেক ১: আজকের ডেটা কিনা
            if (data.lastRefDate !== today) {
                throw new Error("আজকের কোনো রেফারেল ডেটা নেই বা মেয়াদ শেষ।");
            }

            // চেক ২: ভাউচার টার্গেট পূরণ হয়েছে কিনা
            const count = data.dailyRefCount || 0;
            if (voucherType === 'v9' && count < 9) throw new Error("৯টি রেফার পূর্ণ হয়নি।");
            if (voucherType === 'v19' && count < 19) throw new Error("১৯টি রেফার পূর্ণ হয়নি।");

            // চেক ৩: অলরেডি ক্লেইম করা হয়েছে কিনা
            const vouchers = data.dailyVouchers || { v9: false, v19: false };
            if (vouchers[voucherType]) {
                throw new Error("এই ভাউচারটি ইতিমধ্যে ক্লেইম করা হয়েছে।");
            }

            // রিওয়ার্ড নির্ধারণ
            const reward = (voucherType === 'v9') ? 10 : 25; // ১৯ রেফারে ২৫ জেম (বোনাস)

            // আপডেট
            vouchers[voucherType] = true;
            
            t.update(userRef, {
                gems: admin.firestore.FieldValue.increment(reward),
                dailyVouchers: vouchers
            });
        });

        res.json({ success: true, message: "ভাউচার রিওয়ার্ড যোগ করা হয়েছে!" });

    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
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