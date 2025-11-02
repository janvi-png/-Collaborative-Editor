// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });


const MONGO_URL = process.env.MONGO_URL;
const PORT = process.env.PORT || 3000;
const DB_NAME = "collabDB";
const MAX_HISTORY = 6000; // max history entries to keep per document
// MongoDB connection
let db;
(async () => {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME);
  // ensure indexes maybe
  await db.collection("documents").createIndex({ docId: 1 }, { unique: true });
  await db.collection("chats").createIndex({ docId: 1 });
  console.log("✅ Connected to MongoDB:", MONGO_URL);
})().catch((e) => {
  console.error("Mongo connection error:", e);
  process.exit(1);
});

// Serve static
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/doc/:id", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

// Socket state
const latestContent = new Map(); // docId -> latest HTML content (in-memory)
const lastSavedContent = new Map(); // docId -> last saved string
const saveTimers = new Map(); // docId -> timeout
const userNames = new Map(); // socketId -> name
const colors = new Map(); // socketId -> color (string)

// Helper: ensure document exists (no conflict $push)
async function ensureDocExists(coll, docId, initialContent = "") {
  const now = new Date();
  await coll.findOneAndUpdate(
    { docId },
    { $setOnInsert: { docId, content: initialContent, history: [], createdAt: now } },
    { upsert: true, returnDocument: "after" }
  );
}

// Save function (two-step to avoid $push conflict)
async function saveDoc(docId, editedBy = "Anonymous") {
  if (!db) return;
  const coll = db.collection("documents");
  const content = latestContent.get(docId) || "";
  const prev = lastSavedContent.get(docId);
  if (prev === content) return; // no change -> skip

  // Step 1: ensure doc exists
  await ensureDocExists(coll, docId, content);

  // Step 2: push history + set content
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

  // Broadcast updated history to room
  const updated = await coll.findOne({ docId });
  io.to(docId).emit("history-data", updated.history || []);
}

// Chat persistence: store chat lines in collection 'chats' per docId (limited)
async function pushChat(docId, line) {
  if (!db) return;
  const coll = db.collection("chats");
  await coll.updateOne({ docId }, { $push: { messages: { $each: [line], $slice: -200 } } }, { upsert: true });
}

// When client joins, send chat history from DB
async function getChatHistory(docId) {
  if (!db) return [];
  const coll = db.collection("chats");
  const doc = await coll.findOne({ docId });
  return doc?.messages || [];
}

// Socket handling
io.on("connection", (socket) => {
  // assign color by default
  const randomColor = () => `hsl(${Math.floor(Math.random() * 360)}, 80%, 50%)`;
  colors.set(socket.id, randomColor());

  socket.on("set-name", (name) => {
    if (name && typeof name === "string" && name.trim().length) {
      userNames.set(socket.id, name.trim());
    } else {
      // auto-generate fun name if empty
      const anon = `User${Math.floor(Math.random() * 9000) + 1000}`;
      userNames.set(socket.id, anon);
    }
  });

  socket.on("join-doc", async (docId) => {
    if (!docId) return;
    socket.join(docId);

    // presence count
    const room = io.sockets.adapter.rooms.get(docId);
    const count = room ? room.size : 1;
    io.to(docId).emit("presence-update", count);

    // load doc content from DB
    const docColl = db.collection("documents");
    const doc = await docColl.findOne({ docId });
    const content = doc?.content || "";
    latestContent.set(docId, content);
    lastSavedContent.set(docId, content);

    socket.emit("init-doc", { docId, content });
    // send history list
    socket.emit("history-data", doc?.history || []);
    // send chat history (persisted)
    const chats = await getChatHistory(docId);
    socket.emit("chat-history", chats);
  });

  socket.on("text-change", ({ docId, content }) => {
    if (!docId) return;
    latestContent.set(docId, content);
    // broadcast to others
    socket.to(docId).emit("update-text", { docId, content });

    // debounce save per doc
    if (saveTimers.has(docId)) clearTimeout(saveTimers.get(docId));
    const t = setTimeout(() => saveDoc(docId, userNames.get(socket.id) || "Anonymous"), 1200);
    saveTimers.set(docId, t);
  });

  socket.on("chat-message", async ({ docId, msg }) => {
    if (!docId || !msg) return;
    const who = userNames.get(socket.id) || `User${Math.floor(Math.random() * 9999)}`;
    const line = { who, msg, at: new Date() };
    // persist
    await pushChat(docId, line);
    // broadcast
    io.to(docId).emit("chat-message", line);
  });

  socket.on("typing", ({ docId }) => {
    const who = userNames.get(socket.id) || `User${Math.floor(Math.random() * 9999)}`;
    socket.broadcast.to(docId).emit("typing", who);
  });

  // cursor label broadcast
  socket.on("cursor-update", ({ docId, position }) => {
    const who = userNames.get(socket.id) || `User${Math.floor(Math.random() * 9999)}`;
    const color = colors.get(socket.id) || randomColor();
    socket.broadcast.to(docId).emit("cursor-update", { socketId: socket.id, who, position, color });
  });

  // request to view a version (server will send two adjacent versions for diff if needed)
  socket.on("view-version", async ({ docId, index }) => {
    const coll = db.collection("documents");
    const doc = await coll.findOne({ docId });
    if (!doc) return;
    // send the requested version content + metadata
    const v = doc.history?.[index];
    socket.emit("version-view", { index, version: v, docId });
  });

  // restore version (do not create immediate new duplicate snapshot).
  socket.on("restore-version", async ({ docId, index }) => {
    const coll = db.collection("documents");
    const doc = await coll.findOne({ docId });
    if (!doc || !doc.history || !doc.history[index]) return;
    const content = doc.history[index].content;
    // set as live content (in-memory)
    latestContent.set(docId, content);
    // update DB content (but also push a restore metadata entry)
    const now = new Date();
    await coll.updateOne(
      { docId },
      {
        $set: { content, updatedAt: now },
        $push: { history: { $each: [{ versionAt: now, content, editedBy: userNames.get(socket.id) || "Restored" }], $slice: -MAX_HISTORY } },
      }
    );
    // broadcast restored content and updated history
    io.to(docId).emit("version-restored", { content });
    const updated = await coll.findOne({ docId });
    io.to(docId).emit("history-data", updated.history || []);
  });

  socket.on("disconnecting", () => {
    // update presence for all rooms the socket was in
    for (const room of socket.rooms) {
      if (room === socket.id) continue;
      // room is docId
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

server.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
console.log("✅ MONGO_URL from .env:", MONGO_URL);
