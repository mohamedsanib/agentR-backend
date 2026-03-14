// utils/cronJobs.js
const cron = require("node-cron");
const reminderService = require("../services/reminderService");
const telegramService = require("../services/telegramService");

function startCronJobs() {
  console.log("[Cron] Starting cron jobs...");

  // Check for due reminders every minute
  cron.schedule("* * * * *", async () => {
    try {
      console.log(`[Cron] Checking due reminders at ${new Date().toISOString()}`);
      const dueReminders = await reminderService.getDueReminders();

      if (dueReminders.length > 0) {
        console.log(`[Cron] Found ${dueReminders.length} due reminders`);
      }

      for (const reminder of dueReminders) {
        const user = reminder.userId; // populated
        if (!user) continue;

        console.log(`[Cron] Processing reminder: ${reminder.title} for ${user.email}`);

        // Send via Telegram if connected and notifyVia includes telegram
        if ((reminder.notifyVia === "telegram" || reminder.notifyVia === "both") && user.telegramChatId) {
          const sent = await telegramService.sendReminderAlert(reminder, user);
          if (sent) {
            console.log(`[Cron] Telegram alert sent for: ${reminder.title}`);
          }
        }

        // Mark as sent/complete
        await reminderService.markReminderSent(reminder._id);
      }
    } catch (err) {
      console.error("[Cron] Error in reminder check:", err.message);
    }
  });

  // Clean up expired sessions every 5 minutes (TTL index handles this but just in case)
  cron.schedule("*/5 * * * *", async () => {
    try {
      const ConversationSession = require("../models/ConversationSession");
      const result = await ConversationSession.deleteMany({
        expiresAt: { $lt: new Date() },
      });
      if (result.deletedCount > 0) {
        console.log(`[Cron] Cleaned ${result.deletedCount} expired sessions`);
      }
    } catch (err) {
      console.error("[Cron] Session cleanup error:", err.message);
    }
  });

  console.log("[Cron] Jobs started: reminder check (1min), session cleanup (5min)");
}

module.exports = { startCronJobs };
