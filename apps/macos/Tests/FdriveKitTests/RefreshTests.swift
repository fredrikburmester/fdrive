import Foundation
import Testing
@testable import FdriveKit

private actor RefreshClient: CatalogRefreshClient {
    let listings: [String: [RemoteEntry]]
    let denied: Set<String>
    let validationError: DriveError?
    private(set) var listed: [String] = []
    private(set) var validated: [[String]] = []
    init(listings: [String: [RemoteEntry]], denied: Set<String> = [], validationError: DriveError? = nil) {
        self.listings = listings; self.denied = denied; self.validationError = validationError
    }
    func list(_ path: String) async throws -> [RemoteEntry] {
        listed.append(path)
        if denied.contains(path) { throw DriveError.authentication }
        return listings[path] ?? []
    }
    func versions(_ paths: [String]) async throws -> [ContentVersion] {
        validated.append(paths)
        if let validationError { throw validationError }
        if paths.contains(where: denied.contains) { throw DriveError.authentication }
        return paths.map { ContentVersion(path: $0, version: "new", size: 3) }
    }
}
private actor RefreshSignals {
    private(set) var changes: [Changes] = []
    func append(_ changes: Changes) { self.changes.append(changes) }
}
private func refreshFixture() throws -> (Catalog, URL) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    return (try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Refresh"), directory)
}

@Test func deniedFolderPreservesItsSnapshotAndPublishesOtherChanges() async throws {
    let (catalog, directory) = try refreshFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let denied = RemoteEntry(path: "/a", name: "a", kind: "dir")
    let healthy = RemoteEntry(path: "/z", name: "z", kind: "dir")
    let old = RemoteEntry(path: "/root.txt", name: "root.txt", kind: "file", size: 3)
    let cached = RemoteEntry(path: "/a/cached.txt", name: "cached.txt", kind: "file", size: 3)
    let added = RemoteEntry(path: "/z/new.txt", name: "new.txt", kind: "file", size: 3)
    try await catalog.reconcile([denied, healthy, old], folder: "/")
    try await catalog.reconcile([cached], folder: "/a")
    try await catalog.reconcile([], folder: "/z")
    let cachedItem = try await catalog.itemAt(cached.path)
    _ = try await catalog.downloaded(cachedItem.id, hash: "old", size: 3)
    var updated = old; updated.size = 9
    let client = RefreshClient(listings: ["/": [denied, healthy, updated], "/z": [added]], denied: ["/a"])
    let signals = RefreshSignals()
    let anchor = try await catalog.revision()
    await #expect(throws: DriveError.authentication) {
        try await refreshCatalog(catalog, client: client) {
            await signals.append(try await catalog.changes(since: anchor))
        }
    }
    #expect(try await catalog.itemAt(cached.path).id == cachedItem.id)
    #expect(try await catalog.item(cachedItem.id).contentVersion == "old")
    #expect(await client.listed == ["/", "/a", "/z"])
    #expect(await client.validated.isEmpty)
    let changes = await signals.changes
    #expect(changes.count == 1)
    #expect(Set(changes[0].items.map { $0.entry.path }) == [old.path, added.path])
    #expect(changes[0].deleted.isEmpty)
}

@Test func deniedFileDoesNotBlockItsBatchOrLaterContentValidation() async throws {
    let (catalog, directory) = try refreshFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let entries = (0..<18).map { RemoteEntry(path: String(format: "/file%02d", $0), name: String(format: "file%02d", $0), kind: "file", size: 3) }
    try await catalog.reconcile(entries, folder: "/")
    for item in try await catalog.children("root") {
        _ = try await catalog.downloaded(item.id, hash: "old", size: 3)
    }
    let anchor = try await catalog.revision()
    let client = RefreshClient(listings: ["/": entries], denied: [entries[0].path])
    let signals = RefreshSignals()
    await #expect(throws: DriveError.authentication) {
        try await refreshCatalog(catalog, client: client) {
            await signals.append(try await catalog.changes(since: anchor))
        }
    }
    #expect(try await catalog.itemAt(entries[0].path).contentVersion == "old")
    for entry in entries.dropFirst() {
        #expect(try await catalog.itemAt(entry.path).contentVersion == "new")
    }
    #expect(await signals.changes.first?.items.count == 17)
    #expect(await client.validated.first?.count == 16)
    #expect(await client.validated.last?.count == 2)
}

@Test func removedFoldersStillPublishTombstonesWithoutFailingRefresh() async throws {
    let (catalog, directory) = try refreshFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await catalog.reconcile([.init(path: "/folder", name: "folder", kind: "dir")], folder: "/")
    try await catalog.reconcile([.init(path: "/folder/file", name: "file", kind: "file")], folder: "/folder")
    let anchor = try await catalog.revision()
    let signals = RefreshSignals()
    let client = RefreshClient(listings: ["/": []])
    try await refreshCatalog(catalog, client: client) {
        await signals.append(try await catalog.changes(since: anchor))
    }
    #expect(await signals.changes.first?.deleted.count == 2)
    #expect(await client.listed == ["/"])
}

@Test func unavailableValidationDoesNotFanOutIntoIndividualRetries() async throws {
    let (catalog, directory) = try refreshFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let entries = (0..<18).map { RemoteEntry(path: "/file\($0)", name: "file\($0)", kind: "file", size: 3) }
    try await catalog.reconcile(entries, folder: "/")
    for item in try await catalog.children("root") {
        _ = try await catalog.downloaded(item.id, hash: "old", size: 3)
    }
    let client = RefreshClient(listings: ["/": entries], validationError: .unavailable)
    let signals = RefreshSignals()
    await #expect(throws: DriveError.unavailable) {
        try await refreshCatalog(catalog, client: client) {
            await signals.append(try await catalog.changes(since: 0))
        }
    }
    #expect(await client.validated.map(\.count) == [16, 2])
    #expect(await signals.changes.count == 1)
}

@Test func cancelledRefreshStopsWithoutPublishingOrStartingRequests() async throws {
    let (catalog, directory) = try refreshFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await catalog.reconcile([], folder: "/")
    let client = RefreshClient(listings: ["/": []])
    let signals = RefreshSignals()
    let task = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        try await refreshCatalog(catalog, client: client) {
            await signals.append(try await catalog.changes(since: 0))
        }
    }
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(await client.listed.isEmpty)
    #expect(await signals.changes.isEmpty)
}

@Test func slowRefreshesAreSpacedOutAndQuickOnesStayDueEveryMinute() {
    let finished = Date(timeIntervalSince1970: 1_800_000_000)
    // A small location is due again before the next one-minute tick.
    #expect(nextAutomaticRefresh(finished: finished, took: 1) == finished.addingTimeInterval(4))
    // The owner's 1,675-folder location took three minutes and restarted a minute later.
    #expect(nextAutomaticRefresh(finished: finished, took: 180) == finished.addingTimeInterval(720))
    #expect(nextAutomaticRefresh(finished: finished, took: 3_600) == finished.addingTimeInterval(900))
    #expect(nextAutomaticRefresh(finished: finished, took: -5) == finished)
}
