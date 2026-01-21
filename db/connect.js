const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGO_URL;

let client;
let db;

async function connectDB() {
  if (db) return db;

  client = new MongoClient(uri, {
    tls: true,
    tlsInsecure: true,
    directConnection: true,
    serverSelectionTimeoutMS: 20000,
  });

  await client.connect();
  db = client.db("collabDB");

  console.log("✅ MongoDB connected (Render → Railway)");
  return db;
}

module.exports = { connectDB };
