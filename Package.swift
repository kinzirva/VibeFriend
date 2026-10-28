// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "VibeFriend", platforms: [.macOS(.v14)], products: [.executable(name: "VibeFriend", targets: ["VibeFriend"])], targets: [.executableTarget(name: "VibeFriend", path: "Sources/VibeFriend"), .testTarget(name: "VibeFriendTests", dependencies: ["VibeFriend"], path: "Tests/VibeFriendTests")])
