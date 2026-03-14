// services/telegramService.js
const TelegramBot = require("node-telegram-bot-api");
const User = require("../models/User");
const Reminder = require("../models/Reminder");
const ConversationSession = require("../models/ConversationSession");
const aiService = require("./aiService");
const reminderService = require("./reminderService");

let bot = null;

function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === "your_telegram_bot_token_here") {
    console.log("[Telegram] Bot token not configured, skipping init");
    return null;
  }

  try {
    if (process.env.NODE_ENV === "production") {
      // ── WEBHOOK MODE ──
      // IMPORTANT: Do NOT pass { webHook: true } — that starts an internal
      // webhook HTTP server inside the library which would process messages
      // a second time alongside our Express /webhook route.
      // Instead init with no options and call bot.processUpdate() manually.
      bot = new TelegramBot(token);
      console.log("[Telegram] ✅ Bot initialized in webhook mode (manual processUpdate)");
    } else {
      // ── POLLING MODE (local dev) ──
      bot = new TelegramBot(token, { polling: true });
      console.log("[Telegram] ✅ Bot initialized in polling mode");
      setupMessageHandlers();
    }
    return bot;
  } catch (err) {
    console.error("[Telegram] Failed to init bot:", err.message);
    return null;
  }
}

function getBot() {
  return bot;
}

async function sendMessage(chatId, text, options = {}) {
  if (!bot) {
    console.warn("[Telegram] Bot not initialized, cannot send message");
    return false;
  }
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...options });
    console.log(`[Telegram] Sent to ${chatId}: "${text.substring(0, 60)}..."`);
    return true;
  } catch (err) {
    console.error(`[Telegram] Send error to ${chatId}:`, err.message);
    return false;
  }
}

