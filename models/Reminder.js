// models/Reminder.js
const mongoose = require("mongoose");

const reminderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    description: {
      type: String,
      default: "",
      maxlength: 1000,
    },
    // When to fire: exact datetime
    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },
    // Recurrence: none | daily | weekly | monthly | custom
    recurrence: {
      type: String,
      enum: ["none", "daily", "weekly", "monthly", "weekdays", "weekends"],
      default: "none",
    },
    // For custom recurrence - cron expression
    cronExpression: {
      type: String,
      default: null,
    },
    // Status
    status: {
      type: String,
      enum: ["active", "completed", "paused", "deleted"],
      default: "active",
      index: true,
    },
    // Channel: webapp | telegram | both
    notifyVia: {
      type: String,
      enum: ["webapp", "telegram", "both"],
      default: "both",
    },
    // Source: webapp (created from UI) | telegram (created from bot)
    source: {
      type: String,
      enum: ["webapp", "telegram"],
      default: "webapp",
    },
    // Last time this reminder was triggered
    lastTriggeredAt: {
      type: Date,
      default: null,
    },
    // For recurring: next scheduled trigger
    nextTriggerAt: {
      type: Date,
      default: null,
    },
    // Priority: low | medium | high
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    // Tags for grouping
    tags: [
      {
        type: String,
        lowercase: true,
        trim: true,
      },
    ],
    // Original raw text from user
    originalText: {
      type: String,
      default: "",
    },
    // Has been sent successfully via telegram
    telegramSent: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient querying
reminderSchema.index({ userId: 1, status: 1, scheduledAt: 1 });
reminderSchema.index({ status: 1, scheduledAt: 1 }); // For cron job

module.exports = mongoose.model("Reminder", reminderSchema);
