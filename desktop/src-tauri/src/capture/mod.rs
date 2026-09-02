// Audio capture module. Currently just microphone input (Task 4) - this
// will grow to cover system/loopback audio and mixing in later tasks, so
// keep this file a thin re-export rather than building that ahead of time.
mod mic;

pub use mic::start_mic_capture;
