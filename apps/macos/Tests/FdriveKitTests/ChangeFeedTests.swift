import Foundation
import SQLite3
import Testing
@testable import FdriveKit

private func entry(_ path: String, kind: String = "file") -> RemoteEntry {
    var entry = RemoteEntry(path: path, name: String(path.split(separator: "/").last!), kind: kind, size: kind == "dir" ? 0 : 5)
    entry.id = UUID().uuidString.lowercased()
    entry.version = WriteVersion(content: "digest", metadata: "metadata:\(path)")
    return entry
}

/// The server's folders and their entries, the same objects the catalog was seeded with,
/// so listing a folder again changes nothing but its token.
private func tree() -> [String: [RemoteEntry]] {
    ["/": [entry("/a", kind: "dir"), entry("/b", kind: "dir"), entry("/c", kind: "dir"), entry("/d", kind: "dir"), entry("/top.txt")],
     "/a": [entry("/a/one.txt")],
     "/b": [entry("/b/sub", kind: "dir")],
     "/b/sub": [entry("/b/sub/doc.txt")],
     "/c": [entry("/c/kept.txt")],
     "/d": []]
}

/// Every folder listed in full with a token, three downloads, and `/d` changed by this Mac,
/// so the server cannot vouch for it.
private func fixture() async throws -> (Catalog, URL, [String: [RemoteEntry]]) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Feed")
    let folders = tree()
    for folder in folders.keys.sorted() { try await catalog.reconcile(folders[folder]!, folder: folder, token: "t:\(folder)") }
    for path in ["/top.txt", "/b/sub/doc.txt", "/c/kept.txt"] {
        _ = try await catalog.downloaded(try await catalog.itemAt(path).id, hash: "old", size: 5)
    }
    try await catalog.forgetToken("/d")
    return (catalog, directory, folders)
}

private func changes(_ paths: [String], _ folders: [String], anchor: String, more: Bool = false) -> ChangePage {
    ChangePage(status: .changes, paths: paths, folders: folders, anchor: anchor, more: more)
}

private actor FeedClient: CatalogRefreshClient {
    var listings: [String: [RemoteEntry]]
    var states: [String: FolderState] = [:]
    var pages: [String: ChangePage] = [:]
    var feedError: DriveError?
    var listErrors: [String: DriveError] = [:]
    var versionError: DriveError?
    private(set) var asked: [String?] = []
    private(set) var listed: [String] = []
    private(set) var checked: [String] = []
    private(set) var validated: [String] = []
    init(_ listings: [String: [RemoteEntry]], pages: [String: ChangePage] = [:], states: [String: FolderState] = [:],
         feedError: DriveError? = nil, listErrors: [String: DriveError] = [:], versionError: DriveError? = nil) {
        self.listings = listings; self.pages = pages; self.states = states; self.feedError = feedError
        self.listErrors = listErrors; self.versionError = versionError
    }
    func list(_ path: String) async throws -> [RemoteEntry] { try await snapshot(path).entries }
    func snapshot(_ path: String) async throws -> (entries: [RemoteEntry], token: String?) {
        listed.append(path)
        if let error = listErrors[path] { throw error }
        return (listings[path] ?? [], "listed:\(path)")
    }
    func checks(_ folders: [FolderCheck]) async throws -> [FolderStatus] {
        checked += folders.map(\.path)
        return folders.map { FolderStatus(path: $0.path, status: states[$0.path] ?? .unchanged) }
    }
    func changes(since anchor: String?) async throws -> ChangePage {
        asked.append(anchor)
        if let feedError { throw feedError }
        guard let page = pages[anchor ?? ""] else { throw DriveError.server("No page after \(anchor ?? "nothing").") }
        return page
    }
    func versions(_ paths: [String]) async throws -> [ContentVersion] {
        validated += paths
        if let versionError { throw versionError }
        return paths.map { ContentVersion(path: $0, version: "new", size: 3) }
    }
}

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func stored(_ catalog: Catalog) async throws -> String? { try await catalog.changeFeed()?.anchor }

