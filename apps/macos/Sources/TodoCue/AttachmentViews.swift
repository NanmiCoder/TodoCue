import AppKit
import SwiftUI
import UniformTypeIdentifiers
import ImageIO
import QuickLook
import TodoCueKit

enum AttachmentLimits {
    static let fileBytes = 10 * 1024 * 1024
    static let totalBytes = 30 * 1024 * 1024
    static let count = 20
    static func columns(for count: Int) -> Int { count <= 1 ? 1 : (count == 2 || count == 4 ? 2 : 3) }
}

struct PendingAttachment: Identifiable, Equatable, Sendable {
    let id = UUID()
    let name: String
    let mediaType: String
    let data: Data
    var payload: JSONValue { .object(["name": .string(name), "mediaType": .string(mediaType), "dataBase64": .string(data.base64EncodedString())]) }

    static func read(_ url: URL) async throws -> PendingAttachment {
        try await Task.detached(priority: .userInitiated) {
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
            guard values.isRegularFile == true else { throw APIError.transport("请选择文件，暂不支持文件夹") }
            guard (values.fileSize ?? 0) <= AttachmentLimits.fileBytes else { throw APIError.transport("「\(url.lastPathComponent)」超过 10 MB") }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: AttachmentLimits.fileBytes + 1) ?? Data()
            guard data.count <= AttachmentLimits.fileBytes else { throw APIError.transport("单个附件不能超过 10 MB") }
            return PendingAttachment(name: url.lastPathComponent, mediaType: values.contentType?.preferredMIMEType ?? "application/octet-stream", data: data)
        }.value
    }
}

enum AttachmentThumbnail {
    static func make(_ data: Data) -> NSImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 480,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { return nil }
        return NSImage(cgImage: image, size: .zero)
    }
}

struct AttachmentEditorView: View {
    @Binding var draft: TaskDraft
    @State private var choosing = false
    @Binding var loading: Bool
    @State private var error: String?
    private var kept: [TaskAttachment] { draft.existingAttachments.filter { !draft.removedAttachmentIds.contains($0.id) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("图片与附件", systemImage: "paperclip").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                Text("\(kept.count + draft.pendingAttachments.count) / 20").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
            if !kept.isEmpty {
                AttachmentGallery(attachments: kept, onRemove: { draft.removedAttachmentIds.insert($0.id) })
            }
            if !draft.pendingAttachments.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 2), spacing: 8) {
                    ForEach(draft.pendingAttachments) { item in
                        PendingAttachmentTile(item: item) { draft.pendingAttachments.removeAll { $0.id == item.id } }
                    }
                }
            }
            HStack(spacing: 8) {
                Button { choosing = true } label: { Label("添加附件", systemImage: "plus") }.buttonStyle(CueButtonStyle())
                Button("粘贴图片", action: paste).buttonStyle(CueButtonStyle())
                if loading { ProgressView().controlSize(.small) }
            }.disabled(loading)
            Text("支持图片和文件 · 单个 10 MB，总计 30 MB")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            if draft.repeatKind != .none { Text("附件仅保存到首次任务。") .font(.system(size: 11)).foregroundStyle(.secondary) }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(16).cueSurface()
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): add(urls)
            case .failure(let failure): error = failure.localizedDescription
            }
        }
    }

    private func add(_ urls: [URL]) {
        guard kept.count + draft.pendingAttachments.count + urls.count <= AttachmentLimits.count else { error = "每个任务最多 20 个附件"; return }
        error = nil
        loading = true
        Task { @MainActor in
            defer { loading = false }
            do {
                var items: [PendingAttachment] = []
                var bytes = kept.reduce(0) { $0 + $1.size } + draft.pendingAttachments.reduce(0) { $0 + $1.data.count }
                for url in urls {
                    let item = try await PendingAttachment.read(url)
                    bytes += item.data.count
                    guard bytes <= AttachmentLimits.totalBytes else { throw APIError.transport("附件总大小不能超过 30 MB") }
                    items.append(item)
                }
                draft.pendingAttachments.append(contentsOf: items)
            } catch { self.error = error.localizedDescription }
        }
    }

    private func paste() {
        guard let image = NSImage(pasteboard: .general), let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let data = rep.representation(using: .png, properties: [:]) else {
            error = "剪贴板里还没有图片"; return
        }
        guard data.count <= AttachmentLimits.fileBytes else { error = "图片超过 10 MB，请缩小后再添加"; return }
        guard kept.count + draft.pendingAttachments.count < AttachmentLimits.count,
              kept.reduce(0, { $0 + $1.size }) + draft.pendingAttachments.reduce(0, { $0 + $1.data.count }) + data.count <= AttachmentLimits.totalBytes else {
            error = "最多 20 个附件，总计 30 MB"; return
        }
        error = nil
        draft.pendingAttachments.append(PendingAttachment(name: "粘贴图片-\(draft.pendingAttachments.count + 1).png", mediaType: "image/png", data: data))
    }
}

