// routes/telegram.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const authMiddleware = require("../middleware/auth");
const telegramService = require("../services/telegramService");

// POST /api/telegram/generate-code - Generate verification code
router.post("/generate-code", authMiddleware, async (req, res) => {
  const user = req.user;
  console.log(`\n[Telegram/GenerateCode] User: ${user.email}`);

  // Generate 6-char alphanumeric code
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  user.telegramVerifyCode = code;
  user.telegramVerifyExpiry = expiry;
  await user.save();

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || "ReminderFlowBot";
  const deepLink = `https://t.me/${botUsername}?start=${code}`;

  console.log(`[Telegram/GenerateCode] Code=${code}, Expiry=${expiry}`);

  res.json({
    success: true,
    code,
    deepLink,
    botUsername,
    expiresAt: expiry,
  });
});

// GET /api/telegram/status - Check connection status
router.get("/status", authMiddleware, async (req, res) => {
  const user = req.user;
  console.log(`[Telegram/Status] User: ${user.email}, Connected: ${user.isTelegramConnected}`);

  res.json({
    success: true,
    isConnected: user.isTelegramConnected,
    telegramUsername: user.telegramUsername,
    connectedAt: user.telegramConnectedAt,
  });
});

// DELETE /api/telegram/disconnect - Disconnect telegram
router.delete("/disconnect", authMiddleware, async (req, res) => {
  const user = req.user;
  console.log(`[Telegram/Disconnect] User: ${user.email}`);

  user.telegramChatId = null;
  user.telegramUsername = null;
  user.telegramConnectedAt = null;
  await user.save();

  res.json({ success: true, message: "Telegram disconnected" });
});

// POST /api/telegram/webhook - Receive messages from Telegram (production)
router.post("/webhook", express.json(), async (req, res) => {
  console.log(`[Telegram/Webhook] Received:`, JSON.stringify(req.body).substring(0, 200));

  const bot = telegramService.getBot();
  if (bot) {
    try {
      await telegramService.handleIncomingMessage(req.body.message || req.body.edited_message);
    } catch (err) {
      console.error("[Telegram/Webhook] Error:", err);
    }
  }

  // Always respond 200 to Telegram quickly
  res.status(200).json({ ok: true });
});

// POST /api/telegram/set-webhook - Set webhook URL (for deployment)
router.post("/set-webhook", authMiddleware, async (req, res) => {
  const bot = telegramService.getBot();
  if (!bot) return res.status(503).json({ success: false, message: "Bot not initialized" });

  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  try {
    await bot.setWebHook(webhookUrl);
    console.log(`[Telegram/SetWebhook] Set to: ${webhookUrl}`);
    res.json({ success: true, webhookUrl });
  } catch (err) {
    console.error("[Telegram/SetWebhook] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
