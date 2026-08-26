const mongoose = require('mongoose');

async function connect() {
  await mongoose.connect(process.env.MONGODB_URI);
  return mongoose.connection;
}

module.exports = { connect };
