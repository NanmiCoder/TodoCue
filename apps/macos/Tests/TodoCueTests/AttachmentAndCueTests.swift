import XCTest
import AppKit
import TodoCueKit
@testable import TodoCue

final class AttachmentAndCueTests: XCTestCase {
    private let instant = "2026-09-08T01:00:00.000Z"
    private var now: Date { TCDate.parse(instant)! }
    private func task(status: TaskStatus = .todo) -> TodoTask {
        TodoTask(id: "t_cue", title: "看看图片", reminderAt: instant, timezone: "Asia/Shanghai", status: status, createdAt: instant, updatedAt: instant)
    }
    private func event(id: String = "r_1", at: String? = nil) throws -> RuntimeEvent {
        let value: [String: Any] = ["seq": 1, "type": "reminder.fired", "id": id, "at": at ?? instant,
            "related": ["taskId": "t_cue", "fireAt": instant, "count": "2", "late": "true"]]
        return try JSONDecoder().decode(RuntimeEvent.self, from: JSONSerialization.data(withJSONObject: value))
    }
    private func attachment() throws -> TaskAttachment {
        let data = Data(#"{"id":"a_1","taskId":"t_cue","name":"图.png","mediaType":"image/png","size":3,"sha256":"abc","createdAt":"2026-09-08T01:00:00Z"}"#.utf8)
        return try JSONDecoder().decode(TaskAttachment.self, from: data)
    }

    func testLegacyTasksDecodeWithoutAttachmentsAndNewMetadataRoundTrips() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(task())) as! [String: Any]
        object.removeValue(forKey: "attachments")
        let legacy = try JSONDecoder().decode(TodoTask.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(legacy.attachments.isEmpty)
        var new = legacy
        new.attachments = [try attachment()]
        XCTAssertEqual(try JSONDecoder().decode(TodoTask.self, from: JSONEncoder().encode(new)), new)
        XCTAssertTrue(new.attachments[0].isImage)
    }

    func testDraftPreservesAttachmentsAndCreatesAtomicAddRemovePatch() throws {
        var original = task()
        original.attachments = [try attachment()]
        var draft = TaskDraft(editing: original)
        XCTAssertEqual(draft.existingAttachments, original.attachments)
        XCTAssertNil(draft.updatePayload().fields["removeAttachmentIds"])
        draft.removedAttachmentIds.insert("a_1")
        let pending = PendingAttachment(name: "新图片.png", mediaType: "image/png", data: Data([0, 1, 255]))
        draft.pendingAttachments.append(pending)
        XCTAssertEqual(draft.updatePayload().fields["removeAttachmentIds"], .array([.string("a_1")]))
        XCTAssertEqual(draft.updatePayload().fields["addAttachments"], .array([pending.payload]))
        XCTAssertEqual(draft.createPayload().fields["attachments"], .array([pending.payload]))
        let submitted = draft
        XCTAssertEqual(submitted.saveIdempotencyKey, draft.saveIdempotencyKey)
    }

    func testAttachmentOnlyDraftIsRetainedAndLimitsCountExistingFiles() throws {
        var draft = TaskDraft()
        draft.pendingAttachments = [PendingAttachment(name: "note.txt", mediaType: "text/plain", data: Data())]
        XCTAssertTrue(draft.hasContent)
        draft.title = "资料"
        draft.existingAttachments = Array(repeating: try attachment(), count: 20)
        XCTAssertEqual(draft.validate(), "每个任务最多 20 个附件")
        draft.existingAttachments = []
        draft.pendingAttachments = Array(repeating: PendingAttachment(name: "big", mediaType: "application/octet-stream", data: Data(count: AttachmentLimits.fileBytes)), count: 4)
        XCTAssertEqual(draft.validate(), "附件总大小不能超过 30 MB")
    }

    func testGalleryUsesTriptychAndFourSquareLayout() {
        XCTAssertEqual((0...6).map(AttachmentLimits.columns), [1, 1, 2, 3, 2, 3, 3])
    }

