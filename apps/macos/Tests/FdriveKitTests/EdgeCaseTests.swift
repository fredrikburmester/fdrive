import Foundation
import Testing
@testable import FdriveKit

private func edgeFixture() throws -> (Catalog, URL) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    return (try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Edge"), directory)
}
private func handle(_ path: String, id: String, kind: String = "file", size: Int64 = 5) -> RemoteEntry {
    var entry = RemoteEntry(path: path, name: String(path.split(separator: "/").last!), kind: kind, size: size,
                            modifiedAt: "2026-09-14T10:00:00.000Z")
    entry.id = id; entry.parentId = "root"
    entry.version = WriteVersion(content: "unverified:" + id, metadata: "meta:" + id)
    entry.capabilities = WriteCapabilities(create: true, update: true, move: true, trash: true, restore: true)
    return entry
}

// Cases 32, 35, 36: a server handle change at an unchanged path is a delete plus
// recreate. Cached bytes of the old item must never be served for the new one.
@Test func reassignedRemoteHandleCreatesANewItemAndTombstonesTheOld() async throws {
    let (catalog, directory) = try edgeFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = UUID().uuidString.lowercased(), second = UUID().uuidString.lowercased(), third = UUID().uuidString.lowercased()
    try await catalog.reconcile([handle("/a", id: first)], folder: "/")
    let original = try await catalog.itemAt("/a")
    _ = try await catalog.downloaded(original.id, hash: "old-bytes", size: 5)
    let anchor = try await catalog.revision()
    try await catalog.reconcile([handle("/a", id: second)], folder: "/")
    let recreated = try await catalog.itemAt("/a")
    #expect(recreated.id != original.id)
    #expect(recreated.entry.id == second)
    #expect(!recreated.materialized && recreated.contentVersion != "old-bytes")
    #expect(try await catalog.changes(since: anchor).deleted == [original.id])
    // A kind transition at the same path is also a new item.
    let kindAnchor = try await catalog.revision()
    try await catalog.reconcile([handle("/a", id: third, kind: "dir", size: 0)], folder: "/")
    let folder = try await catalog.itemAt("/a")
    #expect(folder.id != recreated.id && folder.entry.kind == "dir")
    #expect(try await catalog.changes(since: kindAnchor).deleted == [recreated.id])
    // Path-only (protocol 1) entries keep identity when only metadata repeats.
    let plain = RemoteEntry(path: "/plain", name: "plain", kind: "file", size: 1)
    try await catalog.reconcile([plain], folder: "/")
    let plainItem = try await catalog.itemAt("/plain")
    try await catalog.reconcile([plain], folder: "/")
    #expect(try await catalog.itemAt("/plain").id == plainItem.id)
}

// Cases 22, 33, 36: an external rename whose old path is reused by a new item must keep
// both entries, with the cached content following the server handle, in either page order.
@Test func movedHandleWithReusedPathKeepsBothItemsInEitherOrder() async throws {
    let moved = UUID().uuidString.lowercased(), fresh = UUID().uuidString.lowercased()
    for reversed in [false, true] {
        let (catalog, directory) = try edgeFixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await catalog.reconcile([handle("/a", id: moved)], folder: "/")
        let original = try await catalog.itemAt("/a")
        _ = try await catalog.downloaded(original.id, hash: "moved-bytes", size: 5)
        let listing = [handle("/a", id: fresh), handle("/b", id: moved)]
        try await catalog.reconcile(reversed ? listing.reversed() : listing, folder: "/")
        let children = try await catalog.children("root")
        #expect(children.count == 2, "order reversed: \(reversed)")
        let atB = try await catalog.itemAt("/b"), atA = try await catalog.itemAt("/a")
        #expect(atB.id == original.id && atB.materialized && atB.contentVersion == "moved-bytes")
        #expect(atA.id != original.id && atA.entry.id == fresh && !atA.materialized)
    }
}

// Case 30: a remote entry named like the synthetic recovery container cannot share the
// root folder with it. The listing fails visibly instead of merging or hiding an item.
@Test func remoteTrashNameCollidesWithTheRecoveryContainer() async throws {
    let (catalog, directory) = try edgeFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let real = RemoteEntry(path: "/.Trash", name: ".Trash", kind: "dir")
    try await catalog.reconcile([real], folder: "/")
    try await catalog.configure(WriteCapabilities(create: true, update: true, move: true, trash: true, restore: true))
    let revision = try await catalog.revision()
    for name in [".Trash", ".trash"] {
        await #expect(throws: DriveError.self) {
            try await catalog.reconcile([RemoteEntry(path: "/" + name, name: name, kind: "dir")], folder: "/")
        }
    }
    #expect(try await catalog.revision() == revision)
    try await catalog.reconcile([RemoteEntry(path: "/sub", name: "sub", kind: "dir")], folder: "/")
    try await catalog.reconcile([RemoteEntry(path: "/sub/.Trash", name: ".Trash", kind: "dir")], folder: "/sub")
}

