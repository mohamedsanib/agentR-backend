// models/User.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    googleId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: true,
    },
    avatar: {
      type: String,
      default: null,
    },
    telegramChatId: {
      type: String,
      default: null,
    },
    telegramUsername: {
      type: String,
      default: null,
    },
    telegramConnectedAt: {
      type: Date,
      default: null,
    },
    // Pending verification code for telegram linking
    telegramVerifyCode: {
      type: String,
      default: null,
    },
    telegramVerifyExpiry: {
      type: Date,
      default: null,
    },
    timezone: {
      type: String,
      default: "Asia/Kolkata",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Virtual: is telegram connected
userSchema.virtual("isTelegramConnected").get(function () {
  return !!this.telegramChatId;
});

userSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("User", userSchema);
