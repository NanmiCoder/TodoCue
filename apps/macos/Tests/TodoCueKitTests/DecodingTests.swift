import XCTest
@testable import TodoCueKit

final class DecodingTests: XCTestCase {
    let taskJSON = """
    {
      "id": "t_1", "title": "写周报", "notes": null, "project": "work", "priority": "high",
      "estimateMinutes": 30,
      "scheduledDate": "2026-09-07", "scheduledAt": null,
      "dueDate": null, "dueAt": "2026-09-07T10:00:00.000Z", "reminderAt": "2026-09-07T09:30:00.000Z",
      "timezone": "Asia/Shanghai",
      "status": "todo", "completedAt": null,
      "seriesId": "s_1", "occurrenceDate": "2026-09-07",
      "version": 3, "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z"
    }
    """

    func testTaskDecodes() throws {
        let t = try JSONDecoder().decode(TodoTask.self, from: Data(taskJSON.utf8))
        XCTAssertEqual(t.id, "t_1")
        XCTAssertEqual(t.priority, .high)
        XCTAssertEqual(t.estimateMinutes, 30)
        XCTAssertNil(t.notes)
        XCTAssertEqual(t.dueAt, "2026-09-07T10:00:00.000Z")
        XCTAssertTrue(t.isSeriesInstance)
        XCTAssertTrue(t.hasReminder)
        XCTAssertEqual(t.version, 3)
        XCTAssertEqual(t.planDate, "2026-09-07")
    }

    func testTodayResultDecodes() throws {
        let json = """
        { "date": "2026-09-07", "timezone": "Asia/Shanghai", "now": "2026-09-07T01:00:00.000Z", "remaining": 1,
          "items": [ { "task": \(taskJSON), "reasons": ["due_today", "scheduled_today"], "section": "must" } ],
          "completed": [] }
        """
        let r = try JSONDecoder().decode(TodayResult.self, from: Data(json.utf8))
        XCTAssertEqual(r.remaining, 1)
        XCTAssertEqual(r.items.first?.section, .must)
        XCTAssertEqual(r.items.first?.reasons, [.due_today, .scheduled_today])
    }

    func testNextResultDecodes() throws {
        let json = """
        { "now": "2026-09-07T01:00:00.000Z", "timezone": "Asia/Shanghai",
          "next": { "task": \(taskJSON), "group": "due_today", "reason": "今日截止" },
          "candidates": [ { "task": \(taskJSON), "group": "due_today", "reason": "今日截止" } ] }
        """
        let r = try JSONDecoder().decode(NextResult.self, from: Data(json.utf8))
        XCTAssertEqual(r.next?.group, .due_today)
        XCTAssertEqual(r.candidates.count, 1)

        let nullNext = """
        { "now": "2026-09-07T01:00:00.000Z", "timezone": "Asia/Shanghai", "next": null, "candidates": [] }
        """
        let r2 = try JSONDecoder().decode(NextResult.self, from: Data(nullNext.utf8))
        XCTAssertNil(r2.next)
    }

    func testSeriesDecodesBothRules() throws {
        let daily = """
        { "id": "s_1", "title": "站会", "notes": null, "project": null, "priority": "none", "estimateMinutes": null,
          "rule": { "kind": "daily" }, "scheduledTime": "09:00", "reminderTime": "08:50", "timezone": "Asia/Shanghai",
          "startDate": "2026-09-01", "endDate": null, "status": "active", "stoppedAt": null,
          "generatedThrough": "2026-10-01", "version": 1, "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" }
        """
        let s = try JSONDecoder().decode(Series.self, from: Data(daily.utf8))
        XCTAssertEqual(s.rule, .daily)
        XCTAssertEqual(s.rule.label, L10n.tr("每日"))

        let weekly = daily.replacingOccurrences(of: "{ \"kind\": \"daily\" }", with: "{ \"kind\": \"weekly\", \"weekdays\": [1,3,5] }")
        let w = try JSONDecoder().decode(Series.self, from: Data(weekly.utf8))
        XCTAssertEqual(w.rule, .weekly(weekdays: [1, 3, 5]))
        XCTAssertEqual(w.rule.label, L10n.language == .chinese ? "每周 一、三、五" : "Every week: Mon, Wed, Fri")

        // round trip
        let data = try JSONEncoder().encode(w.rule)
        let back = try JSONDecoder().decode(RecurrenceRule.self, from: data)
        XCTAssertEqual(back, w.rule)
    }

