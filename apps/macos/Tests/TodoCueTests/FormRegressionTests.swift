import XCTest
import AppKit
import SwiftUI
import TodoCueKit
@testable import TodoCue

private final class FormAPIProtocol: URLProtocol {
    static var respond: ((FormAPIProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.respond?(self) }
    override func stopLoading() {}

    func reply(_ object: Any, status: Int = 200) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    var body: [String: Any] {
        if let data = request.httpBody { return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

final class FormRegressionTests: XCTestCase {
    private func task(_ id: String = "editing", notes: String = "上一条备注", version: Int = 1) -> TodoTask {
        TodoTask(id: id, title: "任务 \(id)", notes: notes, timezone: "Asia/Shanghai", version: version,
                 createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z")
    }
    private func envelope(_ task: TodoTask) -> [String: Any] {
        ["task": try! JSONSerialization.jsonObject(with: JSONEncoder().encode(task))]
    }
    @MainActor private func apiModel() -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FormAPIProtocol.self]
        return AppModel(client: APIClient(baseURL: URL(string: "http://fixture.invalid")!, token: "fixture",
                                         session: URLSession(configuration: config)))
    }
    @MainActor private func form(_ model: AppModel) throws -> TaskDraft {
        guard case .form(let draft) = model.routes.last else { throw XCTUnwrapError() }
        return draft
    }
    private struct XCTUnwrapError: Error {}

    @MainActor func testEditingDraftNeverBecomesANewTaskAndIsRetainedPerTask() throws {
        let model = AppModel()
        model.edit(task("a"))
        var first = try form(model)
        first.notes = "正在编辑 A"
        model.updateFormDraft(first)
        model.pop()
        XCTAssertNil(model.savedDraft)
        model.newTask()
        let fresh = try form(model)
        XCTAssertFalse(fresh.isEditing)
        XCTAssertTrue(fresh.title.isEmpty)
        XCTAssertTrue(fresh.notes.isEmpty)
        XCTAssertNotEqual(fresh.saveIdempotencyKey, first.saveIdempotencyKey)
        model.edit(task("b"))
        XCTAssertEqual(try form(model).notes, "上一条备注")
        model.pop()
        model.edit(task("a"))
        XCTAssertEqual(try form(model), first)
    }

    @MainActor func testNewTaskShortcutLeavesAnEditAndClearedCreationDraftStaysEmpty() throws {
        let model = AppModel()
        model.edit(task())
        model.newTask()
        XCTAssertFalse(try form(model).isEditing)
        var draft = try form(model)
        draft.notes = "稍后删除"
        model.updateFormDraft(draft)
        model.pop()
        model.newTask()
        draft.notes = ""
        model.updateFormDraft(draft)
        model.pop()
        XCTAssertNil(model.savedDraft)
        model.newTask()
        XCTAssertTrue(try form(model).notes.isEmpty)
    }

    @MainActor func testTypedQuickAddDoesNotInheritNotesAttachmentsOrOldDate() throws {
        let model = AppModel()
        var old = TaskDraft()
        old.title = "旧草稿"; old.notes = "旧备注"
        old.pendingAttachments = [PendingAttachment(name: "old.txt", mediaType: "text/plain", data: Data([1]))]
        old.scheduledMode = .date
        old.scheduledDate = TCDate.parseLocalDate("2020-01-01")!
        model.savedDraft = old
        model.quickAddText = "全新任务"
        model.expandQuickAdd()
        let fresh = try form(model)
        XCTAssertEqual(fresh.title, "全新任务")
        XCTAssertTrue(fresh.notes.isEmpty)
        XCTAssertTrue(fresh.pendingAttachments.isEmpty)
        XCTAssertEqual(TCDate.localDateString(fresh.scheduledDate), TCDate.todayString())
        XCTAssertEqual(model.savedDraft, old)
        model.openToday()
        model.quickAddText = "日历中的新任务"
        model.expandQuickAdd(on: "2026-12-24")
        XCTAssertEqual(TCDate.localDateString(try form(model).scheduledDate), "2026-12-24")
    }

    @MainActor func testOldFormUpdatesCannotOverwriteAnotherTask() throws {
        let model = AppModel()
        model.edit(task("a"))
        var first = try form(model)
        first.notes = "未保存的编辑"
        model.updateFormDraft(first)
        model.openToday()
        model.edit(task("b"))
        let second = try form(model)
        first.notes = "导入附件后完成的旧表单更新"
        model.updateFormDraft(first)
        XCTAssertEqual(try form(model), second)
        model.pop()
        model.edit(task("a"))
        XCTAssertEqual(try form(model), first)
    }

    @MainActor func testUntouchedEditReopensWithLatestTaskAndCoveredEditSurvivesNavigation() throws {
        let model = AppModel()
        model.edit(task(version: 1))
        model.pop()
        model.edit(task(notes: "最新内容", version: 2))
        XCTAssertEqual(try form(model).notes, "最新内容")
        XCTAssertEqual(try form(model).version, 2)
        var draft = try form(model); draft.notes = "有修改才保留"
        model.updateFormDraft(draft)
        model.routes.append(.settings)
        model.newTask()
        XCTAssertFalse(try form(model).isEditing)
        model.edit(task(notes: "最新内容", version: 2))
        XCTAssertEqual(try form(model).notes, draft.notes)
    }

    @MainActor func testSuccessfulSaveClearsOnlySubmittedDraftAndItsRoute() async throws {
        let model = apiModel()
        defer { FormAPIProtocol.respond = nil }
        FormAPIProtocol.respond = { request in request.reply(self.envelope(self.task())) }
        var creation = TaskDraft(); creation.title = "另一个未保存任务"
        model.savedDraft = creation
        model.edit(task())
        let submitted = try form(model)
        try await model.save(submitted)
        XCTAssertEqual(model.savedDraft, creation)
        XCTAssertFalse(model.routes.contains(.form(submitted)))
        model.edit(task(version: 2))
        XCTAssertEqual(try form(model).version, 2)
    }

    @MainActor func testSuccessfulCreationStartsNextTaskWithEmptyNotesAndNewIdentity() async throws {
        let model = apiModel()
        defer { FormAPIProtocol.respond = nil }
        FormAPIProtocol.respond = { request in request.reply(self.envelope(self.task("created"))) }
        model.newTask()
        var submitted = try form(model)
        submitted.title = "第一条任务"; submitted.notes = "第一条描述"
        model.updateFormDraft(submitted)
        try await model.save(submitted)
        model.newTask()
        let next = try form(model)
        XCTAssertTrue(next.title.isEmpty)
        XCTAssertTrue(next.notes.isEmpty)
        XCTAssertNotEqual(next.saveIdempotencyKey, submitted.saveIdempotencyKey)
    }

    @MainActor func testSaveFinishingAfterNavigationDoesNotDismissANewForm() async throws {
        let model = apiModel()
        defer { FormAPIProtocol.respond = nil }
        var submitted = TaskDraft(); submitted.title = "正在保存的任务"; submitted.notes = "不应再次出现"
        model.presentForm(submitted)
        let started = expectation(description: "request started")
        var pending: FormAPIProtocol?
        FormAPIProtocol.respond = { request in pending = request; started.fulfill() }
        let save = Task { try await model.save(submitted) }
        await fulfillment(of: [started], timeout: 2)
        model.pop()
        model.quickAddText = "另一个新任务"
        model.expandQuickAdd()
        let replacement = try form(model)
        pending?.reply(envelope(task("created")))
        try await save.value
        XCTAssertEqual(try form(model), replacement)
        XCTAssertNil(model.savedDraft)
    }

    @MainActor func testConflictPreservesDraftAndExplicitReloadUsesLatestVersion() async throws {
        let model = apiModel()
        defer { FormAPIProtocol.respond = nil }
        model.edit(task())
        var stale = try form(model); stale.notes = "本地修改，请先保留"
        model.updateFormDraft(stale)
        FormAPIProtocol.respond = { request in
            request.reply(["error": ["code": "VERSION_CONFLICT", "message": "changed"]], status: 409)
        }
        do { try await model.save(stale); XCTFail("must report a conflict") }
        catch let error as APIError { XCTAssertTrue(error.isVersionConflict) }
        XCTAssertEqual(try form(model), stale)
        let latest = task(notes: "外部的新备注", version: 3)
        FormAPIProtocol.respond = { request in request.reply(self.envelope(latest)) }
        try await model.reloadForm(stale)
        let reloaded = try form(model)
        XCTAssertEqual(reloaded.version, 3)
        XCTAssertEqual(reloaded.notes, latest.notes)
        XCTAssertNotEqual(reloaded.saveIdempotencyKey, stale.saveIdempotencyKey)
        FormAPIProtocol.respond = { request in
            XCTAssertEqual(request.body["expectedVersion"] as? Int, 3)
            request.reply(self.envelope(self.task(version: 4)))
        }
        try await model.save(reloaded)
        XCTAssertTrue(model.routes.isEmpty)
    }

    func testAttachmentBatchIsAtomicAtBothLimits() throws {
        let tiny = PendingAttachment(name: "tiny", mediaType: "text/plain", data: Data([1]))
        var draft = TaskDraft()
        draft.pendingAttachments = Array(repeating: tiny, count: 19)
        XCTAssertThrowsError(try draft.addAttachments([tiny, tiny]))
        XCTAssertEqual(draft.pendingAttachments.count, 19)
        try draft.addAttachments([tiny])
        XCTAssertEqual(draft.pendingAttachments.count, 20)
        let large = PendingAttachment(name: "large", mediaType: "application/octet-stream", data: Data(count: AttachmentLimits.fileBytes))
        draft.pendingAttachments = [large, large]
        XCTAssertThrowsError(try draft.addAttachments([large, tiny]))
        XCTAssertEqual(draft.pendingAttachments.count, 2)
        try draft.addAttachments([large])
        XCTAssertEqual(draft.pendingAttachments.count, 3)
    }
}
