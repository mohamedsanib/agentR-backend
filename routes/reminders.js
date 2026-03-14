// routes/reminders.js
const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const aiService = require("../services/aiService");
const reminderService = require("../services/reminderService");
const ConversationSession = require("../models/ConversationSession");

// POST /api/reminders/process - Process natural language input
router.post("/process", authMiddleware, async (req, res) => {
  const { message, sessionId } = req.body;
  const user = req.user;

  console.log(`\n[Reminders/Process] User: ${user.email}, Message: "${message}"`);

  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: "Message is required" });
  }

  try {
    // Check for active session
    let session = null;
    if (sessionId) {
      session = await ConversationSession.findOne({ _id: sessionId, userId: user._id });
    }
    if (!session) {
      session = await ConversationSession.findOne({
        userId: user._id,
        source: "webapp",
        state: { $nin: ["complete", "cancelled"] },
      });
    }

    const history = session?.messages || [];

    // Process with AI
    const aiResult = await aiService.processMessage(message, history, user.timezone);
    const aiData = aiResult.data;

    console.log(`[Reminders/Process] AI intent: ${aiData.intent}, needsFollowUp: ${aiData.needsFollowUp}`);

    // Update history
    const updatedHistory = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: aiData.userMessage },
    ];

    let responseData = {
      success: true,
      intent: aiData.intent,
      needsFollowUp: aiData.needsFollowUp,
      followUpQuestion: aiData.followUpQuestion,
      followUpField: aiData.followUpField,
      userMessage: aiData.userMessage,
      sessionId: session?._id || null,
      reminder: null,
      reminders: null,
    };

    switch (aiData.intent) {
      case "CREATE": {
        if (aiData.needsFollowUp) {
          // Save session for follow-up
          const sessionData = {
            userId: user._id,
            source: "webapp",
            state: `awaiting_${aiData.followUpField || "datetime"}`,
            partialReminder: {
              ...((session?.partialReminder || {})),
              ...(aiData.reminderData || {}),
              originalText: message,
            },
            messages: updatedHistory,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          };

          let savedSession;
          if (session) {
            savedSession = await ConversationSession.findByIdAndUpdate(session._id, sessionData, { new: true });
          } else {
            savedSession = await ConversationSession.create(sessionData);
          }

          responseData.sessionId = savedSession._id;
        } else {
          // Create reminder
          const reminderData = {
            ...((session?.partialReminder || {})),
            ...(aiData.reminderData || {}),
            originalText: message,
          };

          const created = await reminderService.createReminder(user._id, reminderData, "webapp");
          responseData.reminder = created;

          // Clear session
          if (session) {
            await ConversationSession.findByIdAndUpdate(session._id, { state: "complete" });
          }
        }
        break;
      }

      case "LIST": {
        const filters = aiData.listFilters || {};
        const reminders = await reminderService.listReminders(user._id, {
          status: filters.status || "active",
          limit: filters.limit || 20,
          search: filters.search,
        });
        responseData.reminders = reminders;
        responseData.userMessage = `Found ${reminders.length} reminder${reminders.length !== 1 ? "s" : ""}.`;
        break;
      }

      case "SEARCH": {
        const filters = aiData.listFilters || {};
        const reminders = await reminderService.listReminders(user._id, {
          search: filters.search || aiData.deleteTarget?.searchText,
          status: "active",
          limit: 20,
        });
        responseData.reminders = reminders;
        break;
      }

      case "DELETE": {
        const target = aiData.deleteTarget;
        if (target?.reminderId) {
          const deleted = await reminderService.deleteReminder(target.reminderId, user._id);
          responseData.reminder = deleted;
          responseData.userMessage = deleted ? `Deleted: "${deleted.title}"` : "Reminder not found.";
        } else if (target?.searchText) {
          const { Reminder } = require("../models/Reminder");
          const found = await reminderService.listReminders(user._id, { search: target.searchText, limit: 5 });
          if (found.length === 1) {
            const deleted = await reminderService.deleteReminder(found[0]._id, user._id);
            responseData.reminder = deleted;
          } else if (found.length > 1) {
            responseData.reminders = found;
            responseData.userMessage = "Multiple reminders found. Please select which one to delete:";
            responseData.needsFollowUp = true;
          } else {
            responseData.userMessage = "No reminders found matching that description.";
          }
        }
        break;
      }

      case "ANSWER": {
        // Re-process with accumulated context
        if (session) {
          const contextualMessage = `CONTINUING: Partial reminder data so far: ${JSON.stringify(session.partialReminder)}. User answer to "${session.state}": ${message}`;
          const reResult = await aiService.processMessage(contextualMessage, updatedHistory, user.timezone);
          const reData = reResult.data;

          if (!reData.needsFollowUp && reData.reminderData?.scheduledAt && reData.reminderData?.title) {
            const mergedData = { ...(session.partialReminder || {}), ...(reData.reminderData || {}), originalText: session.partialReminder?.originalText || message };
            const created = await reminderService.createReminder(user._id, mergedData, "webapp");
            responseData.reminder = created;
            responseData.intent = "CREATE";
            responseData.needsFollowUp = false;
            responseData.userMessage = reData.userMessage;
            await ConversationSession.findByIdAndUpdate(session._id, { state: "complete" });
          } else {
            // Still needs more info
            const merged = { ...(session.partialReminder || {}), ...(reData.reminderData || {}) };
            await ConversationSession.findByIdAndUpdate(session._id, {
              partialReminder: merged,
              messages: updatedHistory,
              state: `awaiting_${reData.followUpField || "datetime"}`,
              expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            });
            responseData = { ...responseData, ...reData, sessionId: session._id };
          }
        }
        break;
      }

      case "IRRELEVANT":
      default:
        // Clear any stale sessions
        if (session) {
          await ConversationSession.findByIdAndUpdate(session._id, { state: "cancelled" });
        }
        break;
    }

    console.log(`[Reminders/Process] Response: intent=${responseData.intent}, reminder=${responseData.reminder?._id || "none"}`);
    return res.json(responseData);
  } catch (err) {
    console.error("[Reminders/Process] Error:", err);
    return res.status(500).json({ success: false, message: "Processing failed", error: err.message });
  }
});

