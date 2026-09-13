const mongoose = require('mongoose');

// Must match app/lib/models/McpToken.js in the Next.js app exactly - both
// services read/write the same MongoDB collection. Minted by the frontend
// (Settings), verified here (backend/services/mcpAuth.js) since this is
// the service that serves POST /mcp.
const mcpTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  keyHash: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null }
});

module.exports = mongoose.models.McpToken || mongoose.model('McpToken', mcpTokenSchema);
