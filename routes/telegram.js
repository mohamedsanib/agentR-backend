// routes/telegram.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const authMiddleware = require("../middleware/auth");
const telegramService = require("../services/telegramService");

// POST /api/telegram/generate-code
router.post("/generate-code", authMiddleware, async (req, res) => {
  const user = req.user;
  console.log(`\n[Telegram/GenerateCode] User: ${user.email}`);

  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  user.telegramVerifyCode = code;
  user.telegramVerifyExpiry = expiry;
  await user.save();

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || "ReminderFlowBot";
  const deepLink = `https://t.me/${botUsername}?start=${code}`;

  console.log(`[Telegram/GenerateCode] Code=${code}`);
  res.json({ success: true, code, deepLink, botUsername, expiresAt: expiry });
});

// GET /api/telegram/status
router.get("/status", authMiddleware, async (req, res) => {
  const user = req.user;
  res.json({
    success: true,
    isConnected: user.isTelegramConnected,
    telegramUsername: user.telegramUsername,
    connectedAt: user.telegramConnectedAt,
  });
});

// DELETE /api/telegram/disconnect
router.delete("/disconnect", authMiddleware, async (req, res) => {
  const user = req.user;
  user.telegramChatId = null;
  user.telegramUsername = null;
  user.telegramConnectedAt = null;
  await user.save();
  console.log(`[Telegram/Disconnect] User: ${user.email}`);
  res.json({ success: true, message: "Telegram disconnected" });
});

// POST /api/telegram/webhook — called by Telegram for every message
// This is the SINGLE entry point for all incoming messages in production.
// The bot is initialized WITHOUT { webHook: true } so its internal listener
// is NOT running — this route is the only place messages are processed.
router.post("/webhook", express.json(), async (req, res) => {
  // Respond to Telegram immediately (must be within 5s or they retry)
  res.status(200).json({ ok: true });

  // Process the update asynchronously after responding
  const update = req.body;
  console.log(`[Telegram/Webhook] Update type: ${update.message ? "message" : update.edited_message ? "edited" : "other"}`);

  const msg = update.message || update.edited_message;
  if (!msg) return; // ignore non-message updates (inline queries etc.)

  try {
    await telegramService.handleIncomingMessage(msg);
  } catch (err) {
    console.error("[Telegram/Webhook] Error processing message:", err.message);
  }
});

module.exports = router;
