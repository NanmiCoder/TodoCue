import XCTest
@testable import TodoCueKit

final class LocalizationTests: XCTestCase {
    func testLanguageResolutionAndFallback() {
        XCTAssertEqual(AppLanguage.resolve(saved: nil, preferred: ["zh-Hant-TW", "en"]), .chinese)
        XCTAssertEqual(AppLanguage.resolve(saved: nil, preferred: ["en-GB", "zh-Hans"]), .english)
        XCTAssertEqual(AppLanguage.resolve(saved: nil, preferred: ["fr"]), .english)
        XCTAssertEqual(AppLanguage.resolve(saved: "en", preferred: ["zh-Hans"]), .english)
        XCTAssertEqual(AppLanguage.resolve(saved: "zh-Hans", preferred: ["en"]), .chinese)
        XCTAssertEqual(AppLanguage.resolve(saved: "invalid", preferred: []), .english)
    }

    func testChoiceSurvivesNewPreferencesInstance() {
        let name = "todocue-language-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = LanguagePreferences(defaults: defaults, preferred: ["en"])
        preferences.language = .chinese
        XCTAssertEqual(defaults.string(forKey: LanguagePreferences.key), "zh-Hans")
        XCTAssertEqual(LanguagePreferences(defaults: defaults, preferred: ["en"]).language, .chinese)
        XCTAssertEqual(AppLanguage.resolve(saved: defaults.string(forKey: LanguagePreferences.key), preferred: ["en"]), .chinese)
        preferences.language = .english
        XCTAssertEqual(defaults.string(forKey: LanguagePreferences.key), "en")
        XCTAssertEqual(defaults.dictionaryRepresentation().keys.filter { $0 == LanguagePreferences.key }.count, 1)
    }

    func testInterpolationPreservesUserContentAndDoesNotExpandItsPlaceholders() {
        let title = "完成 {1} / Website redesign 🧪"
        let text: LocalizedText = "将「\(title)」改期到 \("Sep 10")，会晚于原截止时间。截止日期和提醒时间将保持原值。"
        XCTAssertEqual(L10n.tr(text, language: .english), "Rescheduling “完成 {1} / Website redesign 🧪” to Sep 10 puts it after its deadline. The deadline and reminder will stay unchanged.")
        XCTAssertEqual(L10n.tr("已添加「\(title)」", language: .chinese), "已添加「\(title)」")
        XCTAssertEqual(L10n.tr("今日已完成 \(2) 项，还剩 \(3) 项", language: .english), "Today: 2 completed, 3 remaining")
    }

    func testCatalogHasMatchingPlaceholdersAndNoUntranslatedEnglishCopy() {
        let regex = try! NSRegularExpression(pattern: #"\{\d+\}"#)
        func placeholders(_ value: String) -> [String] {
            regex.matches(in: value, range: NSRange(value.startIndex..., in: value))
                .map { String(value[Range($0.range, in: value)!]) }.sorted()
        }
        XCTAssertGreaterThan(L10n.english.count, 300)
        for (key, value) in L10n.english {
            XCTAssertEqual(placeholders(key), placeholders(value), key)
            XCTAssertFalse(value.isEmpty, key)
            XCTAssertNil(value.range(of: #"[\u4E00-\u9FFF]"#, options: .regularExpression), key)
        }
    }

    func testDatePresentationDoesNotChangeWireDates() {
        let date = TCDate.parse("2026-09-08T09:30:00.000Z")!
        XCTAssertEqual(TCDate.iso(date), "2026-09-08T09:30:00.000Z")
        XCTAssertEqual(TCDate.dateString(date, timezone: "Asia/Shanghai"), "2026-09-08")
        XCTAssertEqual(TCDate.dateLabel(TCDate.todayString()), L10n.language == .english ? "Today" : "今天")
        if L10n.language == .english {
            XCTAssertNil(TCDate.dayWithWeekday(date).range(of: #"[\u4E00-\u9FFF]"#, options: .regularExpression))
        }
    }
}
