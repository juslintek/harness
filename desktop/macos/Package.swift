// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HarnessMac",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "HarnessKit"),
        .executableTarget(name: "HarnessMac", dependencies: ["HarnessKit"]),
        .testTarget(name: "HarnessKitTests", dependencies: ["HarnessKit"]),
    ],
    swiftLanguageModes: [.v6]
)
