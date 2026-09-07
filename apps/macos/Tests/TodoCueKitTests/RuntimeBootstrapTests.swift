import XCTest
@testable import TodoCueKit

final class RuntimeBootstrapTests: XCTestCase {
    func testMissingSidecarIsANoOpForDevelopmentBuilds() async throws {
        let bundle = URL(fileURLWithPath: "/missing/TodoCue.app")
        XCTAssertFalse(RuntimeBootstrap.isBundled(in: bundle))
        try await RuntimeBootstrap.prepare(bundle: bundle)
    }

    func testPackagedLaunchPassesExplicitPersistentHomeAsOneArgument() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let bundle = root.appendingPathComponent("TodoCue Test.app")
        let node = RuntimeBootstrap.executable(in: bundle)
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        let argumentsFile = root.appendingPathComponent("arguments.txt")
        let script = "#!/bin/sh\nprintf '%s\\n' \"$@\" > '\(argumentsFile.path)'\n"
        try script.write(to: node, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let home = root.appendingPathComponent("user data/.todocue")
        try await RuntimeBootstrap.prepare(bundle: bundle, home: home)
        let args = try String(contentsOf: argumentsFile).split(separator: "\n").map(String.init)
        XCTAssertEqual(args, [bundle.appendingPathComponent("Contents/Resources/runtime/packages/cli/dist/index.js").path,
                              "--home", home.path, "--json", "bootstrap"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.path)) // Setup is delegated, never resets data in Swift.
    }

    func testFailedSetupSurfacesTheActionableRuntimeError() async {
        do {
            try await RuntimeBootstrap.run(executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "printf '%s' '{\"error\":{\"message\":\"Move the app to Applications\"}}' >&2; exit 1"])
            XCTFail("Expected failure")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Move the app to Applications")
        }
    }
}
