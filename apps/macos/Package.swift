// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "TodoCue",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "TodoCue", targets: ["TodoCue"]),
        .executable(name: "TodoCueNotifier", targets: ["TodoCueNotifier"]),
        .executable(name: "TodoCueAppleSync", targets: ["TodoCueAppleSync"]),
        .library(name: "TodoCueKit", targets: ["TodoCueKit"]),
    ],
    targets: [
        .target(name: "TodoCueKit", path: "Sources/TodoCueKit"),
        // Apple Calendar / Reminders sync, shared by the SwiftUI app and the desktop app's helper.
        .target(
            name: "AppleSyncKit",
            dependencies: ["TodoCueKit"],
            path: "Sources/AppleSyncKit",
            linkerSettings: [.linkedFramework("EventKit")]
        ),
        .executableTarget(
            name: "TodoCue",
            dependencies: ["TodoCueKit", "AppleSyncKit"],
            path: "Sources/TodoCue",
            linkerSettings: [.linkedFramework("Carbon"), .linkedFramework("ServiceManagement")]
        ),
        .executableTarget(
            name: "TodoCueNotifier",
            dependencies: ["TodoCueKit"],
            path: "Sources/TodoCueNotifier",
            linkerSettings: [.linkedFramework("UserNotifications")]
        ),
        // Headless sync process the shared (Tauri) desktop app starts on macOS.
        .executableTarget(
            name: "TodoCueAppleSync",
            dependencies: ["TodoCueKit", "AppleSyncKit"],
            path: "Sources/TodoCueAppleSync"
        ),
        .testTarget(name: "TodoCueKitTests", dependencies: ["TodoCueKit"], path: "Tests/TodoCueKitTests"),
        .testTarget(name: "TodoCueTests", dependencies: ["TodoCue"], path: "Tests/TodoCueTests"),
        .testTarget(name: "AppleSyncKitTests", dependencies: ["AppleSyncKit", "TodoCueAppleSync"], path: "Tests/AppleSyncKitTests"),
    ],
    swiftLanguageVersions: [.v5]
)
