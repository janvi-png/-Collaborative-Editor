const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGO_URL;

let client;
let db;

async function connectDB() {
  if (db) return db;

  client = new MongoClient(uri, {
    tls: true,
    tlsAllowInvalidCertificates: true, // REQUIRED on Render
    serverSelectionTimeoutMS: 15000,
    directConnection: true, // IMPORTANT for Railway proxy
  });

  await client.connect();
  db = client.db("collabDB");

  console.log("✅ Connected to MongoDB (Railway from Render)");
  return db;
}

module.exports = { connectDB };
