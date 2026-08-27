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
  // Indexed via the compound index below, not standalone here - every real
  // query on this field also sorts by createdAt, so one compound index
  // covers both instead of maintaining two indexes on every write.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Denormalized from User.email at creation time, so this backend can
  // send the completion/failure email without a User model or lookup.
  userEmail: String,
  title: String,
  originalName: String,
  isVideo: Boolean,
  durationSeconds: Number,
  transcript: String,
  utterances: [utteranceSchema],
  speakerNames: { type: Map, of: String, default: {} },
  // No `default` here on purpose: a sparse unique index only excludes
  // documents where the field is truly absent, not ones where it's null.
  shareToken: { type: String, index: true, unique: true, sparse: true },
  // Set to 'processing' the instant the upload is accepted, before
  // ffmpeg/Deepgram run, and updated in place on completion or failure.
  // This is what makes a client reload/disconnect safe: the frontend just
  // reads live DB state instead of depending on the browser remembering an
  // in-flight request.
  status: { type: String, enum: ['processing', 'complete', 'failed'], default: 'complete' },
  errorMessage: String,
  createdAt: { type: Date, default: Date.now }
});

meetingSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.Meeting || mongoose.model('Meeting', meetingSchema);
