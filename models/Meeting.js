const mongoose = require('mongoose');

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
  // No `default` here on purpose: a sparse unique index only excludes
  // documents where the field is truly absent, not ones where it's null.
  // A default of null would put every un-shared meeting in the index as
  // shareToken: null and collide on the second one.
  shareToken: { type: String, index: true, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Meeting', meetingSchema);