private struct PendingAttachmentTile: View {
    let item: PendingAttachment
    let remove: () -> Void
    @State private var thumbnail: NSImage?
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ZStack {
                Color.primary.opacity(0.04)
                if let thumbnail { Image(nsImage: thumbnail).resizable().scaledToFit() }
                else { Image(systemName: "doc").foregroundStyle(.secondary) }
            }.frame(height: 84).clipShape(RoundedRectangle(cornerRadius: 10))
            HStack(alignment: .top, spacing: 2) {
                Text(item.name).lineLimit(2).font(.system(size: 11)).frame(maxWidth: .infinity, alignment: .leading)
                Button(action: remove) { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain)
                    .accessibilityLabel("移除待上传附件 \(item.name)")
            }
        }
        .task(id: item.id) { thumbnail = AttachmentThumbnail.make(item.data) }
    }
}

struct AttachmentGallery: View {
    let attachments: [TaskAttachment]
    var onRemove: ((TaskAttachment) -> Void)?
    private var images: [TaskAttachment] { attachments.filter(\.isImage) }
    private var files: [TaskAttachment] { attachments.filter { !$0.isImage } }
    var body: some View {
        VStack(spacing: 10) {
            if !images.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 7), count: AttachmentLimits.columns(for: images.count)), spacing: 7) {
                    ForEach(images) { AttachmentTile(attachment: $0, imageTile: true, onRemove: onRemove) }
                }
            }
            ForEach(files) { AttachmentTile(attachment: $0, imageTile: false, onRemove: onRemove) }
        }
    }
}

private struct AttachmentTile: View {
    @EnvironmentObject var model: AppModel
    let attachment: TaskAttachment
    let imageTile: Bool
    let onRemove: ((TaskAttachment) -> Void)?
    @State private var thumbnail: NSImage?
    @State private var previewURL: URL?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button { preview() } label: {
                if imageTile {
                    GeometryReader { geo in
                        ZStack {
                            Color.primary.opacity(0.045)
                            if let thumbnail { Image(nsImage: thumbnail).resizable().scaledToFill().frame(width: geo.size.width, height: geo.size.height).clipped() }
                            else { Image(systemName: error == nil ? "photo" : "exclamationmark.triangle").foregroundStyle(.secondary) }
                        }
                    }.aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else {
                    HStack(spacing: 10) {
                        Image(systemName: attachment.mediaType == "application/pdf" ? "doc.richtext" : "doc").font(.system(size: 23)).foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(attachment.name).font(.system(size: 12, weight: .medium)).lineLimit(2)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file)).font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "eye").foregroundStyle(.secondary)
                    }.padding(10).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                }
            }.buttonStyle(.plain).disabled(busy).accessibilityLabel("预览附件 \(attachment.name)")
            if imageTile { Text(attachment.name).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
            if let onRemove {
                Button("移除") { onRemove(attachment) }.font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("移除附件 \(attachment.name)")
            }
            if let error { Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(3) }
        }
        .contextMenu { Button("另存为…", action: save) }
        .quickLookPreview($previewURL)
        .task(id: attachment.sha256) {
            guard imageTile, let client = model.client else { return }
            do {
                thumbnail = AttachmentThumbnail.make(try await client.attachmentData(attachment))
                error = thumbnail == nil ? "无法生成缩略图，可预览或另存原文件" : nil
            }
            catch { self.error = "图片未加载，点击重试" }
        }
    }

    private func preview() {
        guard let client = model.client else { error = "离线，暂时无法预览"; return }
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let data = try await client.attachmentData(attachment)
                let root = FileManager.default.temporaryDirectory.appendingPathComponent("TodoCue-Previews", isDirectory: true)
                    .appendingPathComponent(attachment.id, isDirectory: true)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let url = root.appendingPathComponent((attachment.name as NSString).lastPathComponent)
                try data.write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                if imageTile { thumbnail = AttachmentThumbnail.make(data) }
                error = nil
                previewURL = url
            } catch { self.error = error.localizedDescription }
        }
    }

    private func save() {
        guard let client = model.client else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = attachment.name
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in
                do { try await client.attachmentData(attachment).write(to: url, options: .atomic) }
                catch { self.error = error.localizedDescription }
            }
        }
    }
}
