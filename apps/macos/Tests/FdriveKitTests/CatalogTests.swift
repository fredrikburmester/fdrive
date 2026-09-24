import Foundation
import SQLite3
import Testing
@testable import FdriveKit

private func fixture() throws -> (Catalog, URL) {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("metadata.sqlite")
    return (try Catalog(url: url, title: "Test"), url)
}

@Test func identitySurvivesRestartAndDeletionDoesNotReuseIt() async throws {
    let (catalog, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let entry = RemoteEntry(path: "/notes.txt", name: "notes.txt", kind: "file", size: 5)
    try await catalog.reconcile([entry], folder: "/")
    let original = try await catalog.itemAt(entry.path)
    let reopened = try Catalog(url: url, title: "Test")
    #expect(try await reopened.itemAt(entry.path).id == original.id)
    let anchor = try await catalog.revision()
    try await catalog.reconcile([], folder: "/")
    #expect(try await catalog.changes(since: anchor).deleted == [original.id])
    try await catalog.reconcile([entry], folder: "/")
    #expect(try await catalog.itemAt(entry.path).id != original.id)
}

@Test func separateLocationsDoNotShareIdentityOrContents() async throws {
    let (first, firstURL) = try fixture(); let (second, secondURL) = try fixture()
    defer {
        try? FileManager.default.removeItem(at: firstURL.deletingLastPathComponent())
        try? FileManager.default.removeItem(at: secondURL.deletingLastPathComponent())
    }
    let entry = RemoteEntry(path: "/same", name: "same", kind: "file")
    try await first.reconcile([entry], folder: "/"); try await second.reconcile([entry], folder: "/")
    #expect(try await first.itemAt(entry.path).id != second.itemAt(entry.path).id)
    #expect(try await first.generation() != second.generation())
}

@Test func failedSnapshotRollsBackAndRemovedFoldersTombstoneChildren() async throws {
    let (catalog, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let folder = RemoteEntry(path: "/Folder", name: "Folder", kind: "dir")
    try await catalog.reconcile([folder], folder: "/")
    let file = RemoteEntry(path: "/Folder/hello", name: "hello", kind: "file")
    try await catalog.reconcile([file], folder: folder.path)
    let child = try await catalog.itemAt(file.path)
    let revision = try await catalog.revision()
    await #expect(throws: DriveError.self) {
        try await catalog.reconcile([folder, RemoteEntry(path: "/folder", name: "folder", kind: "dir")], folder: "/")
    }
    #expect(try await catalog.revision() == revision)
    #expect(try await catalog.itemAt(file.path).id == child.id)
    try await catalog.reconcile([], folder: "/")
    #expect(try await catalog.changes(since: revision).deleted.contains(child.id))
    #expect(try await catalog.folders() == ["/"])
}

@Test func changedBytesWithIdenticalMetadataInvalidateMaterializedContent() async throws {
    let (catalog, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let entry = RemoteEntry(path: "/hello", name: "hello", kind: "file", size: 5)
    try await catalog.reconcile([entry], folder: "/")
    let item = try await catalog.itemAt(entry.path)
    _ = try await catalog.downloaded(item.id, hash: "old", size: 5)
    let anchor = try await catalog.revision()
    try await catalog.reconcile([entry], folder: "/")
    #expect(try await catalog.revision() == anchor)
    try await catalog.validate([ContentVersion(path: entry.path, version: "new", size: 5)])
    let updated = try await catalog.item(item.id)
    #expect(updated.contentVersion == "new")
    #expect(try await catalog.changes(since: anchor).items.map(\.id) == [item.id])
    try await catalog.setMaterialized([])
    #expect(try await catalog.item(item.id).materialized == false)
}

@Test func validatesPathsAndServerOrigins() throws {
    #expect(try canonicalPath("/literal%20name//file") == "/literal%20name/file")
    #expect(throws: DriveError.self) { try canonicalPath("/folder/../secret") }
    #expect(throws: DriveError.self) { try canonicalPath("/folder/\u{0}secret") }
    #expect(try APIClient.normalizeServer(URL(string: "https://drive.example.com/")!).absoluteString == "https://drive.example.com")
    for invalid in ["http://drive.example.com", "https://user:password@drive.example.com", "https://drive.example.com/path", "https://drive.example.com?token=secret"] {
        #expect(throws: DriveError.self) { try APIClient.normalizeServer(URL(string: invalid)!) }
    }
    #expect(try APIClient.normalizeServer(URL(string: "http://127.0.0.1:1234")!).port == 1234)
}

@Test func concurrentListingsAndDownloadsCannotRestoreOlderState() async throws {
    let (catalog, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let otherProcess = try Catalog(url: url, title: "Test")
    let entry = RemoteEntry(path: "/file", name: "file", kind: "file", size: 1)
    let old = try await catalog.beginListing("/")
    let new = try await otherProcess.beginListing("/")
    try await otherProcess.reconcile([entry], folder: "/", listing: new)
    try await catalog.reconcile([], folder: "/", listing: old)
    let item = try await catalog.itemAt(entry.path)
    _ = try await catalog.downloaded(item.id, hash: "first", size: 1)
    _ = try await otherProcess.downloaded(item.id, hash: "second", size: 1)
    try await catalog.validate([ContentVersion(path: entry.path, version: "stale", size: 1)], expecting: [entry.path: "first"])
    #expect(try await catalog.item(item.id).contentVersion == "second")
    await #expect(throws: DriveError.changedContent) {
        _ = try await catalog.downloaded(item.id, hash: "stale", size: 1, expectedVersion: "first")
    }
}

@Test func expiredHistoryForcesResyncAndKeepsCurrentItems() async throws {
    let (_, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let catalog = try Catalog(url: url, title: "Test", retainedRevisions: 2)
    let first = RemoteEntry(path: "/first", name: "first", kind: "file")
    try await catalog.reconcile([first], folder: "/")
    let original = try await catalog.itemAt(first.path)
    let oldAnchor = try await catalog.revision()
    try await catalog.reconcile([], folder: "/")
    for index in 0..<4 {
        try await catalog.reconcile([RemoteEntry(path: "/new", name: "new", kind: "file", size: Int64(index))], folder: "/")
    }
    await #expect(throws: DriveError.expiredSnapshot) { try await catalog.changes(since: oldAnchor) }
    #expect(try await catalog.all().count == 2)
    #expect(try await catalog.changes(since: catalog.revision()).deleted.isEmpty)
    try await catalog.reconcile([first], folder: "/")
    #expect(try await catalog.itemAt(first.path).id != original.id)
}

@Test func migratesExistingCatalogAndRejectsFutureSchemas() async throws {
    let (catalog, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let generation = try await catalog.generation()
    var database: OpaquePointer?
    #expect(sqlite3_open(url.path, &database) == SQLITE_OK)
    defer { sqlite3_close(database) }
    #expect(sqlite3_exec(database, "DROP TABLE listings; DELETE FROM state WHERE key='retainedRevision'; PRAGMA user_version=1", nil, nil, nil) == SQLITE_OK)
    let migrated = try Catalog(url: url, title: "Test")
    #expect(try await migrated.generation() == generation)
    _ = try await migrated.beginListing("/")
    #expect(sqlite3_exec(database, "PRAGMA user_version=99", nil, nil, nil) == SQLITE_OK)
    #expect(throws: DriveError.self) { try Catalog(url: url, title: "Test") }
}

@Test func tenThousandEntriesRemainStableAcrossSnapshots() async throws {
    let (catalog, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let entries = (0..<10_000).map { RemoteEntry(path: "/file-\($0)", name: "file-\($0)", kind: "file") }
    try await catalog.reconcile(entries, folder: "/")
    let revision = try await catalog.revision()
    let first = try await catalog.children("root")
    #expect(first.count == 10_000)
    #expect(Set(first.map(\.id)).count == 10_000)
    #expect(first.allSatisfy { !$0.materialized })
    try await catalog.reconcile(entries.reversed(), folder: "/")
    #expect(try await catalog.revision() == revision)
    #expect(try await catalog.children("root").map(\.id) == first.map(\.id))
}

@Test func refreshQueriesUseIndexesInNewAndUpgradedCatalogs() async throws {
    let (_, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    // A new connection each time: a connection plans with the schema it loaded first.
    func plan(_ sql: String) -> String {
        var database: OpaquePointer?, statement: OpaquePointer?
        defer { sqlite3_finalize(statement); sqlite3_close(database) }
        guard sqlite3_open(url.path, &database) == SQLITE_OK,
              sqlite3_prepare_v2(database, "EXPLAIN QUERY PLAN " + sql, -1, &statement, nil) == SQLITE_OK else { return "" }
        var steps: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW { steps.append(String(cString: sqlite3_column_text(statement, 3))) }
        return steps.joined(separator: "; ")
    }
    let queries = [(Catalog.itemByRemoteId, "item_remote_id"), (Catalog.pruneDeletedItems, "item_deleted_revision")]
    for (sql, index) in queries { #expect(plan(sql).contains("USING INDEX \(index)")) }
    // Catalogs saved by 0.4.1 and earlier have neither index; opening one adds them.
    var database: OpaquePointer?
    #expect(sqlite3_open(url.path, &database) == SQLITE_OK)
    #expect(sqlite3_exec(database, "DROP INDEX item_remote_id; DROP INDEX item_deleted_revision", nil, nil, nil) == SQLITE_OK)
    sqlite3_close(database)
    for (sql, _) in queries { #expect(plan(sql).contains("SCAN items")) }
    _ = try Catalog(url: url, title: "Test")
    for (sql, index) in queries { #expect(plan(sql).contains("USING INDEX \(index)")) }
}

@Test(.timeLimit(.minutes(1))) func tenThousandEntriesWithServerIdsRefreshWithoutRescanning() async throws {
    let (catalog, url) = try fixture()
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let entries = (0..<10_000).map { index in
        var entry = RemoteEntry(path: "/file-\(index)", name: "file-\(index)", kind: "file")
        entry.id = "remote-\(index)"
        return entry
    }
    try await catalog.reconcile(entries, folder: "/")
    let revision = try await catalog.revision()
    let first = try await catalog.children("root")
    try await catalog.reconcile(entries.reversed(), folder: "/")
    #expect(try await catalog.revision() == revision)
    #expect(try await catalog.children("root").map(\.id) == first.map(\.id))
}
