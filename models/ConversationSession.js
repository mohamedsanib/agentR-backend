// models/ConversationSession.js
// Stores pending reminder creation sessions that need follow-up questions
const mongoose = require("mongoose");

const conversationSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Source channel
    source: {
      type: String,
      enum: ["webapp", "telegram"],
      default: "webapp",
    },
    // telegram chat id if from telegram
    telegramChatId: {
      type: String,
      default: null,
    },
    // Session state
    state: {
      type: String,
      enum: ["awaiting_title", "awaiting_datetime", "awaiting_recurrence", "awaiting_priority", "awaiting_confirmation", "complete", "cancelled"],
      default: "awaiting_datetime",
    },
    // Partial reminder data collected so far
    partialReminder: {
      title: { type: String, default: null },
      description: { type: String, default: null },
      scheduledAt: { type: Date, default: null },
      recurrence: { type: String, default: "none" },
      priority: { type: String, default: "medium" },
      notifyVia: { type: String, default: "both" },
      tags: [String],
      originalText: { type: String, default: "" },
    },
    // Full conversation history for context
    messages: [
      {
        role: { type: String, enum: ["user", "assistant"] },
        content: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    // Expires in 30 minutes of inactivity
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 60 * 1000),
      index: { expireAfterSeconds: 0 },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ConversationSession", conversationSessionSchema);
