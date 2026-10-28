import Foundation
import Testing
@testable import FdriveKit

private func entry(_ path: String, kind: String = "file", id: String = UUID().uuidString.lowercased()) -> RemoteEntry {
    var entry = RemoteEntry(path: path, name: String(path.split(separator: "/").last!), kind: kind, size: kind == "dir" ? 0 : 5)
    entry.id = id; entry.version = WriteVersion(content: "digest", metadata: UUID().uuidString)
    return entry
}
private func pending(_ item: CatalogItem, parent: CatalogItem, name: String) -> PendingWrite {
    let id = UUID().uuidString.lowercased()
    return PendingWrite(id: id, key: id, localId: item.id, route: "moves",
        request: WriteRequest(operationId: id, itemId: item.entry.id, parentId: parent.entry.id ?? "root", name: name,
            base: WriteVersion(content: item.contentVersion, metadata: item.metadataVersion)))
}
private func catalogFixture() throws -> (Catalog, URL) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    return (try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Checks"), directory)
}

private actor CheckingClient: CatalogRefreshClient {
    var listings: [String: [RemoteEntry]] = [:]
    var states: [String: FolderState] = [:]
    var answers = Int.max
    var checkError: DriveError?
    private(set) var listed: [String] = []
    private(set) var checked: [[String]] = []
    private(set) var validated: [String] = []
    func configure(listings: [String: [RemoteEntry]] = [:], states: [String: FolderState] = [:],
                   answers: Int = .max, checkError: DriveError? = nil) {
        self.listings = listings; self.states = states; self.answers = answers; self.checkError = checkError
    }
    func list(_ path: String) async throws -> [RemoteEntry] { try await snapshot(path).entries }
    func snapshot(_ path: String) async throws -> (entries: [RemoteEntry], token: String?) {
        listed.append(path)
        return (listings[path] ?? [], "listed:\(path)")
    }
    func checks(_ folders: [FolderCheck]) async throws -> [FolderStatus] {
        checked.append(folders.map(\.path))
        if let checkError { throw checkError }
        return folders.prefix(answers).map { FolderStatus(path: $0.path, status: states[$0.path] ?? .unchanged) }
    }
    func versions(_ paths: [String]) async throws -> [ContentVersion] {
        validated += paths
        return paths.map { ContentVersion(path: $0, version: "new", size: 3) }
    }
}

@Test func folderTokensOnlyVouchForListingsAppliedInFull() async throws {
    let (catalog, directory) = try catalogFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let folder = entry("/a", kind: "dir"), nested = entry("/a/b", kind: "dir")
    try await catalog.reconcile([folder], folder: "/", token: "root-1")
    try await catalog.reconcile([nested], folder: "/a", token: "a-1")
    try await catalog.reconcile([], folder: "/a/b", token: "b-1")
    #expect(try await catalog.folderTokens() == ["/": "root-1", "/a": "a-1", "/a/b": "b-1"])
    // A listing that carried no token, from Finder or an older server, vouches for nothing.
    try await catalog.reconcile([folder], folder: "/")
    #expect(try await catalog.folderTokens()["/"] == nil)
    // A superseded listing changes nothing, its token included.
    let stale = try await catalog.beginListing("/a")
    _ = try await catalog.beginListing("/a")
    try await catalog.reconcile([], folder: "/a", listing: stale, token: "a-stale")
    #expect(try await catalog.folderTokens()["/a"] == "a-1")
    // A removed folder takes its token with it.
    try await catalog.reconcile([], folder: "/a", token: "a-2")
    #expect(try await catalog.folderTokens() == ["/a": "a-2"])
}

@Test func aListingThatSkippedAPendingWriteIsNotVouchedFor() async throws {
    let (catalog, directory) = try catalogFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = entry("/file.txt")
    try await catalog.reconcile([file], folder: "/", token: "before")
    let item = try await catalog.itemAt(file.path)
    let operation = try await catalog.beginWrite(pending(item, parent: catalog.item("root"), name: "renamed.txt"))
    var changed = file; changed.size = 9
    try await catalog.reconcile([changed], folder: "/", token: "during")
    #expect(try await catalog.folderTokens()["/"] == nil)
    // A removal skipped for the same reason is not vouched for either.
    try await catalog.reconcile([], folder: "/", token: "removed")
    #expect(try await catalog.folderTokens()["/"] == nil)
    // Cancelling the write leaves the skipped update to the next listing, never to a check.
    try await catalog.writeCancelled(operation)
    #expect(try await catalog.itemAt(file.path).entry.size == 5)
    try await catalog.reconcile([changed], folder: "/", token: "after")
    #expect(try await catalog.itemAt(file.path).entry.size == 9)
    #expect(try await catalog.folderTokens()["/"] == "after")
}