@Test func theFeedAnchorSurvivesReopeningAndUpgradesAVersion4Catalog() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("catalog.sqlite")
    do {
        let catalog = try Catalog(url: url, title: "Feed")
        #expect(try await catalog.changeFeed() == nil)
        try await catalog.saveChangeFeed(anchor: "v1.one", checkedAt: now)
        try await catalog.saveChangeFeed(anchor: "v1.two", checkedAt: now.addingTimeInterval(0.25))
    }
    let reopened = try Catalog(url: url, title: "Feed")
    let saved = try await reopened.changeFeed()
    #expect(saved?.anchor == "v1.two")
    #expect(saved?.checkedAt == now.addingTimeInterval(0.25))
    try await reopened.forgetChangeFeed()
    #expect(try await reopened.changeFeed() == nil)
    // A catalog an older build wrote has no feed table; opening it adds one and keeps the rest.
    try await reopened.reconcile([entry("/kept.txt")], folder: "/", token: "root")
    func sql(_ statement: String) {
        var database: OpaquePointer?
        sqlite3_open(url.path, &database)
        sqlite3_exec(database, statement, nil, nil, nil)
        sqlite3_close(database)
    }
    sql("DROP TABLE change_feed; PRAGMA user_version=4;")
    let upgraded = try Catalog(url: url, title: "Feed")
    #expect(try await upgraded.changeFeed() == nil)
    #expect(try await upgraded.folderTokens() == ["/": "root"])
    try await upgraded.saveChangeFeed(anchor: "v1.three", checkedAt: now)
    #expect(try await stored(upgraded) == "v1.three")
    // A newer build's catalog is left alone.
    sql("PRAGMA user_version=6;")
    #expect(throws: DriveError.self) { _ = try Catalog(url: url, title: "Feed") }
}

@Test func aListingAppliedInFullIsRecordedEvenWithoutAToken() async throws {
    let (catalog, directory, folders) = try await fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    #expect(try await catalog.listedInFull() == ["/", "/a", "/b", "/b/sub", "/c"])
    // A listing of several pages has no token for checks, but the feed can still vouch for it.
    try await catalog.reconcile(folders["/d"]!, folder: "/d")
    #expect(try await catalog.listedInFull().contains("/d"))
    #expect(try await catalog.folderTokens()["/d"] == nil)
    // A listing that skipped a pending write is not applied in full.
    let item = try await catalog.itemAt("/c/kept.txt")
    let id = UUID().uuidString.lowercased()
    _ = try await catalog.beginWrite(PendingWrite(id: id, key: id, localId: item.id, route: "moves",
        request: WriteRequest(operationId: id, itemId: item.entry.id, parentId: "root", name: "moved.txt",
                              base: WriteVersion(content: item.contentVersion, metadata: item.metadataVersion))))
    try await catalog.reconcile([], folder: "/c", token: "t:/c")
    #expect(try await catalog.listedInFull().contains("/c") == false)
}

@Test func aFirstRefreshChecksEveryFolderThenTheFeedListsOnlyWhatItNames() async throws {
    let (catalog, directory, folders) = try await fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    // No anchor yet: the feed starts from now, and every folder is checked as before it.
    let first = FeedClient(folders, pages: ["": ChangePage(status: .resync, anchor: "A1")], states: ["/c": .changed])
    #expect(try await refreshCatalog(catalog, client: first, checks: true, feed: true, now: now) {} == .full)
    #expect(await first.asked == [nil])
    #expect(await first.checked == ["/", "/a", "/b", "/b/sub", "/c"])
    #expect(await first.listed == ["/c", "/d"])
    #expect(await first.validated == ["/b/sub/doc.txt", "/c/kept.txt", "/top.txt"])
    #expect(try await catalog.changeFeed()?.anchor == "A1")
    #expect(try await catalog.changeFeed()?.checkedAt == now)
    // Then one request: the folders it names, those at or below a changed path, and only the
    // downloads there. Nothing is checked.
    let next = FeedClient(folders, pages: ["A1": changes(["/b/sub/doc.txt"], ["/b", "/b/sub"], anchor: "A2")])
    #expect(try await refreshCatalog(catalog, client: next, checks: true, feed: true, now: now.addingTimeInterval(60)) {} == .feed)
    #expect(await next.asked == ["A1"])
    #expect(await next.checked.isEmpty)
    #expect(await next.listed == ["/b", "/b/sub"])
    #expect(await next.validated == ["/b/sub/doc.txt"])
    #expect(try await catalog.changeFeed()?.anchor == "A2")
    // The last full check stays when it was.
    #expect(try await catalog.changeFeed()?.checkedAt == now)
    // A folder this Mac wrote to is listed whatever the feed says; a changed path covers
    // every browsed folder below it.
    try await catalog.forgetToken("/a")
    let own = FeedClient(folders, pages: ["A2": changes(["/b"], ["/"], anchor: "A3")])
    #expect(try await refreshCatalog(catalog, client: own, feed: true, now: now.addingTimeInterval(120)) {} == .feed)
    #expect(await own.listed == ["/", "/a", "/b", "/b/sub"])
    #expect(await own.validated == ["/b/sub/doc.txt"])
}

