// routes/auth.js
const express = require("express");
const router = express.Router();
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// POST /api/auth/google - Verify Google token and login/register
router.post("/google", async (req, res) => {
  const { credential } = req.body;
  console.log(`\n[Auth/Google] Login attempt received`);

  if (!credential) {
    return res.status(400).json({ success: false, message: "No credential provided" });
  }

  try {
    // Verify Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    console.log(`[Auth/Google] Google verified: ${payload.email}`);

    const { sub: googleId, email, name, picture } = payload;

    // Find or create user
    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.create({
        googleId,
        email,
        name,
        avatar: picture,
      });
      console.log(`[Auth/Google] New user created: ${email}`);
    } else {
      // Update profile info
      user.name = name;
      user.avatar = picture;
      await user.save();
      console.log(`[Auth/Google] Existing user logged in: ${email}`);
    }

    // Generate JWT
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });

    console.log(`[Auth/Google] JWT issued for ${email}`);

    return res.json({
      success: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        isTelegramConnected: user.isTelegramConnected,
        telegramUsername: user.telegramUsername,
        timezone: user.timezone,
      },
    });
  } catch (err) {
    console.error(`[Auth/Google] Error:`, err.message);
    return res.status(401).json({ success: false, message: "Invalid Google credential" });
  }
});

// GET /api/auth/me - Get current user
router.get("/me", authMiddleware, async (req, res) => {
  console.log(`[Auth/Me] Getting profile for ${req.user.email}`);
  res.json({
    success: true,
    user: {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      avatar: req.user.avatar,
      isTelegramConnected: req.user.isTelegramConnected,
      telegramUsername: req.user.telegramUsername,
      telegramConnectedAt: req.user.telegramConnectedAt,
      timezone: req.user.timezone,
    },
  });
});

// DELETE /api/auth/account - Delete account
router.delete("/account", authMiddleware, async (req, res) => {
  console.log(`[Auth/Delete] Account deletion requested for ${req.user.email}`);

  const Reminder = require("../models/Reminder");
  const ConversationSession = require("../models/ConversationSession");

  await Reminder.deleteMany({ userId: req.user._id });
  await ConversationSession.deleteMany({ userId: req.user._id });
  await User.findByIdAndDelete(req.user._id);

  console.log(`[Auth/Delete] Account deleted: ${req.user.email}`);
  res.json({ success: true, message: "Account deleted successfully" });
});

// PUT /api/auth/timezone - Update timezone
router.put("/timezone", authMiddleware, async (req, res) => {
  const { timezone } = req.body;
  req.user.timezone = timezone;
  await req.user.save();
  console.log(`[Auth/Timezone] Updated to ${timezone} for ${req.user.email}`);
  res.json({ success: true, timezone });
});

module.exports = router;