// GET /api/reminders - List all reminders
router.get("/", authMiddleware, async (req, res) => {
  const { status, search, limit, page } = req.query;
  console.log(`[Reminders/List] User: ${req.user.email}, filters:`, { status, search, limit });

  try {
    const reminders = await reminderService.listReminders(req.user._id, {
      status: status || "active",
      search,
      limit: parseInt(limit) || 50,
    });
    res.json({ success: true, reminders, count: reminders.length });
  } catch (err) {
    console.error("[Reminders/List] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/reminders - Create reminder manually
router.post("/", authMiddleware, async (req, res) => {
  console.log(`[Reminders/Create] User: ${req.user.email}`, req.body);
  try {
    const reminder = await reminderService.createReminder(req.user._id, req.body, "webapp");
    res.status(201).json({ success: true, reminder });
  } catch (err) {
    console.error("[Reminders/Create] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/reminders/:id - Get single reminder
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const reminder = await reminderService.getReminder(req.params.id, req.user._id);
    if (!reminder) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, reminder });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/reminders/:id - Update reminder
router.put("/:id", authMiddleware, async (req, res) => {
  console.log(`[Reminders/Update] id=${req.params.id}`, req.body);
  try {
    const reminder = await reminderService.updateReminder(req.params.id, req.user._id, req.body);
    if (!reminder) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, reminder });
  } catch (err) {
    console.error("[Reminders/Update] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/reminders/:id - Delete reminder
router.delete("/:id", authMiddleware, async (req, res) => {
  console.log(`[Reminders/Delete] id=${req.params.id}`);
  try {
    const reminder = await reminderService.deleteReminder(req.params.id, req.user._id);
    if (!reminder) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, message: "Deleted", reminder });
  } catch (err) {
    console.error("[Reminders/Delete] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
