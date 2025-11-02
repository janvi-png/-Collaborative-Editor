// db/connect.js
const { MongoClient } = require("mongodb");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URL;
let dbClient = null;
let db = null;

async function connectDB() {
  if (db) return db;
  dbClient = new MongoClient(MONGO_URI);
  await dbClient.connect();
  db = dbClient.db("collabDB");
  console.log("✅ Connected to MongoDB (Railway)");
  return db;
}

module.exports = { connectDB };
