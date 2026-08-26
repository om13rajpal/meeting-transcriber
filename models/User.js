const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  // Personal access token for non-browser clients (e.g. the desktop recorder).
  // No `default` here: see CLAUDE.md's note on sparse unique indexes.
  apiTokenHash: { type: String, index: true, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
