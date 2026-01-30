// server.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const { connectDB } = require("./db/connect");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 6000;

// ----------------------
// Mongo bootstrap
// ----------------------

let db;

(async () => {
  try {
    db = await connectDB();

    await db
      .collection("documents")
      .createIndex({ docId: 1 }, { unique: true });

    await db
      .collection("chats")
      .createIndex({ docId: 1 });

    console.log("📚 Mongo indexes ready");

    server.listen(PORT, () =>
      console.log(`🚀 Server running on port ${PORT}`)
    );
  } catch (err) {
    console.error("❌ Mongo startup failed:", err);
    process.exit(1);
  }
})();

// ----------------------
// Static serving
// ----------------------

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

app.get("/doc/:id", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

// ----------------------
// In-memory socket state
// ----------------------

const latestContent = new Map();
const lastSavedContent = new Map();
const saveTimers = new Map();

const userNames = new Map();
const colors = new Map();

// ----------------------
// Helpers
// ----------------------

async function ensureDocExists(coll, docId, initialContent = "") {
  const now = new Date();

  await coll.findOneAndUpdate(
    { docId },
    {
      $setOnInsert: {
        docId,
        content: initialContent,
        history: [],
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

async function saveDoc(docId, editedBy = "Anonymous") {
  if (!db) return;

  const coll = db.collection("documents");

  const content = latestContent.get(docId) || "";
  const prev = lastSavedContent.get(docId);

  if (prev === content) return;

  await ensureDocExists(coll, docId, content);

  const now = new Date();

  await coll.updateOne(
    { docId },
    {
      $set: { content, updatedAt: now },
      $push: {
        history: {
          $each: [{ versionAt: now, content, editedBy }],
          $slice: -MAX_HISTORY,
        },
      },
    }
  );

  lastSavedContent.set(docId, content);

  const updated = await coll.findOne({ docId });
  io.to(docId).emit("history-data", updated.history || []);
}

async function pushChat(docId, line) {
  if (!db) return;

  const coll = db.collection("chats");

  await coll.updateOne(
    { docId },
    {
      $push: {
        messages: {
          $each: [line],
          $slice: -200,
        },
      },
    },
    { upsert: true }
  );
}

async function getChatHistory(docId) {
  if (!db) return [];

  const coll = db.collection("chats");
  const doc = await coll.findOne({ docId });

  return doc?.messages || [];
}

// ----------------------
// Socket handling
// ----------------------

io.on("connection", (socket) => {
  const randomColor = () =>
    `hsl(${Math.floor(Math.random() * 360)}, 80%, 50%)`;

  colors.set(socket.id, randomColor());

  socket.on("set-name", (name) => {
    if (typeof name === "string" && name.trim()) {
      userNames.set(socket.id, name.trim());
    } else {
      userNames.set(
        socket.id,
        `User${Math.floor(Math.random() * 9000) + 1000}`
      );
    }
  });

  socket.on("join-doc", async (docId) => {
    if (!docId) return;

    socket.join(docId);

    const room = io.sockets.adapter.rooms.get(docId);
    const count = room ? room.size : 1;

    io.to(docId).emit("presence-update", count);

    const coll = db.collection("documents");
    const doc = await coll.findOne({ docId });

    const content = doc?.content || "";

    latestContent.set(docId, content);
    lastSavedContent.set(docId, content);

    socket.emit("init-doc", { docId, content });
    socket.emit("history-data", doc?.history || []);

    const chats = await getChatHistory(docId);
    socket.emit("chat-history", chats);
  });

  socket.on("text-change", ({ docId, content }) => {
    if (!docId) return;

    latestContent.set(docId, content);

    socket.to(docId).emit("update-text", { docId, content });

    if (saveTimers.has(docId)) clearTimeout(saveTimers.get(docId));

    const t = setTimeout(
      () => saveDoc(docId, userNames.get(socket.id) || "Anonymous"),
      1200
    );

    saveTimers.set(docId, t);
  });

  socket.on("chat-message", async ({ docId, msg }) => {
    if (!docId || !msg) return;

    const who =
      userNames.get(socket.id) ||
      `User${Math.floor(Math.random() * 9999)}`;

    const line = { who, msg, at: new Date() };

    await pushChat(docId, line);

    io.to(docId).emit("chat-message", line);
  });

  socket.on("typing", ({ docId }) => {
    const who =
      userNames.get(socket.id) ||
      `User${Math.floor(Math.random() * 9999)}`;

    socket.broadcast.to(docId).emit("typing", who);
  });

  socket.on("cursor-update", ({ docId, position }) => {
    const who =
      userNames.get(socket.id) ||
      `User${Math.floor(Math.random() * 9999)}`;

    const color = colors.get(socket.id) || randomColor();

    socket.broadcast
      .to(docId)
      .emit("cursor-update", {
        socketId: socket.id,
        who,
        position,
        color,
      });
  });

  socket.on("view-version", async ({ docId, index }) => {
    const coll = db.collection("documents");
    const doc = await coll.findOne({ docId });

    const v = doc?.history?.[index];

    socket.emit("version-view", {
      index,
      version: v,
      docId,
    });
  });

  socket.on("restore-version", async ({ docId, index }) => {
    const coll = db.collection("documents");
    const doc = await coll.findOne({ docId });

    if (!doc?.history?.[index]) return;

    const content = doc.history[index].content;

    latestContent.set(docId, content);

    const now = new Date();

    await coll.updateOne(
      { docId },
      {
        $set: { content, updatedAt: now },
        $push: {
          history: {
            $each: [
              {
                versionAt: now,
                content,
                editedBy:
                  userNames.get(socket.id) || "Restored",
              },
            ],
            $slice: -MAX_HISTORY,
          },
        },
      }
    );

    io.to(docId).emit("version-restored", { content });

    const updated = await coll.findOne({ docId });
    io.to(docId).emit("history-data", updated.history || []);
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room === socket.id) continue;

      const r = io.sockets.adapter.rooms.get(room);
      const size = r ? r.size - 1 : 0;

      io.to(room).emit("presence-update", size);
    }
  });

  socket.on("disconnect", () => {
    userNames.delete(socket.id);
    colors.delete(socket.id);
  });
});
