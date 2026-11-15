import FileProvider
import Foundation
import Testing
@testable import FdriveKit

/// How the stub server answers one kind of request.
private enum Reply: Sendable {
    case status(Int)
    /// A completed operation whose receipt is this entry.
    case receipt(RemoteEntry)
    case ready
    case unreachable
}

private final class DeleteServer: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var replies: [String: Reply] = [:]
    nonisolated(unsafe) private static var seen: [(route: String, body: [String: Any])] = []
    /// Each request is answered by the reply for the last segment of its path.
    static func answer(_ replies: [String: Reply]) { lock.withLock { self.replies = replies; seen = [] } }
    static var calls: [String] { lock.withLock { seen.map(\.route) } }
    static var bodies: [[String: Any]] { lock.withLock { seen.map(\.body) } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private var body: [String: Any] {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var read = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                read.append(buffer, count: count)
            }
            data = read
        }
        return data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
    }
    private func reply(_ status: Int, _ text: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                              headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func startLoading() {
        let parts = (request.url?.path ?? "").split(separator: "/").map(String.init)
        let route = parts.last ?? "", body = self.body
        let operation = parts.firstIndex(of: "operations").map { parts[$0 + 1] } ?? body["operationId"] as? String ?? ""
        let answer = Self.lock.withLock { Self.seen.append((route, body)); return Self.replies[route] ?? .status(500) }
        func result(_ state: String, _ item: RemoteEntry?) -> String {
            let entry = item.map { String(decoding: try! JSONEncoder().encode($0), as: UTF8.self) } ?? "null"
            return "{\"operationId\":\"\(operation)\",\"state\":\"\(state)\",\"item\":\(entry),\"recoveryId\":null}"
        }
        switch answer {
        case .unreachable: client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        case .ready: reply(200, result("ready", nil))
        case .receipt(let entry): reply(200, result("completed", entry))
        case .status(let status) where route == "purges" && status == 200: reply(200, "{\"ok\":true}")
        case .status(let status) where route == "cancel" && status == 200: reply(200, result("cancelled", nil))
        case .status(let status): reply(status, "{\"error\":{\"kind\":\"refused\",\"message\":\"Refused\"}}")
        }
    }
    override func stopLoading() {}
}

/// What macOS is handed, standing in for the extension's own item.
private final class Shown: NSObject, NSFileProviderItem {
    let record: CatalogItem
    init(_ record: CatalogItem) { self.record = record }
    var itemIdentifier: NSFileProviderItemIdentifier { .init(record.id) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { record.parentId == "trash" ? .trashContainer : .init(record.parentId) }
    var filename: String { record.entry.name }
}

private let full = WriteCapabilities(create: true, update: true, move: true, trash: true, restore: true)
private func entry(_ path: String, kind: String = "file", trashed: Bool = false, parent: String = "root") -> RemoteEntry {
    let id = UUID().uuidString.lowercased()
    var entry = RemoteEntry(path: path, name: String(path.split(separator: "/").last!), kind: kind, size: kind == "dir" ? 0 : 5)
    entry.id = id; entry.parentId = parent; entry.version = WriteVersion(content: "digest", metadata: "m-\(id)")
    entry.trashed = trashed; entry.capabilities = full.forEntry(entry)
    return entry
}
/// The same item as the server's Trash shows it: under its handle, with its name kept.
private func inTrash(_ live: RemoteEntry) -> RemoteEntry {
    var moved = live
    let name = live.name as NSString
    moved.path = RemoteEntry.trashPath + "/" + live.id!
    moved.name = "\(name.deletingPathExtension) (deleted \(live.id!.prefix(8))).\(name.pathExtension)"
    moved.parentId = "trash"; moved.trashed = true; moved.capabilities = full.forEntry(moved)
    return moved
}

private struct Location {
    let writer: WriteCoordinator, directory: URL, session: URLSession
    let doc: RemoteEntry, folder: RemoteEntry, binned: RemoteEntry, binnedFolder: RemoteEntry, nested: RemoteEntry
    var catalog: Catalog { writer.catalog }
    init(_ replies: [String: Reply]) async throws {
        DeleteServer.answer(replies)
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Deletes")
        try await catalog.configure(full)
        doc = entry("/doc.txt"); folder = entry("/Folder", kind: "dir")
        try await catalog.reconcile([doc, folder], folder: "/")
        let trash = RemoteEntry.trashPath
        binned = inTrash(entry("/gone.txt"))
        var shelved = entry("\(trash)/x", kind: "dir", trashed: true, parent: "trash")
        shelved.path = "\(trash)/\(shelved.id!)"; shelved.name = "Old (deleted \(shelved.id!.prefix(8)))"
        binnedFolder = shelved
        try await catalog.reconcile([binned, binnedFolder], folder: trash)
        nested = entry("\(binnedFolder.path)/child.txt", trashed: true, parent: binnedFolder.id!)
        try await catalog.reconcile([nested], folder: binnedFolder.path)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeleteServer.self]
        session = URLSession(configuration: configuration)
        let client = try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test",
                                   session: session, protocolVersion: 2)
        writer = WriteCoordinator(catalog: catalog, client: client, maxUploadBytes: 1 << 20)
    }
    func item(_ remote: RemoteEntry) async throws -> CatalogItem { try await catalog.itemAt(remote.path) }
    func delete(_ remote: RemoteEntry) async throws -> DeleteOutcome {
        let item = try await item(remote)
        return await writer.delete(item.id, base: WriteVersion(content: item.contentVersion, metadata: item.metadataVersion))
    }
    func outstanding() async throws -> [PendingWrite] { try await catalog.pendingWrites().filter { $0.result == nil } }
    func close() { session.invalidateAndCancel(); try? FileManager.default.removeItem(at: directory) }
}

