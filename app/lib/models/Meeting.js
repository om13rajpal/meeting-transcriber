import 'server-only';
import mongoose from 'mongoose';

const utteranceSchema = new mongoose.Schema(
  {
    speaker: Number,
    start: Number,
    end: Number,
    transcript: String
  },
  { _id: false }
);

// Duplicated from app/lib/models/User.js's webhookSchema rather than
// imported, so this file's shape stays obviously in sync with
// backend/models/Meeting.js's copy at a glance - both already duplicate
// the whole schema, one more duplicated sub-schema doesn't add real risk.
const webhookSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    format: { type: String, enum: ['generic', 'discord', 'slack', 'teams'], default: 'generic' }
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema({
  // Indexed via the compound index below, not standalone here - every real
  // query on this field also sorts by createdAt, so one compound index
  // covers both instead of maintaining two indexes on every write.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Denormalized from User.email at creation time (in createUploadToken())
  // so the backend can send the completion/failure notification email
  // without its own User model or lookup, and so it's still available for
  // the stale-job sweep's failures too, long after the UploadToken this
  // meeting was created from is gone.
  userEmail: String,
  // Same denormalization as userEmail, snapshotted from User.webhooks at
  // creation time - a later change to the list doesn't retroactively apply
  // to meetings already in flight, matching how userEmail behaves.
  userWebhooks: [webhookSchema],
  title: String,
  originalName: String,
  isVideo: Boolean,
  durationSeconds: Number,
  transcript: String,
  utterances: [utteranceSchema],
  speakerNames: { type: Map, of: String, default: {} },
  // No `default` here on purpose: a sparse unique index only excludes
  // documents where the field is truly absent, not ones where it's null.
  // A default of null would put every un-shared meeting in the index as
  // shareToken: null and collide on the second one.
  shareToken: { type: String, index: true, unique: true, sparse: true },
  // The record is created with status 'processing' the instant the backend
  // accepts the upload, before ffmpeg/Deepgram ever run, and is updated in
  // place when the job finishes or fails. This is what makes a page reload
  // (or a dropped connection, or closing the tab) safe: the dashboard just
  // reads live DB state, it never depends on the browser remembering an
  // in-flight request. Defaults to 'complete' for backward compatibility
  // with rows created before this field existed.
  status: { type: String, enum: ['processing', 'complete', 'failed'], default: 'complete' },
  errorMessage: String,
  createdAt: { type: Date, default: Date.now }
});

// Every dashboard load runs Meeting.find({ userId }).sort({ createdAt: -1 }).
// A compound index lets MongoDB satisfy the filter and the sort from a
// single index scan instead of scanning by userId then sorting in memory.
meetingSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.Meeting || mongoose.model('Meeting', meetingSchema);