// ─── HANDLE INCOMING MESSAGE ──────────────────────────────────────────────────
async function handleIncomingMessage(msg) {
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = msg.text?.trim();
  const telegramUsername = msg.from?.username;

  console.log(`\n[Telegram] Message from chatId=${chatId}: "${text}"`);

  if (!text) return;

  // ── /start with verification code ──
  if (text.startsWith("/start")) {
    const verifyCode = text.split(" ")[1];
    if (verifyCode) {
      await handleVerification(chatId, verifyCode, telegramUsername, msg.from?.first_name);
    } else {
      const user = await User.findOne({ telegramChatId: chatId });
      if (user) {
        await sendMessage(chatId, `👋 Welcome back, *${user.name}*!\n\nSend me a reminder like:\n• _"Remind me to take medicine tomorrow at 8am"_\n• _"Show my reminders"_\n• _"Delete reminder to call John"_`);
      } else {
        await sendMessage(chatId, `👋 Welcome to *ReminderFlow*!\n\nTo get started:\n1. Go to the ReminderFlow app\n2. Login with Google\n3. Click "Connect Telegram"\n4. Use the code to link this account`);
      }
    }
    return;
  }

  // ── Check user is linked ──
  const user = await User.findOne({ telegramChatId: chatId, isActive: true });
  if (!user) {
    await sendMessage(chatId, `❌ Your Telegram is not linked to any account.\n\nPlease visit the app, login with Google, and connect Telegram.`);
    return;
  }

  console.log(`[Telegram] User: ${user.email}`);

  // ── Check for active conversation session ──
  const session = await ConversationSession.findOne({
    userId: user._id,
    source: "telegram",
    state: { $nin: ["complete", "cancelled"] },
  });

  const history = session?.messages || [];

  // ── Process with AI ──
  const aiResult = await aiService.processMessage(text, history, user.timezone);
  const aiData = aiResult.data;
  console.log(`[Telegram] AI intent: ${aiData.intent}`);

  const updatedHistory = [
    ...history,
    { role: "user", content: text },
    { role: "assistant", content: aiData.userMessage },
  ];

  try {
    switch (aiData.intent) {
      case "CREATE":
        await handleCreateIntent(user, chatId, aiData, updatedHistory, session);
        break;
      case "LIST":
        await handleListIntent(user, chatId, aiData);
        break;
      case "DELETE":
        await handleDeleteIntent(user, chatId, aiData);
        break;
      case "UPDATE":
        await handleUpdateIntent(user, chatId);
        break;
      case "SEARCH":
        await handleSearchIntent(user, chatId, aiData);
        break;
      case "ANSWER":
        await handleAnswerIntent(user, chatId, text, updatedHistory, session);
        break;
      case "IRRELEVANT":
      default:
        await sendMessage(chatId, aiData.userMessage || "I can only help with reminders and alerts 😊");
        if (session) {
          await ConversationSession.findByIdAndUpdate(session._id, { state: "cancelled" });
        }
        break;
    }
  } catch (err) {
    console.error("[Telegram] Handler error:", err.message);
    await sendMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
}

async function handleVerification(chatId, verifyCode, telegramUsername, firstName) {
  console.log(`[Telegram] Verifying code=${verifyCode} for chatId=${chatId}`);

  const user = await User.findOne({
    telegramVerifyCode: verifyCode,
    telegramVerifyExpiry: { $gt: new Date() },
    isActive: true,
  });

  if (!user) {
    await sendMessage(chatId, "❌ Invalid or expired code.\n\nPlease generate a new code from the app.");
    return;
  }

  user.telegramChatId = chatId;
  user.telegramUsername = telegramUsername || null;
  user.telegramConnectedAt = new Date();
  user.telegramVerifyCode = null;
  user.telegramVerifyExpiry = null;
  await user.save();

  console.log(`[Telegram] ✅ Account linked: userId=${user._id}`);

  await sendMessage(
    chatId,
    `✅ *Telegram linked successfully!*\n\nHi ${firstName || user.name}! You can now:\n• Set reminders by chatting here\n• Get reminder alerts on Telegram\n\nTry it: _"Remind me to drink water every day at 8am"_ 💧`
  );
}

async function handleCreateIntent(user, chatId, aiData, history, session) {
  if (aiData.needsFollowUp) {
    const sessionData = {
      userId: user._id,
      source: "telegram",
      telegramChatId: chatId,
      state: `awaiting_${aiData.followUpField || "datetime"}`,
      partialReminder: { ...(session?.partialReminder || {}), ...(aiData.reminderData || {}) },
      messages: history,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };

    if (session) {
      await ConversationSession.findByIdAndUpdate(session._id, sessionData);
    } else {
      await ConversationSession.create(sessionData);
    }

    await sendMessage(chatId, aiData.followUpQuestion || aiData.userMessage);
  } else {
    const reminderData = {
      ...(session?.partialReminder || {}),
      ...(aiData.reminderData || {}),
    };
    const created = await reminderService.createReminder(user._id, reminderData, "telegram");

    if (session) {
      await ConversationSession.findByIdAndUpdate(session._id, { state: "complete" });
    }

    const scheduledTime = new Date(created.scheduledAt).toLocaleString("en-US", {
      timeZone: user.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });

    await sendMessage(
      chatId,
      `✅ *Reminder Set!*\n\n📌 *${created.title}*\n🕐 ${scheduledTime}${created.recurrence !== "none" ? `\n🔄 Repeats: ${created.recurrence}` : ""}\n⚡ Priority: ${created.priority}`
    );
  }
}

async function handleAnswerIntent(user, chatId, text, history, session) {
  if (!session) {
    await sendMessage(chatId, "I'm not sure what you're referring to. Try: _'Remind me to...'_");
    return;
  }

  const contextMsg = `CONTINUING REMINDER CREATION. Partial data collected so far: ${JSON.stringify(session.partialReminder)}. User answer: ${text}`;
  const aiResult = await aiService.processMessage(contextMsg, history, user.timezone);
  await handleCreateIntent(user, chatId, aiResult.data, history, session);
}

async function handleListIntent(user, chatId, aiData) {
  const filters = aiData.listFilters || {};
  const reminders = await reminderService.listReminders(user._id, {
    status: filters.status || "active",
    limit: filters.limit || 10,
    search: filters.search,
  });

  if (reminders.length === 0) {
    await sendMessage(chatId, "📭 No active reminders.\n\nCreate one: _'Remind me to...'_");
    return;
  }

  let msg = `📋 *Your Reminders* (${reminders.length})\n\n`;
  reminders.forEach((r, i) => {
    const time = new Date(r.scheduledAt).toLocaleString("en-US", {
      timeZone: user.timezone,
      dateStyle: "short",
      timeStyle: "short",
    });
    const recur = r.recurrence !== "none" ? " 🔄" : "";
    const pri = r.priority === "high" ? " 🔴" : r.priority === "low" ? " 🟢" : " 🟡";
    msg += `${i + 1}. *${r.title}*${recur}${pri}\n   📅 ${time}\n\n`;
  });

  await sendMessage(chatId, msg);
}

async function handleDeleteIntent(user, chatId, aiData) {
  const target = aiData.deleteTarget;
  if (!target) {
    await sendMessage(chatId, "Which reminder would you like to delete? Be more specific.");
    return;
  }

  let reminder = null;
  if (target.reminderId) {
    reminder = await Reminder.findOne({ _id: target.reminderId, userId: user._id });
  } else if (target.searchText) {
    reminder = await Reminder.findOne({
      userId: user._id,
      status: "active",
      title: { $regex: target.searchText, $options: "i" },
    });
  }

  if (!reminder) {
    await sendMessage(chatId, `❌ Reminder not found. Use _"show my reminders"_ to see your list.`);
    return;
  }

  reminder.status = "deleted";
  await reminder.save();
  await sendMessage(chatId, `🗑️ Deleted: *${reminder.title}*`);
}

async function handleUpdateIntent(user, chatId) {
  await sendMessage(chatId, "To update a reminder, please use the ReminderFlow app for full editing options.");
}

async function handleSearchIntent(user, chatId, aiData) {
  const filters = aiData.listFilters || {};
  const reminders = await reminderService.listReminders(user._id, {
    search: filters.search || aiData.deleteTarget?.searchText,
    status: "active",
    limit: 10,
  });

  if (reminders.length === 0) {
    await sendMessage(chatId, `🔍 No reminders found.`);
    return;
  }

  let msg = `🔍 *Search Results* (${reminders.length})\n\n`;
  reminders.forEach((r, i) => {
    const time = new Date(r.scheduledAt).toLocaleString("en-US", {
      timeZone: user.timezone,
      dateStyle: "short",
      timeStyle: "short",
    });
    msg += `${i + 1}. *${r.title}*\n   📅 ${time}\n\n`;
  });

  await sendMessage(chatId, msg);
}

function setupMessageHandlers() {
  if (!bot) return;

  bot.on("message", async (msg) => {
    try {
      await handleIncomingMessage(msg);
    } catch (err) {
      console.error("[Telegram] Unhandled error in message handler:", err.message);
    }
  });

  bot.on("polling_error", (err) => {
    console.error("[Telegram] Polling error:", err.message);
  });

  console.log("[Telegram] Message handlers attached");
}

async function sendReminderAlert(reminder, user) {
  if (!bot || !user.telegramChatId) return false;

  const time = new Date(reminder.scheduledAt).toLocaleString("en-US", {
    timeZone: user.timezone,
    timeStyle: "short",
  });

  const msg =
    `🔔 *REMINDER*\n\n` +
    `📌 *${reminder.title}*\n` +
    `${reminder.description ? `📝 ${reminder.description}\n` : ""}` +
    `🕐 ${time}\n` +
    `${reminder.recurrence !== "none" ? `🔄 Repeats: ${reminder.recurrence}\n` : ""}` +
    `\n_ReminderFlow_ ✨`;

  return await sendMessage(user.telegramChatId, msg);
}

module.exports = {
  initBot,
  getBot,
  sendMessage,
  sendReminderAlert,
  handleIncomingMessage,
  setupMessageHandlers,
};
