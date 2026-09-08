import Foundation
import Combine

public enum AppLanguage: String, CaseIterable, Identifiable {
    case english = "en"
    case chinese = "zh-Hans"

    public var id: String { rawValue }
    public var name: String { self == .english ? "English" : "简体中文" }
    public var locale: Locale { Locale(identifier: rawValue) }

    public static func resolve(saved: String?, preferred: [String] = Locale.preferredLanguages) -> AppLanguage {
        if let saved, let language = AppLanguage(rawValue: saved) { return language }
        return preferred.first?.lowercased().hasPrefix("zh") == true ? .chinese : .english
    }
}

/// Shared by the app and notification helper. Isolated homes get isolated preferences.
public final class LanguagePreferences: ObservableObject {
    public static let shared = LanguagePreferences()
    public static let key = "appLanguage"
    static var store: UserDefaults {
        let home = Data(TodoCueHome.directory.path.utf8).base64EncodedString()
        return UserDefaults(suiteName: "com.todocue.language." + home)!
    }
    private let defaults: UserDefaults
    @Published public var language: AppLanguage {
        didSet { defaults.set(language.rawValue, forKey: Self.key) }
    }

    public init(defaults: UserDefaults? = nil, preferred: [String] = Locale.preferredLanguages) {
        let isDefaultStore = defaults == nil
        let defaults = defaults ?? Self.store
        self.defaults = defaults
        language = .resolve(saved: defaults.string(forKey: Self.key), preferred: preferred)
        #if DEBUG
        if isDefaultStore, let preview = ProcessInfo.processInfo.environment["TODOCUE_PREVIEW_LANGUAGE"],
           let value = AppLanguage(rawValue: preview), ProcessInfo.processInfo.environment["TODOCUE_HOME"] != nil {
            language = value
        }
        #endif
    }
}

/// Keeps the translation template separate from user-provided interpolation values.
public struct LocalizedText: ExpressibleByStringLiteral, ExpressibleByStringInterpolation {
    let key: String
    let arguments: [String]
    public init(stringLiteral value: String) { key = value; arguments = [] }
    public init(stringInterpolation: StringInterpolation) {
        key = stringInterpolation.key; arguments = stringInterpolation.arguments
    }
    public struct StringInterpolation: StringInterpolationProtocol {
        var key = ""
        var arguments: [String] = []
        public init(literalCapacity: Int, interpolationCount: Int) {}
        public mutating func appendLiteral(_ literal: String) { key += literal }
        public mutating func appendInterpolation<T>(_ value: T) {
            key += "{\(arguments.count)}"; arguments.append(String(describing: value))
        }
    }
}

public enum L10n {
    public static var language: AppLanguage { LanguagePreferences.shared.language }
    public static func tr(_ text: LocalizedText, language: AppLanguage? = nil) -> String {
        let template = (language ?? Self.language) == .english ? english[text.key] ?? text.key : text.key
        // Expand template matches once: a task title containing {1} stays literal.
        let regex = try! NSRegularExpression(pattern: #"\{(\d+)\}"#)
        var result = "", end = template.startIndex
        for match in regex.matches(in: template, range: NSRange(template.startIndex..., in: template)) {
            guard let range = Range(match.range, in: template),
                  let indexRange = Range(match.range(at: 1), in: template),
                  let index = Int(template[indexRange]), text.arguments.indices.contains(index) else { continue }
            result += template[end..<range.lowerBound] + text.arguments[index]
            end = range.upperBound
        }
        return result + template[end...]
    }
}
