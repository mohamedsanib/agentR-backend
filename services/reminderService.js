// services/reminderService.js
const Reminder = require("../models/Reminder");

function computeNextTrigger(scheduledAt, recurrence) {
  if (recurrence === "none") return null;
  const base = new Date(scheduledAt);
  const now = new Date();

  let next = new Date(base);
  while (next <= now) {
    switch (recurrence) {
      case "daily":
        next.setDate(next.getDate() + 1);
        break;
      case "weekly":
        next.setDate(next.getDate() + 7);
        break;
      case "monthly":
        next.setMonth(next.getMonth() + 1);
        break;
      case "weekdays":
        next.setDate(next.getDate() + 1);
        while (next.getDay() === 0 || next.getDay() === 6) {
          next.setDate(next.getDate() + 1);
        }
        break;
      case "weekends":
        next.setDate(next.getDate() + 1);
        while (next.getDay() !== 0 && next.getDay() !== 6) {
          next.setDate(next.getDate() + 1);
        }
        break;
      default:
        return null;
    }
  }
  return next;
}

async function createReminder(userId, reminderData, source = "webapp") {
  console.log(`[ReminderService] Creating reminder for userId=${userId}:`, reminderData);

  const scheduledAt = new Date(reminderData.scheduledAt);
  const nextTriggerAt = reminderData.recurrence !== "none" ? computeNextTrigger(scheduledAt, reminderData.recurrence) : null;

  const reminder = await Reminder.create({
    userId,
    title: reminderData.title,
    description: reminderData.description || "",
    scheduledAt,
    recurrence: reminderData.recurrence || "none",
    priority: reminderData.priority || "medium",
    notifyVia: reminderData.notifyVia || "both",
    tags: reminderData.tags || [],
    originalText: reminderData.originalText || "",
    source,
    status: "active",
    nextTriggerAt,
  });

  console.log(`[ReminderService] Reminder created: id=${reminder._id}`);
  return reminder;
}

async function listReminders(userId, filters = {}) {
  const query = { userId, status: filters.status === "all" ? { $ne: "deleted" } : filters.status || "active" };

  if (filters.search) {
    query.$or = [
      { title: { $regex: filters.search, $options: "i" } },
      { description: { $regex: filters.search, $options: "i" } },
      { tags: { $in: [new RegExp(filters.search, "i")] } },
    ];
  }

  const reminders = await Reminder.find(query).sort({ scheduledAt: 1 }).limit(filters.limit || 50).lean();

  console.log(`[ReminderService] Listed ${reminders.length} reminders for userId=${userId}`);
  return reminders;
}

async function getReminder(reminderId, userId) {
  return await Reminder.findOne({ _id: reminderId, userId }).lean();
}

async function updateReminder(reminderId, userId, updates) {
  console.log(`[ReminderService] Updating reminder ${reminderId}:`, updates);

  if (updates.scheduledAt && updates.recurrence) {
    updates.nextTriggerAt = computeNextTrigger(updates.scheduledAt, updates.recurrence);
  }

  const reminder = await Reminder.findOneAndUpdate({ _id: reminderId, userId }, { $set: updates }, { new: true });
  console.log(`[ReminderService] Updated reminder: ${reminder?._id}`);
  return reminder;
}

async function deleteReminder(reminderId, userId) {
  console.log(`[ReminderService] Soft-deleting reminder ${reminderId}`);
  const reminder = await Reminder.findOneAndUpdate({ _id: reminderId, userId }, { $set: { status: "deleted" } }, { new: true });
  return reminder;
}

async function getDueReminders() {
  const now = new Date();
  const fiveMinAgo = new Date(now - 5 * 60 * 1000);

  return await Reminder.find({
    status: "active",
    scheduledAt: { $gte: fiveMinAgo, $lte: now },
    telegramSent: false,
  }).populate("userId");
}

async function markReminderSent(reminderId) {
  const reminder = await Reminder.findById(reminderId);
  if (!reminder) return;

  reminder.telegramSent = true;
  reminder.lastTriggeredAt = new Date();

  if (reminder.recurrence !== "none") {
    // Schedule next occurrence
    const next = computeNextTrigger(reminder.scheduledAt, reminder.recurrence);
    if (next) {
      // Create new reminder for next occurrence
      await Reminder.create({
        userId: reminder.userId,
        title: reminder.title,
        description: reminder.description,
        scheduledAt: next,
        recurrence: reminder.recurrence,
        priority: reminder.priority,
        notifyVia: reminder.notifyVia,
        tags: reminder.tags,
        originalText: reminder.originalText,
        source: reminder.source,
        status: "active",
        telegramSent: false,
      });
    }
    // Mark original as completed
    reminder.status = "completed";
  } else {
    reminder.status = "completed";
  }

  await reminder.save();
}

module.exports = {
  createReminder,
  listReminders,
  getReminder,
  updateReminder,
  deleteReminder,
  getDueReminders,
  markReminderSent,
};
