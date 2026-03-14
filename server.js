// server.js
require("node:dns/promises").setServers(["1.1.1.1", "8.8.8.8"]);
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const reminderRoutes = require("./routes/reminders");
const telegramRoutes = require("./routes/telegram");
const telegramService = require("./services/telegramService");
const { startCronJobs } = require("./utils/cronJobs");

const app = express();
const PORT = process.env.PORT || 5000;

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [process.env.FRONTEND_URL || "http://localhost:5173", "http://localhost:5174", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── REQUEST LOGGER ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/telegram", telegramRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// 404 handler
app.use((req, res) => {
  console.log(`[HTTP] 404: ${req.method} ${req.path}`);
  res.status(404).json({ success: false, message: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("[HTTP] Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ─── DB + START ───────────────────────────────────────────────────────────────
async function start() {
  try {
    console.log(`[Server] Connecting to MongoDB...`);
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/reminderflow");
    console.log(`[Server] MongoDB connected`);

    // Init Telegram bot
    telegramService.initBot();
    if (process.env.NODE_ENV !== "production") {
      telegramService.setupMessageHandlers();
    }

    // Start cron jobs
    startCronJobs();

    app.listen(PORT, () => {
      console.log(`\n[Server] ✅ ReminderFlow backend running on port ${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`[Server] Frontend URL: ${process.env.FRONTEND_URL}`);
      console.log(`[Server] OpenRouter model: ${process.env.OPENROUTER_MODEL}`);
    });
  } catch (err) {
    console.error("[Server] Startup error:", err);
    process.exit(1);
  }
}

start();

module.exports = app;