@Test func pagesAreReadToTheEndBeforeAnyFolderIsListed() async throws {
    let (catalog, directory, folders) = try await fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await catalog.saveChangeFeed(anchor: "A1", checkedAt: now)
    let client = FeedClient(folders, pages: [
        "A1": changes(["/a/one.txt"], ["/a", "/"], anchor: "A2", more: true),
        "A2": changes(["/c/kept.txt"], ["/c", "/"], anchor: "A3"),
    ])
    #expect(try await refreshCatalog(catalog, client: client, feed: true, now: now) {} == .feed)
    #expect(await client.asked == ["A1", "A2"])
    #expect(await client.listed == ["/", "/a", "/c", "/d"])
    #expect(try await stored(catalog) == "A3")
    // A bulk change past the page limit is cheaper to check folder by folder.
    var bulk: [String: ChangePage] = [:]
    for page in 0..<maxChangePages { bulk["B\(page)"] = changes(["/a/\(page).txt"], ["/a"], anchor: "B\(page + 1)", more: true) }
    try await catalog.saveChangeFeed(anchor: "B0", checkedAt: now)
    let busy = FeedClient(folders, pages: bulk)
    #expect(try await refreshCatalog(catalog, client: busy, checks: true, feed: true, now: now) {} == .full)
    #expect(await busy.asked.count == maxChangePages)
    #expect(await busy.checked == ["/", "/a", "/b", "/b/sub", "/c", "/d"])
    #expect(try await stored(catalog) == "B\(maxChangePages)")
    // A feed that does not move on is not followed; the refresh checks everything instead.
    try await catalog.saveChangeFeed(anchor: "S", checkedAt: now)
    let stuck = FeedClient(folders, pages: ["S": changes([], [], anchor: "S", more: true)])
    #expect(try await refreshCatalog(catalog, client: stuck, checks: true, feed: true, now: now) {} == .full)
    #expect(try await stored(catalog) == "S")
}

@Test func aResyncOrAnHourWithoutAFullCheckChecksEveryFolderAgain() async throws {
    let (catalog, directory, folders) = try await fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    // The server cannot vouch for the anchor (a restore, a gap, a share added): check, then go on.
    try await catalog.saveChangeFeed(anchor: "A1", checkedAt: now)
    let reset = FeedClient(folders, pages: ["A1": ChangePage(status: .resync, anchor: "R1")], states: ["/a": .changed])
    let later = now.addingTimeInterval(600)
    #expect(try await refreshCatalog(catalog, client: reset, checks: true, feed: true, now: later) {} == .full)
    #expect(await reset.listed == ["/a", "/d"])
    #expect(try await stored(catalog) == "R1")
    #expect(try await catalog.changeFeed()?.checkedAt == later)
    // So does a refresh the person asked for, however recent the last full check.
    let asked = FeedClient(folders, pages: ["": ChangePage(status: .resync, anchor: "R1")])
    #expect(try await refreshCatalog(catalog, client: asked, checks: true, feed: true, checkAll: true, now: later) {} == .full)
    #expect(await asked.asked == [nil])
    #expect(await asked.checked.count == 6)
    // An hour after the last full check the refresh starts from now and checks everything.
    for checked in [later.addingTimeInterval(fullCheckInterval), later.addingTimeInterval(-1)] {
        let hourly = FeedClient(folders, pages: ["": ChangePage(status: .resync, anchor: "R2"), "R1": changes([], [], anchor: "R1")])
        #expect(try await refreshCatalog(catalog, client: hourly, checks: true, feed: true, now: checked) {} == .full)
        #expect(await hourly.asked == [nil])
        #expect(await hourly.checked.count == 6)
        #expect(try await catalog.changeFeed()?.checkedAt == checked)
        try await catalog.saveChangeFeed(anchor: "R1", checkedAt: later)
    }
}

