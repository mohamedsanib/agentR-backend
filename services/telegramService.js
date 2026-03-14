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
      bot = new TelegramBot(token, { webHook: true });
      console.log("[Telegram] Bot initialized in webhook mode");
    } else {
      bot = new TelegramBot(token, { polling: true });
      console.log("[Telegram] Bot initialized in polling mode");
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
    console.log(`[Telegram] Message sent to ${chatId}: ${text.substring(0, 50)}...`);
    return true;
  } catch (err) {
    console.error(`[Telegram] Send message error to ${chatId}:`, err.message);
    return false;
  }
}

// ─── HANDLE INCOMING TELEGRAM MESSAGE ────────────────────────────────────────
async function handleIncomingMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text?.trim();
  const telegramUsername = msg.from?.username;

  console.log(`\n[Telegram] Incoming message from chatId=${chatId}: "${text}"`);

  if (!text) return;

  // ── Handle /start with verification code ──
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const verifyCode = parts[1];

    if (verifyCode) {
      await handleVerification(chatId, verifyCode, telegramUsername, msg.from?.first_name);
      return;
    }

    // Regular /start - check if user is linked
    const user = await User.findOne({ telegramChatId: chatId });
    if (user) {
      await sendMessage(chatId, `👋 Welcome back, *${user.name}*!\n\nYou're all set. Send me a reminder like:\n• _"Remind me to take medicine tomorrow at 8am"_\n• _"Show my reminders"_\n• _"Delete reminder to call John"_`);
    } else {
      await sendMessage(chatId, `👋 Welcome to *ReminderFlow*!\n\nTo get started, please link your Telegram account:\n1. Go to [ReminderFlow App](${process.env.FRONTEND_URL})\n2. Login with Google\n3. Click "Connect Telegram"\n4. Use the code provided to link this account`);
    }
    return;
  }

  // ── Check if user is linked ──
  const user = await User.findOne({ telegramChatId: chatId, isActive: true });
  if (!user) {
    await sendMessage(chatId, `❌ Your Telegram is not linked to any ReminderFlow account.\n\nPlease:\n1. Visit ${process.env.FRONTEND_URL}\n2. Login with Google\n3. Connect your Telegram account`);
    return;
  }

  console.log(`[Telegram] User found: ${user.email}`);

  // ── Check for active session ──
  let session = await ConversationSession.findOne({
    userId: user._id,
    source: "telegram",
    state: { $nin: ["complete", "cancelled"] },
  });

  const history = session?.messages || [];

  // ── Process with AI ──
  const aiResult = await aiService.processMessage(text, history, user.timezone);
  console.log(`[Telegram] AI intent: ${aiResult.data.intent}`);

  const aiData = aiResult.data;

  // Save message to history
  const newHistory = [
    ...history,
    { role: "user", content: text },
    { role: "assistant", content: aiData.userMessage },
  ];

  // ── Route by intent ──
  try {
    switch (aiData.intent) {
      case "CREATE":
        await handleCreateIntent(user, chatId, aiData, newHistory, session);
        break;

      case "LIST":
        await handleListIntent(user, chatId, aiData);
        break;

      case "DELETE":
        await handleDeleteIntent(user, chatId, aiData);
        break;

      case "UPDATE":
        await handleUpdateIntent(user, chatId, aiData);
        break;

      case "SEARCH":
        await handleSearchIntent(user, chatId, aiData);
        break;

      case "ANSWER":
        await handleAnswerIntent(user, chatId, text, aiData, newHistory, session);
        break;

      case "IRRELEVANT":
        await sendMessage(chatId, aiData.userMessage || aiData.irrelevantResponse || "I can only help with reminders and alerts 😊");
        // Clear any session
        if (session) {
          await ConversationSession.findByIdAndUpdate(session._id, { state: "cancelled" });
        }
        break;

      default:
        await sendMessage(chatId, "Sorry, I didn't understand that. Try: _'Remind me to drink water at 9am daily'_");
    }
  } catch (err) {
    console.error("[Telegram] Handler error:", err);
    await sendMessage(chatId, "⚠️ Something went wrong. Please try again.");
  }
}

