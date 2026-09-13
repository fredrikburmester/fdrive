// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FdriveKit",
    platforms: [.macOS("26.0")],
    products: [.library(name: "FdriveKit", targets: ["FdriveKit"])],
    targets: [
        .target(name: "FdriveKit", linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(name: "FdriveKitTests", dependencies: ["FdriveKit"])
    ]
)