@Test func theAnchorMovesOnlyOnceEverythingItNamedWasApplied() async throws {
    let (catalog, directory, folders) = try await fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await catalog.saveChangeFeed(anchor: "A1", checkedAt: now)
    let named = changes(["/a/one.txt", "/c/kept.txt"], ["/a", "/c"], anchor: "A2")
    // An outage listing one folder keeps the old anchor, after publishing what did apply.
    let outage = FeedClient(folders, pages: ["A1": named], listErrors: ["/a": .unavailable])
    await #expect(throws: DriveError.unavailable) {
        try await refreshCatalog(catalog, client: outage, feed: true, now: now) {}
    }
    #expect(await outage.listed == ["/a", "/c", "/d"])
    #expect(try await stored(catalog) == "A1")
    // So does a download that could not be checked.
    let unchecked = FeedClient(folders, pages: ["A1": named], versionError: .unavailable)
    await #expect(throws: DriveError.unavailable) {
        try await refreshCatalog(catalog, client: unchecked, feed: true, now: now) {}
    }
    #expect(await unchecked.validated == ["/c/kept.txt"])
    #expect(try await stored(catalog) == "A1")
    // The next refresh asks from the same anchor and gets the same folders.
    let retried = FeedClient(folders, pages: ["A1": named])
    try await refreshCatalog(catalog, client: retried, feed: true, now: now) {}
    #expect(await retried.asked == ["A1"])
    #expect(await retried.listed == ["/a", "/c"])
    #expect(try await stored(catalog) == "A2")
    // A folder this connection may not read loses its token instead of holding the anchor
    // back: every later refresh lists it until it can be read.
    let denied = FeedClient(folders, pages: ["A2": changes(["/a/one.txt"], ["/a"], anchor: "A3")], listErrors: ["/a": .forbidden])
    await #expect(throws: DriveError.forbidden) {
        try await refreshCatalog(catalog, client: denied, feed: true, now: now) {}
    }
    #expect(try await stored(catalog) == "A3")
    #expect(try await catalog.listedInFull().contains("/a") == false)
    let readable = FeedClient(folders, pages: ["A3": changes([], [], anchor: "A4")])
    try await refreshCatalog(catalog, client: readable, feed: true, now: now) {}
    #expect(await readable.listed == ["/a"])
    #expect(try await catalog.listedInFull().contains("/a"))
    // A folder that is gone has nothing left to apply.
    let gone = FeedClient(folders, pages: ["A4": changes(["/c"], ["/"], anchor: "A5")], listErrors: ["/c": .missing])
    try await refreshCatalog(catalog, client: gone, feed: true, now: now) {}
    #expect(try await stored(catalog) == "A5")
    // In a full check, a folder it may not read loses its token too, and the anchor is kept.
    let deniedCheck = FeedClient(folders, pages: ["": ChangePage(status: .resync, anchor: "R1")], states: ["/b": .forbidden])
    await #expect(throws: DriveError.forbidden) {
        try await refreshCatalog(catalog, client: deniedCheck, checks: true, feed: true, now: now.addingTimeInterval(fullCheckInterval)) {}
    }
    #expect(try await stored(catalog) == "R1")
    #expect(try await catalog.folderTokens()["/b"] == nil)
}

@Test func withoutAFeedTheRefreshChecksEverythingAndKeepsNoAnchor() async throws {
    let (catalog, directory, folders) = try await fixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await catalog.saveChangeFeed(anchor: "A1", checkedAt: now)
    // A failing feed only costs this refresh its shortcut: the anchor stays for the next one.
    let failing = FeedClient(folders, feedError: .unavailable)
    #expect(try await refreshCatalog(catalog, client: failing, checks: true, feed: true, now: now) {} == .full)
    #expect(await failing.checked.count == 5)
    #expect(try await stored(catalog) == "A1")
    // A server that answers 404 keeps no feed for the location after all.
    let missing = FeedClient(folders, feedError: .missing)
    #expect(try await refreshCatalog(catalog, client: missing, checks: true, feed: true, now: now) {} == .full)
    #expect(try await catalog.changeFeed() == nil)
    // A server that stops advertising it leaves no anchor to resume from later.
    try await catalog.saveChangeFeed(anchor: "A1", checkedAt: now)
    let older = FeedClient(folders)
    #expect(try await refreshCatalog(catalog, client: older, checks: true, now: now) {} == .full)
    #expect(await older.asked.isEmpty)
    #expect(try await catalog.changeFeed() == nil)
}

@Test func aFeedRefreshIsPacedOnlyByHowLongItTook() {
    let finished = Date(timeIntervalSince1970: 1_800_000_000)
    // The app passes no folders after a refresh that followed the feed.
    #expect(nextAutomaticRefresh(finished: finished, took: 0.5, folders: 0) == finished.addingTimeInterval(2))
    #expect(nextAutomaticRefresh(finished: finished, took: 0.5, folders: 1_700) == finished.addingTimeInterval(340))
}