    func testReminderAndEventDecode() throws {
        let rem = """
        { "id": "r_1", "taskId": "t_1", "fireAt": "2026-09-07T09:30:00.000Z", "status": "submitted",
          "attempts": 1, "lastError": null, "submittedAt": "2026-09-07T09:30:01.000Z", "channel": "helper",
          "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-07T09:30:01.000Z" }
        """
        let r = try JSONDecoder().decode(Reminder.self, from: Data(rem.utf8))
        XCTAssertEqual(r.status, .submitted)
        XCTAssertEqual(r.channel, "helper")

        let ev = """
        {"seq":42,"type":"reminder.updated","at":"2026-09-07T09:30:01.000Z","id":"r_1","related":{"taskId":"t_1"}}
        """
        let e = try JSONDecoder().decode(RuntimeEvent.self, from: Data(ev.utf8))
        XCTAssertEqual(e.type, .reminderUpdated)
        XCTAssertEqual(e.related?["taskId"], "t_1")

        let dayChanged = """
        {"seq":43,"type":"day.changed","at":"2026-09-07T16:00:00.000Z","id":null}
        """
        let d = try JSONDecoder().decode(RuntimeEvent.self, from: Data(dayChanged.utf8))
        XCTAssertEqual(d.type, .dayChanged)
        XCTAssertNil(d.id)
    }

    func testContextAndDoctorDecode() throws {
        let ctx = """
        { "now": "2026-09-07T01:00:00.000Z", "timezone": "Asia/Shanghai", "today": "2026-09-07",
          "localNow": "2026-09-07T09:00:00", "weekday": 1, "runtimeVersion": "0.1.0" }
        """
        let c = try JSONDecoder().decode(ContextInfo.self, from: Data(ctx.utf8))
        XCTAssertEqual(c.weekday, 1)

        let doc = """
        { "runtimeVersion": "0.1.0", "nodeVersion": "v26.7.0", "home": "/Users/x/.todocue", "databasePath": "/Users/x/.todocue/todocue.sqlite",
          "schemaVersion": 1, "timezone": "Asia/Shanghai", "baseUrl": "http://127.0.0.1:47831", "pid": 1, "uptimeSeconds": 12.5,
          "notifier": { "path": null, "available": false, "authorization": "unknown", "detail": null },
          "counts": { "tasks": 1, "todo": 1, "series": 0, "pendingReminders": 0, "failedReminders": 0 },
          "checks": [ { "name": "db", "ok": true, "level": "ok", "detail": "fine" } ] }
        """
        let d = try JSONDecoder().decode(DoctorReport.self, from: Data(doc.utf8))
        XCTAssertFalse(d.notifier.available)
        XCTAssertEqual(d.checks.count, 1)
    }

    func testErrorBodyDecodes() throws {
        let json = """
        { "error": { "code": "VERSION_CONFLICT", "message": "version conflict", "details": { "id": "t_1", "expectedVersion": 1, "currentVersion": 2 } } }
        """
        let e = try JSONDecoder().decode(APIErrorBody.self, from: Data(json.utf8))
        XCTAssertEqual(e.error.code, "VERSION_CONFLICT")
    }

    func testPayloadEncodesNullsAndOmissions() throws {
        var p = TaskPayload()
        p.set("title", "x")
        p.set("dueDate", nil as String?)
        p.setIfPresent("notes", nil as String?)
        p.setRule("repeat", .weekly(weekdays: [2]))
        let data = try JSONEncoder().encode(p.fields)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(obj["title"] as? String, "x")
        XCTAssertTrue(obj["dueDate"] is NSNull)
        XCTAssertNil(obj["notes"])
        XCTAssertEqual((obj["repeat"] as? [String: Any])?["kind"] as? String, "weekly")
    }

    func testDateParsing() {
        XCTAssertNotNil(TCDate.parse("2026-09-07T10:00:00.000Z"))
        XCTAssertNotNil(TCDate.parse("2026-09-07T10:00:00Z"))
        XCTAssertNotNil(TCDate.parse("2026-09-07T18:00:00+08:00"))
        XCTAssertNil(TCDate.parse("not a date"))
        let d = TCDate.parse("2026-09-07T10:00:00Z")!
        XCTAssertEqual(TCDate.iso(d), "2026-09-07T10:00:00.000Z")
        XCTAssertEqual(TCDate.addingDays(1, to: "2026-09-30"), "2026-10-01")
    }
}
