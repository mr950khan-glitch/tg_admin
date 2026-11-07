
const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY;
const SECRET = process.env.WEBHOOK_SECRET;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;
const DB_PATH = process.env.DB_PATH || "./bot.db";

if (!TOKEN || !ADMIN_KEY || !SECRET) {
  throw new Error(
    "BOT_TOKEN, ADMIN_KEY and WEBHOOK_SECRET are required"
  );
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(SECRET)) {
  throw new Error("Invalid WEBHOOK_SECRET");
}

// Database setup
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), {
  recursive: true
});

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  chat_id TEXT UNIQUE,
  first_name TEXT,
  username TEXT,
  last_name TEXT,
  user_ref TEXT DEFAULT '',
  step INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  direction TEXT,
  message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Migrate old database
function addColumn(table, column, definition) {
  const columns = db.prepare(
    `PRAGMA table_info(${table})`
  ).all();

  if (!columns.some(c => c.name === column)) {
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );
  }
}

addColumn("users", "step", "INTEGER DEFAULT 0");
addColumn("users", "user_ref", "TEXT DEFAULT ''");

// Telegram API
async function telegram(method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(20000)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || "Telegram API error"
    );
  }

  return result.result;
}

// Save message
function saveMessage(chatId, direction, message) {
  db.prepare(`
    INSERT INTO messages (chat_id, direction, message)
    VALUES (?, ?, ?)
  `).run(String(chatId), direction, message);
}

// Send user message
async function sendUser(chatId, message) {
  return telegram("sendMessage", {
    chat_id: String(chatId),
    text: message
  });
}

// Telegram update handler
async function handleUpdate(update) {
  const msg = update.message;

  if (
    !msg ||
    !msg.from ||
    !msg.chat ||
    msg.chat.type !== "private"
  ) return;

  const chatId = String(msg.chat.id);
  const user = msg.from;
  const text = (msg.text || "").trim();

  // Save / update user
  db.prepare(`
    INSERT INTO users (
      chat_id,
      first_name,
      username,
      last_name,
      last_seen
    )
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)

    ON CONFLICT(chat_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      last_name = excluded.last_name,
      last_seen = CURRENT_TIMESTAMP
  `).run(
    chatId,
    user.first_name || "",
    user.username || "",
    user.last_name || ""
  );

  const record = db.prepare(`
    SELECT * FROM users WHERE chat_id = ?
  `).get(chatId);

  // Check ban
  if (record.banned) {
    await sendUser(
      chatId,
      "আপনি বর্তমানে বট থেকে ব্লক করা আছেন।"
    );
    return;
  }

  // Detect message type
  let userMessage = text;

  if (msg.photo) {
    userMessage = "[Photo received]";
  } else if (msg.document) {
    userMessage = "[Document received]";
  } else if (msg.voice) {
    userMessage = "[Voice message received]";
  } else if (msg.video) {
    userMessage = "[Video received]";
  } else if (msg.sticker) {
    userMessage = "[Sticker received]";
  } else if (msg.audio) {
    userMessage = "[Audio received]";
  } else if (!userMessage) {
    userMessage = "[Unsupported message type]";
  }

  // Save incoming message
  saveMessage(chatId, "user", userMessage);

  // STEP 1: Welcome message
  if (text === "/start") {

    db.prepare(`
      UPDATE users SET
        step = 1,
        user_ref = ''
      WHERE chat_id = ?
    `).run(chatId);

    await sendUser(
      chatId,
      "99xo স্বাগতম! ❤️\n\n" +
      "আপনাকে কীভাবে সাহায্য করতে পারি?\n\n" +
      "_____\n" +
      "জয়েন করুন..\n" +
      "https://t.me/vip99xo\n\n" +
      "রেজিষ্ট্রেশন লিংক:\n" +
      "https://www.99xo.pro/?dl=5sjysv"
    );

    return;
  }

  // STEP 2: Ask username / ID
  if (record.step === 1) {

    db.prepare(`
      UPDATE users SET step = 2
      WHERE chat_id = ?
    `).run(chatId);

    await sendUser(
      chatId,
      "অনুগ্রহ করে আপনার ইউজার নেম অথবা ID দিন।"
    );

    return;
  }

  // STEP 3: Receive username / ID
  if (record.step === 2) {

    if (!text || text.startsWith("/")) {
      await sendUser(
        chatId,
        "---।"
      );
      return;
    }

    db.prepare(`
      UPDATE users SET
        user_ref = ?,
        step = 3
      WHERE chat_id = ?
    `).run(text, chatId);

    await sendUser(
      chatId,
      "অনুগ্রহ করে অপেক্ষা করুন।\n\n" +
      "একজন এজেন্ট আপনার সমস্যা সমাধান করবে। ❤️"
    );

    return;
  }

  // STEP 4: Waiting for agent
  await sendUser(
    chatId,
    "আপনার মেসেজটি আমরা পেয়েছি।\n\n" +
    "অনুগ্রহ করে অপেক্ষা করুন। একজন এজেন্ট আপনাকে সাহায্য করবেন।"
  );
}

