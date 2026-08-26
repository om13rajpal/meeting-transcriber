// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "MacRecorder",
  platforms: [.macOS(.v15)],
  targets: [
    .executableTarget(name: "MacRecorder", path: "Sources/MacRecorder")
  ]
)
