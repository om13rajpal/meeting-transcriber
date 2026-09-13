import 'server-only';
import mongoose from 'mongoose';

// A separate credential from ApiKey, deliberately - not a scope flag on
// it. ApiKey (used by the desktop app) can never read transcript content;
// this token exists specifically to grant that to an MCP client (Claude
// Desktop, etc.), and keeping it a distinct model means a leaked ApiKey
// still can't do what this can. Same shape and hashing scheme as ApiKey
// (see app/lib/apiKeys.js's hashToken()) - only the raw key's prefix
// differs ("mcp_" vs "mtk_") so a leaked key's origin is identifiable at
// a glance.
const mcpTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  keyHash: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null }
});

export default mongoose.models.McpToken || mongoose.model('McpToken', mcpTokenSchema);