async function handleVerification(chatId, verifyCode, telegramUsername, firstName) {
  console.log(`[Telegram] Verification attempt: code=${verifyCode}, chatId=${chatId}`);

  const user = await User.findOne({
    telegramVerifyCode: verifyCode,
    telegramVerifyExpiry: { $gt: new Date() },
    isActive: true,
  });

  if (!user) {
    await sendMessage(chatId, "❌ Invalid or expired verification code.\n\nPlease generate a new code from the ReminderFlow app.");
    return;
  }

  // Link the account
  user.telegramChatId = chatId;
  user.telegramUsername = telegramUsername || null;
  user.telegramConnectedAt = new Date();
  user.telegramVerifyCode = null;
  user.telegramVerifyExpiry = null;
  await user.save();

  console.log(`[Telegram] Account linked: userId=${user._id}, chatId=${chatId}`);

  await sendMessage(
    chatId,
    `✅ *Account linked successfully!*\n\nHi ${firstName || user.name}! Your Telegram is now connected to ReminderFlow.\n\nYou can now:\n• Set reminders by chatting with me\n• Get reminder alerts here\n• Say "show my reminders" to see all active ones\n\nTry it: _"Remind me to drink water every day at 8am"_ 💧`
  );
}

async function handleCreateIntent(user, chatId, aiData, newHistory, session) {
  if (aiData.needsFollowUp) {
    // Need more info - save session and ask question
    const sessionData = {
      userId: user._id,
      source: "telegram",
      telegramChatId: chatId,
      state: `awaiting_${aiData.followUpField || "datetime"}`,
      partialReminder: aiData.reminderData || {},
      messages: newHistory,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };

    if (session) {
      await ConversationSession.findByIdAndUpdate(session._id, sessionData);
    } else {
      await ConversationSession.create(sessionData);
    }

    await sendMessage(chatId, aiData.followUpQuestion || aiData.userMessage);
  } else {
    // All info present - create reminder
    const created = await reminderService.createReminder(user._id, aiData.reminderData, "telegram");

    // Clear session
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

async function handleAnswerIntent(user, chatId, text, aiData, newHistory, session) {
  // User is answering a follow-up question
  if (!session) {
    await sendMessage(chatId, "I'm not sure what you're referring to. Could you start fresh? Try: _'Remind me to...'_");
    return;
  }

  // Re-process with full context
  const fullContext = [...(session.messages || []), { role: "user", content: text }];
  const aiResult = await aiService.processMessage(
    `CONTEXT: User was creating a reminder. Partial data: ${JSON.stringify(session.partialReminder)}. User's answer: ${text}`,
    fullContext,
    user.timezone
  );

  const newAiData = aiResult.data;
  await handleCreateIntent(user, chatId, newAiData, fullContext, session);
}

async function handleListIntent(user, chatId, aiData) {
  const filters = aiData.listFilters || {};
  const reminders = await reminderService.listReminders(user._id, {
    status: filters.status || "active",
    limit: filters.limit || 10,
    search: filters.search,
  });

  if (reminders.length === 0) {
    await sendMessage(chatId, "📭 You have no active reminders.\n\nCreate one: _'Remind me to...'_");
    return;
  }

  let msg = `📋 *Your Reminders* (${reminders.length})\n\n`;
  reminders.forEach((r, i) => {
    const time = new Date(r.scheduledAt).toLocaleString("en-US", {
      timeZone: user.timezone,
      dateStyle: "short",
      timeStyle: "short",
    });
    const recur = r.recurrence !== "none" ? ` 🔄` : "";
    const pri = r.priority === "high" ? " 🔴" : r.priority === "low" ? " 🟢" : " 🟡";
    msg += `${i + 1}. *${r.title}*${recur}${pri}\n   📅 ${time}\n\n`;
  });

  await sendMessage(chatId, msg);
}

async function handleDeleteIntent(user, chatId, aiData) {
  const target = aiData.deleteTarget;
  if (!target) {
    await sendMessage(chatId, "Which reminder would you like to delete? Please be more specific.");
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
    await sendMessage(chatId, `❌ Couldn't find that reminder. Use _"show my reminders"_ to see your list.`);
    return;
  }

  reminder.status = "deleted";
  await reminder.save();

  await sendMessage(chatId, `🗑️ Deleted: *${reminder.title}*`);
}

async function handleUpdateIntent(user, chatId, aiData) {
  await sendMessage(chatId, "To update a reminder, please visit the ReminderFlow app for full editing options, or delete and recreate it.");
}

async function handleSearchIntent(user, chatId, aiData) {
  const filters = aiData.listFilters || {};
  const reminders = await reminderService.listReminders(user._id, {
    search: filters.search || aiData.deleteTarget?.searchText,
    status: "active",
    limit: 10,
  });

  if (reminders.length === 0) {
    await sendMessage(chatId, `🔍 No reminders found matching your search.`);
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
      console.error("[Telegram] Unhandled error:", err);
    }
  });

  bot.on("polling_error", (err) => {
    console.error("[Telegram] Polling error:", err.message);
  });

  console.log("[Telegram] Message handlers set up");
}

// Send scheduled reminder alert
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
    `\n_Sent by ReminderFlow_ ✨`;

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
