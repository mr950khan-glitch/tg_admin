
const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

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
  throw new Error("BOT_TOKEN, ADMIN_KEY and WEBHOOK_SECRET are required");
}

if (!/^[A-Za-z0-9_-]{1,256}$/.test(SECRET)) {
  throw new Error("Invalid WEBHOOK_SECRET");
}

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), {
  recursive: true
});

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  chat_id TEXT UNIQUE,
  first_name TEXT,
  username TEXT,
  last_name TEXT,
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

async function telegram(method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

function saveMessage(chatId, direction, message) {
  db.prepare(`
    INSERT INTO messages (chat_id, direction, message)
    VALUES (?, ?, ?)
  `).run(String(chatId), direction, message);
}

// Telegram incoming messages
async function handleUpdate(update) {
  const msg = update.message;

  if (!msg || !msg.from || !msg.chat ||
      msg.chat.type !== "private") return;

  const chatId = String(msg.chat.id);
  const user = msg.from;

  db.prepare(`
    INSERT INTO users
      (chat_id, first_name, username, last_name, last_seen)
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

  const record = db.prepare(
    "SELECT banned FROM users WHERE chat_id = ?"
  ).get(chatId);

  if (record.banned) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "আপনি বর্তমানে বট থেকে ব্লক করা আছেন।"
    });
    return;
  }

  let text = msg.text || msg.caption || "";

  if (msg.photo) text = "[Photo received]";
  else if (msg.document) text = "[Document received]";
  else if (msg.voice) text = "[Voice message received]";
  else if (msg.video) text = "[Video received]";
  else if (msg.sticker) text = "[Sticker received]";
  else if (!text) text = "[Unsupported message type]";

  saveMessage(chatId, "user", text);

  if (msg.text === "/start") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text:
        "স্বাগতম! ❤️\n\n" +
        "আপনাকে কি ভাবে সাহায্য করতে পারি" +
        "অনুগ্রহ করে আপনার ইউজার id দিন । " +
        "অনুগ্রহ করে কিছু সময় অপেক্ষা করুন"
    });
  } else {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "আপনার মেসেজ গ্রহণ করা হয়েছে। অ্যাডমিন শীঘ্রই উত্তর দেবেন।"
    });
  }
}

// Admin security
function adminAuth(req, res, next) {
  const supplied = req.get("x-admin-key") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_KEY);

  if (a.length !== b.length ||
      !require("crypto").timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// Telegram webhook
app.post("/telegram/:secret", async (req, res) => {
  if (req.params.secret !== SECRET ||
      req.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Update error:", err.message);
  }
});

// Admin: get all users
app.get("/api/users", adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT u.*,
      (SELECT message FROM messages m
       WHERE m.chat_id = u.chat_id
       ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM users u
    ORDER BY u.last_seen DESC
  `).all();

  res.json(users);
});

// Admin: get conversation
app.get("/api/messages/:chatId", adminAuth, (req, res) => {
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY id ASC
    LIMIT 500
  `).all(String(req.params.chatId));

  res.json(messages);
});

// Admin: reply to user
app.post("/api/reply", adminAuth, async (req, res) => {
  try {
    const { chatId, message } = req.body;

    if (!chatId || typeof message !== "string" ||
        !message.trim() || message.length > 4000) {
      return res.status(400).json({ error: "Invalid message" });
    }

    const user = db.prepare(
      "SELECT banned FROM users WHERE chat_id = ?"
    ).get(String(chatId));

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await telegram("sendMessage", {
      chat_id: String(chatId),
      text: message.trim()
    });

    saveMessage(chatId, "admin", message.trim());

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ban / Unban
app.post("/api/ban", adminAuth, (req, res) => {
  const { chatId, banned } = req.body;

  const result = db.prepare(
    "UPDATE users SET banned = ? WHERE chat_id = ?"
  ).run(banned ? 1 : 0, String(chatId));

  if (!result.changes) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json({ success: true });
});

// Group / Channel broadcast
app.post("/api/broadcast", adminAuth, async (req, res) => {
  try {
    const { target, message } = req.body;

    if (typeof target !== "string" || !target.trim() ||
        typeof message !== "string" || !message.trim() ||
        message.length > 4000) {
      return res.status(400).json({ error: "Invalid input" });
    }

    await telegram("sendMessage", {
      chat_id: target.trim(),
      text: message.trim()
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, async () => {
  console.log("Server running on port " + PORT);

  if (BASE_URL) {
    try {
      await telegram("setWebhook", {
        url: `${BASE_URL}/telegram/${SECRET}`,
        secret_token: SECRET,
        allowed_updates: ["message"]
      });
      console.log("Telegram webhook connected");
    } catch (err) {
      console.error("Webhook setup failed:", err.message);
    }
  } else {
    console.log("Set RENDER_EXTERNAL_URL on Render");
  }
});
