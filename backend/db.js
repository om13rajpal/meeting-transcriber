const mongoose = require('mongoose');

let connectionPromise = null;

async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connectionPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set.');
    connectionPromise = mongoose.connect(uri);
  }
  await connectionPromise;
  return mongoose.connection;
}

module.exports = { connectToDatabase };
