// Minimal CLI: captures system audio + microphone via ScreenCaptureKit and
// writes each to its own WAV file, faithfully, in whatever format
// ScreenCaptureKit delivers. No mixing/resampling here on purpose - ffmpeg
// (already a dependency of the main app) does that downstream, the same way
// the server already treats ffmpeg as the one place audio normalization
// happens. Runs until SIGTERM/SIGINT, then finalizes the files and exits.

import AVFAudio
import CoreMedia
import Foundation
import ScreenCaptureKit

func logLine(_ message: String) {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

enum RecorderError: Error {
  case noDisplay
}

extension CMSampleBuffer {
  // Copies the sample data out of the CMSampleBuffer into a freshly-owned
  // AVAudioPCMBuffer in the exact same format, so it stays valid after this
  // function returns (the CMSampleBuffer/backing CMBlockBuffer does not).
  func copyToPCMBuffer() -> AVAudioPCMBuffer? {
    guard let formatDescription = CMSampleBufferGetFormatDescription(self),
      let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription),
      let format = AVAudioFormat(streamDescription: asbdPointer)
    else {
      return nil
    }

    var blockBuffer: CMBlockBuffer?
    let bufferListPointer = AudioBufferList.allocate(maximumBuffers: 1)
    defer { free(bufferListPointer.unsafeMutablePointer) }

    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      self,
      bufferListSizeNeededOut: nil,
      bufferListOut: bufferListPointer.unsafeMutablePointer,
      bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: 1),
      blockBufferAllocator: nil,
      blockBufferMemoryAllocator: nil,
      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
      blockBufferOut: &blockBuffer
    )
    guard status == noErr, let source = bufferListPointer.first, let sourceData = source.mData else {
      return nil
    }

    let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(self))
    guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
      return nil
    }
    pcmBuffer.frameLength = frameCount

    guard let destination = pcmBuffer.audioBufferList.pointee.mBuffers.mData else {
      return nil
    }
    memcpy(destination, sourceData, Int(source.mDataByteSize))

    return pcmBuffer
  }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private var stream: SCStream?
  private var systemAudioFile: AVAudioFile?
  private var micAudioFile: AVAudioFile?
  private let systemOutputURL: URL
  private let micOutputURL: URL
  private let ioQueue = DispatchQueue(label: "recorder.io")

  init(systemOutputURL: URL, micOutputURL: URL) {
    self.systemOutputURL = systemOutputURL
    self.micOutputURL = micOutputURL
  }

  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else {
      throw RecorderError.noDisplay
    }

    let filter = SCContentFilter(display: display, excludingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = 48000
    config.channelCount = 2
    config.captureMicrophone = true
    // We only want audio; minimize the video side of the capture session
    // ScreenCaptureKit requires audio-only capture to still be attached to.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.queueDepth = 8

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: ioQueue)
    try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: ioQueue)
    try await stream.startCapture()
    self.stream = stream

    logLine("READY")
  }

  func stop() async {
    try? await stream?.stopCapture()
    ioQueue.sync {
      systemAudioFile = nil
      micAudioFile = nil
    }
  }

  func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard sampleBuffer.isValid, let pcmBuffer = sampleBuffer.copyToPCMBuffer() else { return }

    switch type {
    case .audio:
      write(pcmBuffer, kind: .system)
    case .microphone:
      write(pcmBuffer, kind: .mic)
    default:
      break
    }
  }

  private enum Kind { case system, mic }

  private func write(_ buffer: AVAudioPCMBuffer, kind: Kind) {
    let url = kind == .system ? systemOutputURL : micOutputURL
    if kind == .system {
      if systemAudioFile == nil {
        systemAudioFile = try? AVAudioFile(forWriting: url, settings: buffer.format.settings)
      }
      try? systemAudioFile?.write(from: buffer)
    } else {
      if micAudioFile == nil {
        micAudioFile = try? AVAudioFile(forWriting: url, settings: buffer.format.settings)
      }
      try? micAudioFile?.write(from: buffer)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    logLine("STREAM_ERROR: \(error.localizedDescription)")
  }
}

func parseArgs() -> (system: URL, mic: URL)? {
  var systemPath: String?
  var micPath: String?
  var args = CommandLine.arguments.dropFirst()
  while let arg = args.first {
    args = args.dropFirst()
    switch arg {
    case "--system-output":
      systemPath = args.first
      args = args.dropFirst()
    case "--mic-output":
      micPath = args.first
      args = args.dropFirst()
    default:
      break
    }
  }
  guard let systemPath, let micPath else { return nil }
  return (URL(fileURLWithPath: systemPath), URL(fileURLWithPath: micPath))
}

guard let (systemURL, micURL) = parseArgs() else {
  logLine("Usage: MacRecorder --system-output <path.wav> --mic-output <path.wav>")
  exit(64)
}

let recorder = Recorder(systemOutputURL: systemURL, micOutputURL: micURL)

let stopSignal = DispatchSemaphore(value: 0)
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
sigtermSource.setEventHandler { stopSignal.signal() }
sigintSource.setEventHandler { stopSignal.signal() }
sigtermSource.resume()
sigintSource.resume()

let task = Task {
  do {
    try await recorder.start()
  } catch {
    logLine("START_ERROR: \(error.localizedDescription)")
    exit(1)
  }
}

DispatchQueue.global().async {
  stopSignal.wait()
  Task {
    await recorder.stop()
    logLine("STOPPED")
    exit(0)
  }
}

RunLoop.main.run()