// Case 72: moving a folder into its own descendant is refused natively, before any
// pending record or request exists, not only by the server at commit.
@Test func movingAFolderIntoItsOwnDescendantIsRejectedBeforeAnyRequest() async throws {
    let (catalog, directory) = try edgeFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let outer = handle("/outer", id: UUID().uuidString.lowercased(), kind: "dir", size: 0)
    try await catalog.reconcile([outer], folder: "/")
    var inner = handle("/outer/inner", id: UUID().uuidString.lowercased(), kind: "dir", size: 0)
    inner.parentId = outer.id
    try await catalog.reconcile([inner], folder: "/outer")
    let outerItem = try await catalog.itemAt("/outer"), innerItem = try await catalog.itemAt("/outer/inner")
    let client = try APIClient(server: URL(string: "http://127.0.0.1:1")!, protocolVersion: 2)
    let coordinator = WriteCoordinator(catalog: catalog, client: client)
    for destination in [innerItem.id, outerItem.id] {
        await #expect(throws: DriveError.unsupported) {
            _ = try await coordinator.perform(route: "moves", localId: outerItem.id, templateKey: outerItem.id, parentId: destination,
                name: "outer", base: WriteVersion(content: outerItem.contentVersion, metadata: outerItem.metadataVersion),
                contents: nil, progress: Progress(totalUnitCount: -1))
        }
    }
    #expect(try await catalog.pendingWrites().isEmpty)
}

// Cases 42, 49, 68: a transfer that cannot fit on the local volume fails with a distinct
// local error before any bytes move, never as a server outage or remote quota.
@Test func transfersRefuseToFillTheLocalDisk() throws {
    let directory = FileManager.default.temporaryDirectory
    try requireFreeSpace(1, at: directory)
    #expect(throws: DriveError.diskFull) { try requireFreeSpace(Int64.max, at: directory) }
    #expect(throws: DriveError.diskFull) { try requireFreeSpace(0, at: directory, headroom: Int64.max) }
    #expect(throws: (any Error).self) { try requireFreeSpace(1, at: directory.appendingPathComponent(UUID().uuidString)) }
}

private final class Transport: @unchecked Sendable {
    let lock = NSLock()
    var requests: [URLRequest] = []
    var bodies: [(Int, String)]
    init(_ bodies: [(Int, String)]) { self.bodies = bodies }
    func respond(_ request: URLRequest) -> (Int, String) {
        lock.withLock { requests.append(request); return bodies.isEmpty ? (500, "{}") : bodies.removeFirst() }
    }
}
private final class TransportProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var transport: Transport?
    static func use(_ transport: Transport) { lock.withLock { self.transport = transport } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.lock.withLock { Self.transport! }.respond(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private func mockClient(_ transport: Transport) throws -> (APIClient, URLSession) {
    TransportProtocol.use(transport)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [TransportProtocol.self]
    let session = URLSession(configuration: configuration)
    return (try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test", session: session, protocolVersion: 2), session)
}

// Case 84: reimporting a local file whose bytes match the remote item acknowledges that
// item. Differing bytes are never uploaded over it, and absent bytes never replace it.
@Test func reimportAcknowledgesMatchingRemoteBytesWithoutAConflictCopy() async throws {
    let (catalog, directory) = try edgeFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("doc.txt")
    try Data("hello".utf8).write(to: file)
    let remoteId = UUID().uuidString.lowercased()
    let listing = String(decoding: try JSONEncoder().encode(Listing(entries: [handle("/doc.txt", id: remoteId)], nextCursor: nil)), as: UTF8.self)
    let sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    let versions = "{\"items\":[{\"path\":\"/doc.txt\",\"version\":\"\(sha)\",\"size\":5}]}"
    let transport = Transport([(200, listing), (200, versions)])
    let (client, session) = try mockClient(transport); defer { session.invalidateAndCancel() }
    let coordinator = WriteCoordinator(catalog: catalog, client: client)
    let matched = try await coordinator.reimport(parentId: "root", name: "doc.txt", directory: false, contents: file)
    #expect(matched?.entry.id == remoteId && matched?.materialized == true && matched?.contentVersion == sha)
    #expect(transport.requests.map { $0.url?.path } == ["/api/v2/desktop/entries", "/api/v2/desktop/versions"])
    #expect(try await catalog.pendingWrites().isEmpty)
    #expect(!FileManager.default.fileExists(atPath: catalog.recoveryDirectory.path))
    // Verified local content needs no second server hash; different bytes are not acknowledged.
    try Data("other".utf8).write(to: file)
    transport.bodies = [(200, listing)]
    #expect(try await coordinator.reimport(parentId: "root", name: "doc.txt", directory: false, contents: file) == nil)
    #expect(transport.requests.count == 3)
    #expect(try await catalog.item(matched!.id).contentVersion == sha)
    // Dataless and kind-mismatched reimports never manufacture a replacement.
    transport.bodies = [(200, listing), (200, listing), (200, listing)]
    #expect(try await coordinator.reimport(parentId: "root", name: "doc.txt", directory: false, contents: nil)?.id == matched?.id)
    await #expect(throws: DriveError.unsupported) {
        _ = try await coordinator.reimport(parentId: "root", name: "doc.txt", directory: true, contents: nil)
    }
    #expect(try await coordinator.reimport(parentId: "root", name: "missing.txt", directory: false, contents: file) == nil)
}