// Admin authentication
function adminAuth(req, res, next) {
  const supplied = req.get("x-admin-key") || "";

  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_KEY);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

// Telegram webhook
app.post("/telegram/:secret", async (req, res) => {

  if (
    req.params.secret !== SECRET ||
    req.get("x-telegram-bot-api-secret-token") !== SECRET
  ) {
    return res.sendStatus(403);
  }

  // Acknowledge Telegram quickly
  res.sendStatus(200);

  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error(
      "Telegram update error:",
      err.message
    );
  }
});

// Admin: all users
app.get("/api/users", adminAuth, (req, res) => {

  const users = db.prepare(`
    SELECT
      u.*,
      (
        SELECT message
        FROM messages m
        WHERE m.chat_id = u.chat_id
        ORDER BY m.id DESC
        LIMIT 1
      ) AS last_message

    FROM users u
    ORDER BY u.last_seen DESC
  `).all();

  res.json(users);
});

// Admin: user messages
app.get(
  "/api/messages/:chatId",
  adminAuth,
  (req, res) => {

    const messages = db.prepare(`
      SELECT *
      FROM messages
      WHERE chat_id = ?
      ORDER BY id ASC
      LIMIT 500
    `).all(String(req.params.chatId));

    res.json(messages);
  }
);

// Admin: reply
app.post("/api/reply", adminAuth, async (req, res) => {

  try {
    const { chatId, message } = req.body;

    if (
      !chatId ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 4000
    ) {
      return res.status(400).json({
        error: "Invalid message"
      });
    }

    const user = db.prepare(`
      SELECT chat_id FROM users WHERE chat_id = ?
    `).get(String(chatId));

    if (!user) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    await sendUser(chatId, message.trim());

    saveMessage(chatId, "admin", message.trim());

    res.json({
      success: true
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

// Admin: Ban / Unban
app.post("/api/ban", adminAuth, (req, res) => {

  const { chatId, banned } = req.body;

  if (!chatId || typeof banned !== "boolean") {
    return res.status(400).json({
      error: "Invalid request"
    });
  }

  const result = db.prepare(`
    UPDATE users
    SET banned = ?
    WHERE chat_id = ?
  `).run(
    banned ? 1 : 0,
    String(chatId)
  );

  if (!result.changes) {
    return res.status(404).json({
      error: "User not found"
    });
  }

  res.json({
    success: true
  });
});

// Admin: Group / Channel broadcast
app.post(
  "/api/broadcast",
  adminAuth,
  async (req, res) => {

    try {
      const { target, message } = req.body;

      if (
        typeof target !== "string" ||
        !target.trim() ||
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 4000
      ) {
        return res.status(400).json({
          error: "Invalid input"
        });
      }

      await telegram("sendMessage", {
        chat_id: target.trim(),
        text: message.trim()
      });

      res.json({
        success: true
      });

    } catch (err) {
      res.status(500).json({
        error: err.message
      });
    }
  }
);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bot: "running"
  });
});

// Home page
app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// Start server
app.listen(PORT, async () => {

  console.log(
    "Server running on port " + PORT
  );

  if (BASE_URL) {

    try {
      await telegram("setWebhook", {
        url: `${BASE_URL}/telegram/${SECRET}`,
        secret_token: SECRET,
        allowed_updates: ["message"]
      });

      console.log(
        "Telegram webhook connected successfully"
      );

    } catch (err) {
      console.error(
        "Webhook setup failed:",
        err.message
      );
    }

  } else {
    console.log(
      "RENDER_EXTERNAL_URL is missing"
    );
  }
});
