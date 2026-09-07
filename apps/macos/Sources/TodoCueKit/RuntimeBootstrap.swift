import Foundation

/// Starts the runtime shipped inside the app without requiring Node or a source checkout.
public enum RuntimeBootstrap {
    public static func executable(in bundle: URL) -> URL {
        bundle.appendingPathComponent("Contents/Resources/runtime/bin/node")
    }

    public static func isBundled(in bundle: URL = Bundle.main.bundleURL) -> Bool {
        FileManager.default.isExecutableFile(atPath: executable(in: bundle).path)
    }

    public static func prepare(bundle: URL = Bundle.main.bundleURL, home: URL = TodoCueHome.directory) async throws {
        guard isBundled(in: bundle) else { return } // SwiftPM development builds use a separate runtime.
        let node = executable(in: bundle)
        let cli = bundle.appendingPathComponent("Contents/Resources/runtime/packages/cli/dist/index.js")
        try await run(executable: node, arguments: [cli.path, "--home", home.path, "--json", "bootstrap"])
    }

    static func run(executable: URL, arguments: [String]) async throws {
        try await Task.detached(priority: .userInitiated) {
            let process = Process()
            process.executableURL = executable
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            try process.run()
            // Drain before waiting so output cannot fill the pipe and deadlock the child.
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                let error = json?["error"] as? [String: Any]
                let message = error?["message"] as? String ?? String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                throw NSError(domain: "TodoCue.Runtime", code: Int(process.terminationStatus),
                              userInfo: [NSLocalizedDescriptionKey: message?.isEmpty == false ? message! : "后台服务启动失败，请重新打开 TodoCue。"])
            }
        }.value
    }
}
