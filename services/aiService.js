// services/aiService.js
const axios = require("axios");

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// ─── MODEL POOL ───────────────────────────────────────────────────────────────
// Spread across different providers/families to avoid all hitting same rate limit.
// OpenRouter "models" array = max 3. We group into batches of 3 and try each batch.
const MODEL_POOL = [
  // Primary choices — low cost, high availability
  "nvidia/nemotron-3-super-120b-a12b:free",   // Nvidia — very low rate limits
  "openrouter/hunter-alpha",                   // OpenRouter's own model
  "deepseek/deepseek-chat-v3-0324:free",       // DeepSeek — different provider
  "mistralai/mistral-small-3.1-24b-instruct:free", // Mistral
  "meta-llama/llama-3.3-70b-instruct:free",    // Meta / Venice
  "google/gemma-3-12b-it:free",                // Google
  "qwen/qwen-2.5-7b-instruct:free",            // Alibaba
  "meta-llama/llama-3.2-3b-instruct:free",     // Llama small (last resort)
];

// Split pool into batches of 3 (OpenRouter max)
function getBatches(primaryModel) {
  const pool = [primaryModel, ...MODEL_POOL.filter(m => m !== primaryModel)];
  const batches = [];
  for (let i = 0; i < pool.length; i += 3) {
    batches.push(pool.slice(i, i + 3));
  }
  return batches;
}

// Simple delay helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const REMINDER_SYSTEM_PROMPT = `You are ReminderFlow AI, a smart reminder and alert assistant. Your job is to parse user messages and extract reminder/alert information OR manage existing reminders.

CURRENT DATE/TIME: {{CURRENT_DATETIME}}
USER TIMEZONE: {{USER_TIMEZONE}}

## YOUR CAPABILITIES
- Create reminders/alerts from natural language
- List, search, update, delete reminders
- Answer follow-up questions to complete missing reminder info
- Handle recurring reminders (daily, weekly, monthly, weekdays, weekends)

## INTENT TYPES
- CREATE: User wants to create a new reminder or alert
- LIST: User wants to see their reminders
- DELETE: User wants to delete reminder(s)
- UPDATE: User wants to modify a reminder
- SEARCH: User wants to find specific reminders
- ANSWER: User is answering a follow-up question (providing missing info)
- IRRELEVANT: Message has nothing to do with reminders/tasks/alerts

## REQUIRED REMINDER FIELDS
- title: What the reminder is about (required)
- scheduledAt: When to trigger, as ISO 8601 UTC datetime (required)
- recurrence: "none" | "daily" | "weekly" | "monthly" | "weekdays" | "weekends" (default: "none")
- priority: "low" | "medium" | "high" (default: "medium")
- notifyVia: "webapp" | "telegram" | "both" (default: "both")

## MISSING FIELD QUESTIONS
If any REQUIRED field is missing, set needsFollowUp=true and ask ONE question at a time:
1. If title is unclear: "What would you like to be reminded about?"
2. If scheduledAt is missing: "When should I remind you? (e.g., tomorrow 9am, Friday 3pm, every day at 8am)"
3. Never ask about priority or notifyVia - use defaults

## DATETIME PARSING RULES
- Convert all times to UTC ISO 8601 format
- "tomorrow" = next calendar day
- "tonight" = today at 9PM local time
- "morning" = 9AM, "afternoon" = 2PM, "evening" = 6PM, "night" = 9PM
- "in X hours/minutes" = relative from current time
- If only time given (e.g. "at 9am") = today at that time, or tomorrow if already passed
- For recurring: scheduledAt = first occurrence

## RESPONSE FORMAT
You MUST respond with ONLY a valid JSON object. No markdown, no backticks, no explanation outside JSON.

JSON Schema:
{"intent":"CREATE|LIST|DELETE|UPDATE|SEARCH|ANSWER|IRRELEVANT","needsFollowUp":true|false,"followUpQuestion":"string or null","followUpField":"title|scheduledAt|recurrence|null","confidence":0.0-1.0,"reminderData":{"title":"string","description":"string","scheduledAt":"ISO8601 UTC or null","recurrence":"none|daily|weekly|monthly|weekdays|weekends","priority":"low|medium|high","notifyVia":"webapp|telegram|both","tags":[]},"listFilters":{"search":"string or null","status":"active|completed|all","limit":10},"deleteTarget":{"reminderId":"string or null","searchText":"string or null"},"updateTarget":{"reminderId":"string or null","searchText":"string or null","changes":{}},"userMessage":"Friendly message to user","irrelevantResponse":"string or null"}

## EXAMPLES

User: "remind me for job at 9:00 am"
Response: {"intent":"CREATE","needsFollowUp":false,"followUpQuestion":null,"followUpField":null,"confidence":0.95,"reminderData":{"title":"Job reminder","description":"","scheduledAt":"2024-01-15T03:30:00Z","recurrence":"none","priority":"medium","notifyVia":"both","tags":["work"]},"listFilters":null,"deleteTarget":null,"updateTarget":null,"userMessage":"Done! I'll remind you for your job at 9:00 AM. ✅","irrelevantResponse":null}

User: "remind me to drink water every day at 8am"
Response: {"intent":"CREATE","needsFollowUp":false,"followUpQuestion":null,"followUpField":null,"confidence":0.98,"reminderData":{"title":"Drink water","description":"Daily water reminder","scheduledAt":"2024-01-15T02:30:00Z","recurrence":"daily","priority":"medium","notifyVia":"both","tags":["health"]},"listFilters":null,"deleteTarget":null,"updateTarget":null,"userMessage":"Got it! I will remind you to drink water every day at 8:00 AM. ✅","irrelevantResponse":null}

