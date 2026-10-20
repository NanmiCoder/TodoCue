import Foundation
import AppleSyncKit
import TodoCueKit

// Started by the desktop app (Contents/Helpers/TodoCueAppleSync) with TODOCUE_HOME set to its data
// directory. A child of the app, so macOS attributes Calendar and Reminders access to TodoCue.app.
// Commands arrive as JSON lines on stdin; status and results leave as JSON lines on stdout. When the
// app goes away stdin closes, and so does this process.

// A vanished host must end the process through EOF, not a signal raised mid-write.
signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

if let language = ProcessInfo.processInfo.environment["TODOCUE_APPLE_SYNC_LANGUAGE"] {
    L10n.languageOverride = AppLanguage(desktopSetting: language)
}

func emit(_ line: String) {
    do {
        try FileHandle.standardOutput.write(contentsOf: Data((line + "\n").utf8))
    } catch {
        exit(0)
    }
}

let helper = MainActor.assumeIsolated {
    SyncHelper(sync: AppleSyncController(store: EventKitStore(), client: "desktop"), link: RuntimeLink(), write: emit)
}

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        // Each command runs on its own: a permission prompt must not hold up "sync now".
        Task { @MainActor in await helper.handle(line) }
    }
    DispatchQueue.main.async { exit(0) }
}

MainActor.assumeIsolated { helper.start() }
// The run loop, not dispatchMain: Combine's heartbeat timer and EventKit's change notifications need it.
RunLoop.main.run()
