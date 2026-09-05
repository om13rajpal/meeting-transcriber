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
    format: { type: String, enum: ['generic', 'discord', 'slack', 'teams'], default: 'generic' },
    // Set after every send attempt (the automatic one on completion/failure,
    // or a manual resend - see resendNotifications() in
    // app/actions/meetings.js) so the meeting page can show real delivery
    // status instead of the notification being a total black box - this is
    // exactly what was missing when a webhook silently failed to fire and
    // debugging it required reading the database by hand.
    lastAttemptAt: Date,
    lastAttemptOk: Boolean,
    lastAttemptStatus: Number
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
  // Same delivery-status tracking as each userWebhooks entry above, for the
  // single email channel.
  emailLastAttemptAt: Date,
  emailLastAttemptOk: Boolean,
  title: String,
  originalName: String,
  isVideo: Boolean,
  durationSeconds: Number,
  transcript: String,
  utterances: [utteranceSchema],
  speakerNames: { type: Map, of: String, default: {} },
  // Snapshotted from transcribeFile()'s result at completion time (see
  // backend/server.js) rather than recomputed on read, so a later change
  // to the per-minute rate doesn't retroactively rewrite the cost of past
  // meetings - each meeting's cost reflects the rate that actually applied
  // when it was transcribed.
  deepgramModel: String,
  deepgramCostUsd: Number,
  // True once deepgramCostUsd holds Deepgram's actual billed amount (from
  // their Management API - see fetchExactCost() in
  // backend/services/deepgram.js), false while it's still the
  // DEEPGRAM_RATE_PER_MINUTE_USD estimate computed right at completion.
  // deepgramRequestId is what the backend's sweepPendingCosts() uses to
  // look that up; this frontend app never calls Deepgram directly.
  deepgramCostExact: { type: Boolean, default: false },
  deepgramRequestId: String,
  tags: { type: [String], default: [] },
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
  // Set by the backend while the raw uploaded file is preserved on its
  // local disk - present only between "we accepted this upload" and
  // "we're done with the file" (success, an explicit Cancel, or the
  // backend's orphaned-file sweep reclaiming it after a retention window).
  // A backend filesystem path, never exposed via toSummary/toDetail/
  // toApiKeySummary - see "Retry and Cancel" in CLAUDE.md.
  pendingFilePath: String,
  // Set alongside pendingFilePath every time the file is (re)stored - the
  // orphaned-file sweep's retention clock, since createdAt reflects the
  // *original* upload time even after a much later Retry re-stores the
  // same file.
  pendingFileStoredAt: Date,
  createdAt: { type: Date, default: Date.now }
});

// Every dashboard load runs Meeting.find({ userId }).sort({ createdAt: -1 }).
// A compound index lets MongoDB satisfy the filter and the sort from a
// single index scan instead of scanning by userId then sorting in memory.
meetingSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.Meeting || mongoose.model('Meeting', meetingSchema);