User: "set a reminder"
Response: {"intent":"CREATE","needsFollowUp":true,"followUpQuestion":"What would you like to be reminded about?","followUpField":"title","confidence":0.9,"reminderData":{"title":null,"description":"","scheduledAt":null,"recurrence":"none","priority":"medium","notifyVia":"both","tags":[]},"listFilters":null,"deleteTarget":null,"updateTarget":null,"userMessage":"What would you like to be reminded about?","irrelevantResponse":null}

User: "show my reminders"
Response: {"intent":"LIST","needsFollowUp":false,"followUpQuestion":null,"followUpField":null,"confidence":0.99,"reminderData":null,"listFilters":{"search":null,"status":"active","limit":10},"deleteTarget":null,"updateTarget":null,"userMessage":"Here are your active reminders:","irrelevantResponse":null}

User: "what is the capital of France"
Response: {"intent":"IRRELEVANT","needsFollowUp":false,"followUpQuestion":null,"followUpField":null,"confidence":0.99,"reminderData":null,"listFilters":null,"deleteTarget":null,"updateTarget":null,"userMessage":"I can only help with reminders and alerts. Try: remind me to call mom tomorrow at 5pm","irrelevantResponse":"I only handle reminders."}`;

// ─── AI SERVICE ──────────────────────────────────────────────────────────────
class AIService {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.primaryModel = process.env.OPENROUTER_MODEL || MODEL_POOL[0];
    this.baseURL = OPENROUTER_BASE_URL;
  }

  buildSystemPrompt(userTimezone = "Asia/Kolkata") {
    const now = new Date().toLocaleString("en-US", {
      timeZone: userTimezone,
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
    });
    return REMINDER_SYSTEM_PROMPT
      .replace("{{CURRENT_DATETIME}}", now)
      .replace("{{USER_TIMEZONE}}", userTimezone);
  }

  async callOpenRouter(models, messages) {
    const requestBody = {
      model: models[0],           // primary for this batch
      models: models,             // OpenRouter native fallback (max 3)
      max_tokens: 1000,
      temperature: 0.1,
      messages,
    };

    console.log(`[AI Service] Trying batch:`, models);

    const response = await axios.post(
      `${this.baseURL}/chat/completions`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://reminderflow.app",
          "X-Title": "ReminderFlow",
        },
        timeout: 30000,
      }
    );

    return response;
  }

  async processMessage(userMessage, conversationHistory = [], userTimezone = "Asia/Kolkata") {
    console.log(`\n[AI Service] Processing: "${userMessage}"`);
    console.log(`[AI Service] Primary model: ${this.primaryModel}`);

    const systemPrompt = this.buildSystemPrompt(userTimezone);

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];

    // Get batches of 3 models each, starting with primary
    const batches = getBatches(this.primaryModel);
    console.log(`[AI Service] Total batches to try: ${batches.length}`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        const response = await this.callOpenRouter(batch, messages);
        const modelUsed = response.data.model || batch[0];

        console.log(`[AI Service] ✅ Success — batch ${i + 1}, model used: ${modelUsed}`);
        console.log(`[AI Service] Usage:`, response.data.usage);

        const rawContent = response.data.choices[0]?.message?.content || "";
        console.log(`[AI Service] Raw response: ${rawContent}`);

        const parsed = this.parseAIResponse(rawContent);
        console.log(`[AI Service] Parsed:`, JSON.stringify(parsed, null, 2));

        return { success: true, data: parsed, rawResponse: rawContent, modelUsed };

      } catch (error) {
        const status = error.response?.status;
        const errMsg = error.response?.data?.error?.message || error.message;
        console.error(`[AI Service] ❌ Batch ${i + 1} failed (${status}): ${errMsg}`);

        // Hard stop — bad API key, no point retrying
        if (status === 401) {
          console.error(`[AI Service] Invalid API key — stopping all retries`);
          break;
        }

        // Rate limited (429) or unavailable (503/404) — wait briefly then try next batch
        if (i < batches.length - 1) {
          const delay = status === 429 ? 2000 : 500;
          console.log(`[AI Service] Waiting ${delay}ms before next batch...`);
          await sleep(delay);
          continue;
        }
      }
    }

    // All batches exhausted
    console.error(`[AI Service] All model batches failed`);
    return {
      success: false,
      error: "All AI models are currently rate-limited. Please try again in a moment.",
      data: this.getFallbackResponse(),
    };
  }

  parseAIResponse(rawContent) {
    try {
      let cleaned = rawContent.trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "");

      const jsonStart = cleaned.indexOf("{");
      const jsonEnd = cleaned.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON found");

      const parsed = JSON.parse(cleaned.substring(jsonStart, jsonEnd + 1));

      if (!parsed.intent) parsed.intent = "IRRELEVANT";
      if (parsed.needsFollowUp === undefined) parsed.needsFollowUp = false;
      if (!parsed.confidence) parsed.confidence = 0.5;
      if (!parsed.userMessage) parsed.userMessage = "Done!";

      return parsed;
    } catch (err) {
      console.error(`[AI Service] JSON parse failed: ${err.message}`);
      console.error(`[AI Service] Raw content:`, rawContent);
      return this.getFallbackResponse();
    }
  }

  getFallbackResponse() {
    return {
      intent: "IRRELEVANT",
      needsFollowUp: false,
      followUpQuestion: null,
      followUpField: null,
      confidence: 0.1,
      reminderData: null,
      listFilters: null,
      deleteTarget: null,
      updateTarget: null,
      userMessage: "⚠️ AI is temporarily busy (rate limited). Please wait a few seconds and try again.",
      irrelevantResponse: null,
    };
  }
}

module.exports = new AIService();