@Test func ownWritesForgetTheTokensOfEveryFolderTheyTouched() async throws {
    let (catalog, directory) = try catalogFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let a = entry("/a", kind: "dir"), b = entry("/b", kind: "dir")
    let file = entry("/a/file.txt"), sub = entry("/a/sub", kind: "dir"), inner = entry("/a/sub/inner", kind: "dir")
    try await catalog.reconcile([a, b], folder: "/", token: "root")
    try await catalog.reconcile([file, sub], folder: "/a", token: "a")
    try await catalog.reconcile([inner], folder: "/a/sub", token: "sub")
    try await catalog.reconcile([], folder: "/a/sub/inner", token: "inner")
    try await catalog.reconcile([], folder: "/b", token: "b")
    // A file move leaves both parents to be listed again.
    let moved = try await catalog.beginWrite(pending(try await catalog.itemAt(file.path), parent: catalog.itemAt(b.path), name: file.name))
    _ = try await catalog.finishWrite(moved, entry: entry("/b/file.txt", id: file.id!))
    #expect(try await catalog.folderTokens() == ["/": "root", "/a/sub": "sub", "/a/sub/inner": "inner"])
    // A folder rename rewrites every path below it; none of their tokens survive.
    let renamed = try await catalog.beginWrite(pending(try await catalog.itemAt(sub.path), parent: catalog.itemAt(a.path), name: "renamed"))
    _ = try await catalog.finishWrite(renamed, entry: entry("/a/renamed", kind: "dir", id: sub.id!))
    #expect(try await catalog.folderTokens() == ["/": "root"])
    #expect(try await catalog.folders().contains("/a/renamed/inner"))
}

@Test func checkedRefreshListsOnlyFoldersTheServerCannotVouchFor() async throws {
    let (catalog, directory) = try catalogFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await catalog.configure(WriteCapabilities(create: true, update: true, move: true, trash: true, restore: true))
    let a = entry("/a", kind: "dir"), b = entry("/b", kind: "dir"), c = entry("/c", kind: "dir")
    let cached = entry("/b/cached.txt"), kept = entry("/kept.txt")
    try await catalog.reconcile([a, b, c, kept], folder: "/", token: "root")
    try await catalog.reconcile([], folder: "/a", token: "a")
    try await catalog.reconcile([cached], folder: "/b", token: "b")
    try await catalog.reconcile([], folder: "/c")
    for path in [cached.path, kept.path] {
        _ = try await catalog.downloaded(try await catalog.itemAt(path).id, hash: "old", size: 5)
    }
    let added = entry("/a/added.txt")
    let client = CheckingClient()
    await client.configure(listings: ["/a": [added]], states: ["/a": .changed, "/b": .missing])
    try await refreshCatalog(catalog, client: client, checks: true) {}
    // Trash and the never-vouched folder are listed without asking; "/" and "/b" are not listed.
    #expect(await client.checked == [["/", "/a", "/b"]])
    #expect(await client.listed == [RemoteEntry.trashPath, "/a", "/c"])
    #expect(try await catalog.itemAt(added.path).entry == added)
    #expect(try await catalog.folderTokens()["/a"] == "listed:/a")
    #expect(try await catalog.folderTokens()["/c"] == "listed:/c")
    // A folder the server no longer has keeps its downloads out of validation.
    #expect(await client.validated == [kept.path])
}

@Test func checkedRefreshFallsBackPerBatchAndReportsFailuresAfterPublishing() async throws {
    let (catalog, directory) = try catalogFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let folders = (0..<150).map { entry(String(format: "/f%03d", $0), kind: "dir") }
    try await catalog.reconcile(folders, folder: "/", token: "root")
    for folder in folders { try await catalog.reconcile([], folder: folder.path, token: "t") }
    let listings = ["/": folders]
    let client = CheckingClient()
    // A server that only answers part of a batch is asked again for the rest.
    await client.configure(listings: listings, answers: 60)
    try await refreshCatalog(catalog, client: client, checks: true) {}
    #expect(await client.checked.map(\.count) == [100, 91, 31])
    #expect(await client.listed.isEmpty)
    // A server without the route lists every folder of the batch, as before.
    let fallback = CheckingClient()
    await fallback.configure(listings: listings, checkError: .missing)
    try await refreshCatalog(catalog, client: fallback, checks: true) {}
    #expect(await fallback.listed.count == 151)
    #expect(try await catalog.folderTokens().values.allSatisfy { $0.hasPrefix("listed:") })
    // An outage fails the refresh without listing or validating anything it could not check.
    let offline = CheckingClient()
    await offline.configure(listings: listings, checkError: .unavailable)
    let published = Published()
    await #expect(throws: DriveError.unavailable) {
        try await refreshCatalog(catalog, client: offline, checks: true) { await published.mark() }
    }
    #expect(await offline.listed.isEmpty)
    #expect(await published.count == 1)
    // A folder this connection may no longer read is a failure, after the rest is published.
    let denied = CheckingClient()
    await denied.configure(listings: listings, states: ["/f000": .forbidden, "/f001": .changed])
    await #expect(throws: DriveError.forbidden) {
        try await refreshCatalog(catalog, client: denied, checks: true) {}
    }
    #expect(await denied.listed == ["/f001"])
    // Without checks the refresh lists every folder, storing what each listing vouches for.
    let plain = CheckingClient()
    await plain.configure(listings: listings)
    try await refreshCatalog(catalog, client: plain) {}
    #expect(await plain.checked.isEmpty)
    #expect(await plain.listed.count == 151)
}
private actor Published {
    private(set) var count = 0
    func mark() { count += 1 }
}

@Test func refreshPacingAllowsAFifthOfASecondPerFolder() {
    let finished = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(nextAutomaticRefresh(finished: finished, took: 10, folders: 1_700) == finished.addingTimeInterval(340))
    #expect(nextAutomaticRefresh(finished: finished, took: 120, folders: 1_700) == finished.addingTimeInterval(480))
    #expect(nextAutomaticRefresh(finished: finished, took: 1, folders: 10) == finished.addingTimeInterval(4))
    #expect(nextAutomaticRefresh(finished: finished, took: 1, folders: 100_000) == finished.addingTimeInterval(900))
}
