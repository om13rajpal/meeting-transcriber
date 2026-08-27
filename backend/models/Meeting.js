const mongoose = require('mongoose');

// Must match app/lib/models/Meeting.js in the Next.js app exactly - both
// services read/write the same MongoDB collection.

const utteranceSchema = new mongoose.Schema(
  {
    speaker: Number,
    start: Number,
    end: Number,
    transcript: String
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: String,
  originalName: String,
  isVideo: Boolean,
  durationSeconds: Number,
  transcript: String,
  utterances: [utteranceSchema],
  speakerNames: { type: Map, of: String, default: {} },
  // No `default` here: a sparse unique index only excludes documents where
  // the field is truly absent, not ones where it's null.
  shareToken: { type: String, index: true, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Meeting || mongoose.model('Meeting', meetingSchema);