/// The answer macOS gets for a kept item: the rejection that puts it back and is never retried.
private func expectPutBack(_ outcome: DeleteOutcome, as expected: CatalogItem, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(outcome == .kept(expected), sourceLocation: sourceLocation)
    let error = deleteAnswer(outcome) { Shown($0) } as NSError?
    #expect(error?.domain == NSFileProviderErrorDomain, sourceLocation: sourceLocation)
    #expect(error?.code == NSFileProviderError.deletionRejected.rawValue, sourceLocation: sourceLocation)
    let shown = error?.userInfo[NSFileProviderErrorItemKey] as? NSFileProviderItem
    #expect(shown?.itemIdentifier.rawValue == expected.id, sourceLocation: sourceLocation)
}

/// What can go wrong for a delete, each one refused.
enum Refusal: String, CaseIterable, Sendable {
    case serverError, unreachable, conflict, oldServer, purgeUnreachable, insideTrashItem, pendingSave, pendingCreateInside, root
}

/// Serialized: every case drives the one stub.
@Suite(.serialized, .timeLimit(.minutes(1))) struct DeleteTests {
    // macOS retries a delete that fails with anything but a rejection, forever: one
    // location retried about 650 deletes. Every refusal puts the item back instead, as it
    // stands, leaves nothing pending, and keeps every write this Mac has not finished.
    @Test(arguments: Refusal.allCases)
    func aRefusedDeleteNeverAnswersWithARetryableError(_ refusal: Refusal) async throws {
        let replies: [String: Reply] = switch refusal {
        case .serverError: ["moves": .status(500), "cancel": .status(200)]
        case .unreachable: ["moves": .unreachable, "cancel": .unreachable]
        case .conflict: ["moves": .ready, "commit": .status(409), "cancel": .status(200)]
        case .oldServer: ["purges": .status(404)]
        case .purgeUnreachable: ["purges": .unreachable]
        default: [:]
        }
        let location = try await Location(replies); defer { location.close() }
        var target = location.doc
        var waiting: [PendingWrite] = []
        switch refusal {
        case .oldServer, .purgeUnreachable: target = location.binned
        case .insideTrashItem: target = location.nested
        case .root: target = RemoteEntry(path: "/", name: "Deletes", kind: "dir")
        case .pendingSave:
            let doc = try await location.item(location.doc)
            waiting = [try await location.catalog.beginWrite(PendingWrite(id: "save", key: "save", localId: doc.id, route: "uploads",
                request: WriteRequest(operationId: "save", itemId: doc.entry.id, parentId: "root", name: doc.entry.name, base: nil)))]
        case .pendingCreateInside:
            target = location.folder
            waiting = [try await location.catalog.beginWrite(PendingWrite(id: "create", key: "create", localId: UUID().uuidString, route: "uploads",
                request: WriteRequest(operationId: "create", itemId: nil, parentId: location.folder.id!, name: "new.txt", base: nil)))]
        default: break
        }
        let before = try await location.item(target)
        expectPutBack(try await location.delete(target), as: before)
        #expect(try await location.item(target) == before)
        #expect(try await location.outstanding().map(\.id) == waiting.map(\.id))
        let asked: [String] = switch refusal {
        case .serverError: ["moves", "cancel"]
        case .unreachable: ["moves", "cancel"]
        case .conflict: ["moves", "commit", "cancel"]
        case .oldServer, .purgeUnreachable: ["purges"]
        default: []
        }
        #expect(DeleteServer.calls == asked)
    }

    // Delete Immediately, or an app removing a file: it moves to fdrive's Trash, and macOS
    // is told to put it back there, where it stays for Days in Trash.
    @Test func aDeleteMovesALiveItemToTrashAndPutsItBackThere() async throws {
        let location = try await Location(["moves": .ready])
        defer { location.close() }
        DeleteServer.answer(["moves": .ready, "commit": .receipt(inTrash(location.doc)), "acknowledge": .receipt(inTrash(location.doc))])
        let original = try await location.item(location.doc)
        let outcome = try await location.delete(location.doc)
        let kept = try await location.catalog.item(original.id)
        #expect(kept.parentId == "trash" && kept.entry.trashed == true)
        expectPutBack(outcome, as: kept)
        let shown = (deleteAnswer(outcome) { Shown($0) } as NSError?)?.userInfo[NSFileProviderErrorItemKey] as? NSFileProviderItem
        #expect(shown?.parentItemIdentifier == .trashContainer)
        #expect(DeleteServer.calls == ["moves", "commit", "acknowledge"])
        #expect(DeleteServer.bodies.first?["parentId"] as? String == "trash")
        #expect(try await location.outstanding().isEmpty)
    }

    // Empty Trash, or a delete in Finder's Trash: a whole Trash item is deleted for good,
    // with everything known inside it, and macOS hears it is gone.
    @Test func emptyingTrashDeletesAWholeTrashItemForGood() async throws {
        let location = try await Location(["purges": .status(200)]); defer { location.close() }
        let folder = try await location.item(location.binnedFolder), child = try await location.item(location.nested)
        let outcome = try await location.delete(location.binnedFolder)
        #expect(outcome == .deleted)
        #expect(deleteAnswer(outcome) { Shown($0) } == nil)
        #expect(DeleteServer.calls == ["purges"])
        #expect(DeleteServer.bodies.first?["itemId"] as? String == location.binnedFolder.id)
        await #expect(throws: DriveError.missing) { try await location.catalog.item(folder.id) }
        await #expect(throws: DriveError.missing) { try await location.catalog.item(child.id) }
        // The working set reports both gone, so macOS keeps nothing of them.
        #expect(Set(try await location.catalog.changes(since: 0).deleted).isSuperset(of: [folder.id, child.id]))
        // Something macOS knows that this Mac never did was never this location's to keep.
        #expect(await location.writer.delete(UUID().uuidString, base: WriteVersion(content: "c", metadata: "m")) == .deleted)
        #expect(DeleteServer.calls == ["purges"])
    }

    // A move to Trash takes everything inside along, so Finder's Move to Trash waits for a
    // new item still being created inside, as a delete does.
    @Test func aMoveToTrashWaitsForAWriteInsideIt() async throws {
        let location = try await Location([:]); defer { location.close() }
        _ = try await location.catalog.beginWrite(PendingWrite(id: "create", key: "create", localId: UUID().uuidString, route: "uploads",
            request: WriteRequest(operationId: "create", itemId: nil, parentId: location.folder.id!, name: "new.txt", base: nil)))
        let folder = try await location.item(location.folder)
        #expect(try await location.catalog.hasPendingWrite(within: folder))
        #expect(try await !location.catalog.hasPendingWrite(within: location.item(location.doc)))
        await #expect(throws: DriveError.unavailable) {
            _ = try await location.writer.perform(route: "moves", localId: folder.id, templateKey: folder.id, parentId: "trash",
                name: folder.entry.name, base: WriteVersion(content: folder.contentVersion, metadata: folder.metadataVersion),
                contents: nil, progress: Progress(totalUnitCount: -1))
        }
        #expect(DeleteServer.calls.isEmpty)
    }
}