    func testFileImportCopiesBytesAndRejectsFoldersAndOversizeFiles() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("文件.txt")
        try Data("original".utf8).write(to: file)
        let pending = try await PendingAttachment.read(file)
        try Data("changed".utf8).write(to: file)
        XCTAssertEqual(pending.data, Data("original".utf8))
        do { _ = try await PendingAttachment.read(dir); XCTFail("must reject folders") } catch {}
        try Data(count: AttachmentLimits.fileBytes + 1).write(to: file)
        do { _ = try await PendingAttachment.read(file); XCTFail("must reject oversize files") } catch {}
    }

    func testFullscreenQuietDetectionIncludesNotchSafeAreaAndChecksScreenPosition() {
        let screen = CGRect(x: 0, y: 0, width: 1728, height: 1117)
        XCTAssertTrue(NotchLayout.coversScreen(screen, screen: screen, topInset: 32))
        // Actual macOS 26 fullscreen Finder: Y=33, height=1084 in WindowServer coordinates.
        XCTAssertTrue(NotchLayout.coversScreen(CGRect(x: 0, y: 0, width: 1728, height: 1084), screen: screen, topInset: 32))
        XCTAssertFalse(NotchLayout.coversScreen(CGRect(x: 0, y: 60, width: 1728, height: 1024), screen: screen, topInset: 32))
        XCTAssertFalse(NotchLayout.coversScreen(CGRect(x: 0, y: 1065, width: 1728, height: 52), screen: screen, topInset: 32))
        XCTAssertFalse(NotchLayout.coversScreen(CGRect(x: 1728, y: 0, width: 1728, height: 1084), screen: screen, topInset: 32))
        let secondary = CGRect(x: -1728, y: 200, width: 1728, height: 1117)
        XCTAssertTrue(NotchLayout.coversScreen(CGRect(x: -1728, y: 200, width: 1728, height: 1084), screen: secondary, topInset: 32))
    }

    func testCueRejectsStaleCompletedAndRescheduledTasks() throws {
        XCTAssertNotNil(ReminderCue.from(try event(), task: task(), now: now))
        XCTAssertNil(ReminderCue.from(try event(), task: task(status: .done), now: now))
        XCTAssertNil(ReminderCue.from(try event(), task: task(status: .cancelled), now: now))
        XCTAssertNil(ReminderCue.from(try event(at: "2026-09-08T00:55:00.000Z"), task: task(), now: now))
        XCTAssertNil(ReminderCue.from(try event(at: "2026-09-08T02:00:00.000Z"), task: task(), now: now))
        var moved = task(); moved.reminderAt = "2026-09-09T01:00:00.000Z"
        XCTAssertNil(ReminderCue.from(try event(), task: moved, now: now))
        let cue = ReminderCue.from(try event(), task: task(), now: now)!
        XCTAssertTrue(cue.late)
        XCTAssertEqual(cue.count, 2)
    }

    func testCueQueueIsFIFOAndDoesNotReplayAfterDismissal() throws {
        var queue = ReminderCueQueue()
        let first = ReminderCue.from(try event(), task: task(), now: now)!
        let second = ReminderCue.from(try event(id: "r_2"), task: task(), now: now)!
        queue.append(first, now: now); queue.append(first, now: now); queue.append(second, now: now)
        XCTAssertEqual(queue.next(now: now)?.id, first.id)
        queue.append(first, now: now)
        XCTAssertEqual(queue.next(now: now)?.id, second.id)
        XCTAssertNil(queue.next(now: now))
        queue.append(ReminderCue.from(try event(id: "r_3"), task: task(), now: now)!, now: now)
        XCTAssertNil(queue.next(now: now.addingTimeInterval(121)))
    }

    func testCueQueueStaysBoundedAndClearsOnDisable() throws {
        var queue = ReminderCueQueue()
        for i in 0..<30 { queue.append(ReminderCue.from(try event(id: "r_\(i)"), task: task(), now: now)!, now: now) }
        XCTAssertEqual(queue.pending.count, 20)
        queue.clear()
        XCTAssertNil(queue.next(now: now))
    }

    func testMotionIsDeterministicBoundedAndStillWhenReduceMotionIsOn() {
        let rest = CueMotion.Pose(scaleX: 1, scaleY: 1, offsetY: 0, rotation: 0)
        for time in stride(from: 0.0, through: 2, by: 0.01) {
            let pose = CueMotion.pose(at: time, reduceMotion: false)
            XCTAssertEqual(CueMotion.pose(at: time, reduceMotion: true), rest)
            XCTAssertTrue((0.85...1.15).contains(pose.scaleX))
            XCTAssertTrue((-8...3).contains(pose.offsetY))
            XCTAssertEqual(pose, CueMotion.pose(at: time, reduceMotion: false))
        }
        XCTAssertEqual(CueMotion.pose(at: 0.9, reduceMotion: false), rest)
        XCTAssertEqual(CueMotion.pose(at: 0, reduceMotion: false), rest)
    }

    @MainActor func testInvalidImageHasSafeThumbnailFallbackAndCueWindowCannotStealFocus() async {
        XCTAssertNil(AttachmentThumbnail.make(Data("not an image".utf8)))
        let window = NotchWindow(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        XCTAssertFalse(window.canBecomeKey)
        XCTAssertFalse(window.canBecomeMain)
    }
}
