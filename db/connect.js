// db.js
const { MongoClient } = require("mongodb");

const uri = process.env.MONGO_URL;

let client;
let db;

async function connectDB() {
  if (db) return db;

  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 20000,
  });

  await client.connect();
  db = client.db(); // uses DB name from URI

  console.log("✅ MongoDB connected");
  return db;
}

module.exports = { connectDB };
