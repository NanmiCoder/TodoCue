import AppKit
import Carbon

/// A recorded global shortcut (Carbon key code + modifier flags).
struct HotKeyCombo: Codable, Equatable {
    var keyCode: UInt32
    var modifiers: UInt32 // NSEvent.ModifierFlags raw value

    var displayString: String {
        let flags = NSEvent.ModifierFlags(rawValue: UInt(modifiers))
        var s = ""
        if flags.contains(.control) { s += "⌃" }
        if flags.contains(.option) { s += "⌥" }
        if flags.contains(.shift) { s += "⇧" }
        if flags.contains(.command) { s += "⌘" }
        return s + HotKeyCombo.keyName(keyCode)
    }

    static func keyName(_ code: UInt32) -> String {
        let special: [UInt32: String] = [36: "↩", 48: "⇥", 49: "Space", 51: "⌫", 53: "⎋", 122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12", 123: "←", 124: "→", 125: "↓", 126: "↑"]
        if let s = special[code] { return s }
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let ptr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return "#\(code)" }
        let data = unsafeBitCast(ptr, to: CFData.self)
        let layout = unsafeBitCast(CFDataGetBytePtr(data), to: UnsafePointer<UCKeyboardLayout>.self)
        var deadKeys: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0
        let err = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                                 UInt32(kUCKeyTranslateNoDeadKeysBit), &deadKeys, 4, &length, &chars)
        if err == noErr, length > 0 { return String(utf16CodeUnits: chars, count: length).uppercased() }
        return "#\(code)"
    }

    var carbonModifiers: UInt32 {
        let flags = NSEvent.ModifierFlags(rawValue: UInt(modifiers))
        var m: UInt32 = 0
        if flags.contains(.command) { m |= UInt32(cmdKey) }
        if flags.contains(.option) { m |= UInt32(optionKey) }
        if flags.contains(.control) { m |= UInt32(controlKey) }
        if flags.contains(.shift) { m |= UInt32(shiftKey) }
        return m
    }
}

/// Registers one global hotkey through Carbon `RegisterEventHotKey`. Unbound by default.
final class HotKeyCenter {
    static let shared = HotKeyCenter()
    static let defaultsKey = "globalHotKey"

    var handler: (() -> Void)?
    private var ref: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private(set) var combo: HotKeyCombo?

    private init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { HotKeyCenter.shared.handler?() }
            return noErr
        }, 1, &spec, nil, &eventHandler)
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let c = try? JSONDecoder().decode(HotKeyCombo.self, from: data) {
            register(c)
        }
    }

    func register(_ c: HotKeyCombo?) {
        unregister()
        combo = c
        if let c {
            let id = EventHotKeyID(signature: OSType(0x54444351), id: 1) // 'TDCQ'
            RegisterEventHotKey(c.keyCode, c.carbonModifiers, id, GetApplicationEventTarget(), 0, &ref)
            if let data = try? JSONEncoder().encode(c) { UserDefaults.standard.set(data, forKey: Self.defaultsKey) }
        } else {
            UserDefaults.standard.removeObject(forKey: Self.defaultsKey)
        }
    }

    private func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }
}
