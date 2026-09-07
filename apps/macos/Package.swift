// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "TodoCue",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "TodoCue", targets: ["TodoCue"]),
        .executable(name: "TodoCueNotifier", targets: ["TodoCueNotifier"]),
        .library(name: "TodoCueKit", targets: ["TodoCueKit"]),
    ],
    targets: [
        .target(name: "TodoCueKit", path: "Sources/TodoCueKit"),
        .executableTarget(
            name: "TodoCue",
            dependencies: ["TodoCueKit"],
            path: "Sources/TodoCue",
            linkerSettings: [.linkedFramework("Carbon"), .linkedFramework("ServiceManagement")]
        ),
        .executableTarget(
            name: "TodoCueNotifier",
            dependencies: ["TodoCueKit"],
            path: "Sources/TodoCueNotifier",
            linkerSettings: [.linkedFramework("UserNotifications")]
        ),
        .testTarget(name: "TodoCueKitTests", dependencies: ["TodoCueKit"], path: "Tests/TodoCueKitTests"),
        .testTarget(name: "TodoCueTests", dependencies: ["TodoCue"], path: "Tests/TodoCueTests"),
    ],
    swiftLanguageVersions: [.v5]
)
