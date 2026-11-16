import CryptoKit
import Foundation
import Testing
@testable import FdriveKit

private func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

@Suite struct AgeTests {
    @Test(arguments: [0, 1, 65_535, 65_536, 65_537, 200_000])
    func filesRoundTripAtThePredictedSize(_ length: Int) throws {
        let identity = AgeIdentity.generate()
        let plaintext = vectorPattern(length)
        let file = try Age.encrypt(plaintext, to: identity.recipient)
        // One X25519 stanza, as packages/crypto writes and sizes them.
        #expect(file.starts(with: Data("age-encryption.org/v1\n-> X25519 ".utf8)))
        #expect(Int64(file.count) == Age.encryptedSize(Int64(length)))
        #expect(Age.decryptedSize(Int64(file.count)) == Int64(length))
        #expect(try Age.decrypt(file, identity: identity) == plaintext)
        // A fresh file key and nonce every time.
        #expect(try Age.encrypt(plaintext, to: identity.recipient) != file)
    }

    @Test func filesStreamFileToFileWithBothDigests() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let identity = AgeIdentity.generate()
        let plaintext = vectorPattern(300_000)
        let source = directory.appendingPathComponent("source"), sealed = directory.appendingPathComponent("sealed")
        let clear = directory.appendingPathComponent("clear")
        try plaintext.write(to: source)
        let digests = try Age.encryptFile(source, to: sealed, recipient: identity.recipient)
        #expect(digests.plaintext == ContentDigest(sha256: sha256(plaintext), size: 300_000))
        let ciphertext = try Data(contentsOf: sealed)
        #expect(digests.ciphertext == ContentDigest(sha256: sha256(ciphertext), size: Age.encryptedSize(300_000)))
        #expect(try Age.decryptFile(sealed, to: clear, identity: identity) == digests.plaintext)
        #expect(try Data(contentsOf: clear) == plaintext)
        #expect(try Age.decryptFile(sealed, to: nil, identity: identity) == digests.plaintext)
    }

    @Test func damagedTruncatedForeignAndMalformedFilesAreRefused() throws {
        let identity = AgeIdentity.generate()
        let file = try Age.encrypt(vectorPattern(70_000), to: identity.recipient)
        let header = 168, chunk = 65_536 + 16
        var flippedPayload = file; flippedPayload[header + 16 + 100] ^= 1
        var flippedHeader = file; flippedHeader[30] = flippedHeader[30] == 65 ? 66 : 65
        let bodyLine = String(decoding: file.prefix(header), as: UTF8.self).split(separator: "\n")[2]
        let padded = Data(String(decoding: file.prefix(header), as: UTF8.self)
            .replacingOccurrences(of: String(bodyLine), with: bodyLine + "=").utf8) + file.dropFirst(header)
        let damaged: [(String, Data)] = [
            ("one byte short", file.dropLast()),
            ("cut after a whole chunk", file.prefix(header + 16 + chunk)),
            ("cut in the header", file.prefix(100)),
            ("no payload", file.prefix(header + 16)),
            ("a byte appended", file + Data([0])),
            ("a payload byte changed", flippedPayload),
            ("a header byte changed", flippedHeader),
            ("padded base64", padded),
            ("not an age file", Data("hello, world\n".utf8)),
        ]
        for (reason, data) in damaged {
            #expect(throws: DecryptError.self, "\(reason)") { try Age.decrypt(data, identity: identity) }
        }
        #expect(throws: DecryptError.self) { try Age.decrypt(file, identity: AgeIdentity.generate()) }
        #expect(Age.decryptedSize(100) == nil && Age.decryptedSize(Age.encryptedSize(65_536) + 1) == nil)
    }

    @Test func keysEncodeAsAgeDoes() throws {
        let identity = AgeIdentity.generate()
        #expect(identity.string.hasPrefix("AGE-SECRET-KEY-1") && identity.string.count == 74)
        #expect(try AgeIdentity(identity.string) == identity)
        #expect(try AgeIdentity(identity.string.lowercased()) == identity)
        #expect(identity.recipient.string.hasPrefix("age1") && identity.recipient.string.count == 62)
        #expect(try AgeRecipient(identity.recipient.string) == identity.recipient)
        let mixed = "AGE-SECRET-KEY-1" + identity.string.dropFirst(16).lowercased()
        var corrupt = Array(identity.recipient.string)
        corrupt[10] = corrupt[10] == "q" ? "p" : "q"
        #expect(throws: DecryptError.self) { try AgeIdentity(mixed) }
        #expect(throws: DecryptError.self) { try AgeRecipient(String(corrupt)) }
        #expect(throws: DecryptError.self) { try AgeRecipient(identity.string) }
        #expect(throws: DecryptError.self) { try AgeIdentity(identity.recipient.string) }
    }
}

@Suite struct EncryptedNameTests {
    @Test func namesRoundTripInNFCAndBindToTheirFolder() throws {
        let folder = FolderKey(id: UUID().uuidString.lowercased(), identity: .generate())
        let stored = try EncryptedNames.encrypt("Mo\u{308}te.txt", key: folder)
        #expect(EncryptedNames.isEncrypted(stored) && stored == stored.lowercased())
        let clear = try #require(EncryptedNames.decrypt(stored, key: folder))
        #expect(Array(clear.unicodeScalars) == Array("M\u{f6}te.txt".unicodeScalars))
        #expect(try EncryptedNames.encrypt("Möte.txt", key: folder) != stored)
        // Another folder's key, or the same key under another folder id, opens nothing.
        #expect(EncryptedNames.decrypt(stored, key: FolderKey(id: folder.id, identity: .generate())) == nil)
        #expect(EncryptedNames.decrypt(stored, key: FolderKey(id: UUID().uuidString.lowercased(), identity: folder.identity)) == nil)
        #expect(EncryptedNames.decrypt("notes.txt", key: folder) == nil)
        #expect(EncryptedNames.decrypt(String(stored.dropLast()), key: folder) == nil)
    }

    @Test func namesHaveTheFoldersLimits() throws {
        let folder = FolderKey(id: UUID().uuidString.lowercased(), identity: .generate())
        let longest = try EncryptedNames.encrypt(String(repeating: "å", count: 64), key: folder)
        #expect(EncryptedNames.isEncrypted(longest))
        #expect(throws: NameError.tooLong) { try EncryptedNames.encrypt(String(repeating: "a", count: 129), key: folder) }
        for invalid in ["", ".", "..", "a/b", "a\u{0}b"] {
            #expect(throws: NameError.invalid) { try EncryptedNames.encrypt(invalid, key: folder) }
        }
        for shape in ["fe1-", "fe1-AAAA" + String(repeating: "a", count: 50), "fe2-" + String(repeating: "a", count: 47),
                      "fe1-" + String(repeating: "a", count: 46), "fe1-" + String(repeating: "a", count: 49)] {
            #expect(!EncryptedNames.isEncrypted(shape))
        }
        #expect(trashDisplayName("report.pdf", handle: "1a2b3c4d-0000") == "report (deleted 1a2b3c4d).pdf")
        #expect(numberedName("a.txt", 2) == "a (2).txt" && numberedName("Notes", 3) == "Notes (3)")
    }
}

/// A folder `/Secret` that is an encrypted folder, in a catalog that can open it.
private struct EncryptedFolder {
    static let full = WriteCapabilities(create: true, update: true, move: true, trash: true, restore: true)
    let catalog: Catalog, directory: URL, account: AgeIdentity
    let marker: EncryptedFolderMarker, folder: FolderKey, top: RemoteEntry
    var info: EncryptedFolderInfo { EncryptedFolderInfo(path: top.path, marker: marker) }
    init(account: AgeIdentity = .generate(), keyring: EncryptionKeyring? = nil) async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        self.account = account
        catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Encrypted",
                              keyring: keyring ?? EncryptionKeyring(account: account))
        try await catalog.configure(Self.full)
        let created = try EncryptedFolderMarker.create(for: account)
        marker = created.marker; folder = created.folder
        var top = Self.entry("/Secret", kind: "dir"); top.encrypted = true
        self.top = top
        try await catalog.reconcile([top, Self.entry("/plain.txt")], folder: "/")
    }
    static func entry(_ path: String, kind: String = "file", size: Int64 = 5, parentId: String = "root") -> RemoteEntry {
        let id = UUID().uuidString.lowercased()
        var entry = RemoteEntry(path: path, name: String(path.split(separator: "/").last!), kind: kind, size: kind == "dir" ? 0 : size)
        entry.id = id; entry.parentId = parentId; entry.capabilities = full
        entry.version = WriteVersion(content: String(repeating: "a", count: 64), metadata: "meta-" + id.prefix(8))
        return entry
    }
    /// An entry in `/Secret` named `clear`, encrypted.
    func inside(_ clear: String, kind: String = "file", size: Int64 = 5) throws -> RemoteEntry {
        Self.entry("/Secret/" + (try EncryptedNames.encrypt(clear, key: folder)), kind: kind, size: size, parentId: top.id!)
    }
    func shown(_ entry: RemoteEntry) async throws -> CatalogItem { try await catalog.itemAt(entry.path) }
    func close() { try? FileManager.default.removeItem(at: directory) }
}

@Suite struct EncryptedCatalogTests {
    @Test func aListingShowsDecryptedNamesAndKeepsTheServersForRequests() async throws {
        let f = try await EncryptedFolder(); defer { f.close() }
        let report = try f.inside("report.pdf", size: Age.encryptedSize(1_000)), notes = try f.inside("Notes", kind: "dir")
        let first = try f.inside("a.txt"), second = try f.inside("A.TXT")
        let stray = EncryptedFolder.entry("/Secret/dropped.jpg", parentId: f.top.id!)
        try await f.catalog.reconcile([report, notes, first, second, stray], folder: "/Secret", encryptedFolder: f.info)
        #expect(try await f.catalog.itemAt("/Secret").encryptedFolderId == f.marker.id)
        let item = try await f.shown(report)
        #expect(item.displayName == "report.pdf" && item.entry.name == report.name && item.entry.path == report.path)
        #expect(item.encryptedIn == f.marker.id && item.stray == nil)
        // Finder renames on a metadata change; the server gets its own version back.
        #expect(item.metadataVersion != report.version!.metadata)
        #expect(CatalogItem.serverVersion(item.metadataVersion) == report.version!.metadata)
        #expect(try await f.shown(notes).displayName == "Notes")
        // Two names the server cannot tell apart decrypt alike: both show, one numbered.
        let duplicates = [try await f.shown(first).displayName, try await f.shown(second).displayName]
        #expect(Set(duplicates.map { $0.lowercased() }) == ["a.txt", "a (2).txt"])
        let unreadable = try await f.shown(stray)
        #expect(unreadable.stray == true && unreadable.displayName.hasPrefix("Unreadable item ") && unreadable.encryptedIn == f.marker.id)
        // Outside encrypted folders, names that collide on macOS still fail the listing.
        await #expect(throws: DriveError.self) {
            try await f.catalog.reconcile([EncryptedFolder.entry("/x.txt"), EncryptedFolder.entry("/X.txt")], folder: "/")
        }
    }

    @Test func aFolderKnownToBeEncryptedIsNotListedWithoutItsMarker() async throws {
        let f = try await EncryptedFolder(); defer { f.close() }
        let report = try f.inside("report.pdf")
        try await f.catalog.reconcile([report], folder: "/Secret", encryptedFolder: f.info)
        await #expect(throws: DriveError.locked(EncryptionLock.unlisted)) {
            try await f.catalog.reconcile([report], folder: "/Secret")
        }
        #expect(try await f.shown(report).displayName == "report.pdf")
    }

    @Test(arguments: [false, true])
    func withoutTheAccountKeyEncryptedFoldersStayLocked(_ foreign: Bool) async throws {
        let keyring = EncryptionKeyring(account: foreign ? AgeIdentity.generate() : nil)
        let f = try await EncryptedFolder(keyring: keyring); defer { f.close() }
        let report = try f.inside("report.pdf")
        await #expect(throws: DriveError.locked(foreign ? EncryptionLock.foreign : EncryptionLock.noKey)) {
            try await f.catalog.reconcile([report], folder: "/Secret", encryptedFolder: f.info)
        }
        let top = try await f.catalog.itemAt("/Secret")
        #expect(try await f.catalog.children(top.id).isEmpty)
        await #expect(throws: DriveError.locked(EncryptionLock.unseen)) { try await f.catalog.folderKey(f.marker.id) }
    }

    @Test func trashShowsItemsFromAnEncryptedFolderByTheirClearName() async throws {
        let f = try await EncryptedFolder(); defer { f.close() }
        let report = try f.inside("report.pdf")
        try await f.catalog.reconcile([report], folder: "/Secret", encryptedFolder: f.info)
        func trashed(_ name: String, from original: String) -> RemoteEntry {
            var entry = EncryptedFolder.entry(RemoteEntry.trashPath + "/x", parentId: "trash")
            entry.path = RemoteEntry.trashPath + "/" + entry.id!
            entry.name = trashDisplayName(name, handle: entry.id!); entry.trashed = true; entry.originalPath = original
            return entry
        }
        let known = trashed(report.name, from: report.path)
        let unknown = trashed(try EncryptedNames.encrypt("x", key: FolderKey(id: UUID().uuidString, identity: .generate())),
                              from: "/Elsewhere/fe1-" + String(repeating: "a", count: 47))
        let plain = trashed("plain.txt", from: "/plain.txt")
        try await f.catalog.reconcile([known, unknown, plain], folder: RemoteEntry.trashPath)
        let shown = try await f.shown(known)
        #expect(shown.displayName == "report (deleted \(known.id!.prefix(8))).pdf" && shown.encryptedIn == f.marker.id)
        #expect(shown.stray == nil)
        #expect(try await f.shown(unknown).displayName == "Encrypted item (deleted \(unknown.id!.prefix(8)))")
        #expect(try await f.shown(unknown).stray == true)
        let untouched = try await f.shown(plain)
        #expect(untouched.displayName == plain.name && untouched.encryptedIn == nil)
    }

    @Test func aConflictCopyIsNamedFromTheClearNameThenEncrypted() async throws {
        let f = try await EncryptedFolder(); defer { f.close() }
        try await f.catalog.reconcile([], folder: "/Secret", encryptedFolder: f.info)
        let id = UUID().uuidString.lowercased()
        var pending = PendingWrite(id: id, key: id, localId: UUID().uuidString, route: "uploads",
            request: WriteRequest(operationId: id, itemId: nil, parentId: f.top.id!,
                                  name: try EncryptedNames.encrypt("plan.txt", key: f.folder), base: nil, size: 5, sha256: "digest"))
        pending.encryptedIn = f.marker.id; pending.clearName = "plan.txt"
        _ = try await f.catalog.beginWrite(pending)
        let copy = try #require(try await f.catalog.conflictCopy(pending))
        #expect(copy.clearName == "plan (conflict \(id.prefix(8))).txt" && copy.originalName == "plan.txt")
        #expect(EncryptedNames.decrypt(copy.request.name, key: f.folder) == copy.clearName)
    }
}

/// A server for one encrypted folder: answers prepares, uploads, commits and listings from the
/// requests it saw. Serialized suites only.
private final class FolderServer: URLProtocol, @unchecked Sendable {
    final class State: @unchecked Sendable {
        let lock = NSLock()
        /// Request paths with their header, in order.
        var calls: [(path: String, encryptedHeader: String?)] = []
        var prepared: [String: [String: Any]] = [:]
        var uploaded: [String: Data] = [:]
        /// Server handle → folder path, for items a commit returns.
        var folders: [String: String] = ["root": ""]
        /// Server handle → path, for items a test moves to Trash and back.
        var origins: [String: String] = [:]
        /// Answers `/content` instead of accepting the body.
        var contentFailure: Int?
        var listing: (String) -> String? = { _ in nil }
        var answer: ((String) -> (Int, String))?
        var paths: [String] { lock.withLock { calls.map { String($0.path.split(separator: "/").last ?? "") } } }
    }
    nonisolated(unsafe) static var state = State()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private var body: Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var read = Data(), buffer = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            read.append(buffer, count: count)
        }
        return read
    }
    private static func result(_ id: String, _ state: String, item: RemoteEntry? = nil) -> String {
        let json = item.map { String(decoding: try! JSONEncoder().encode($0), as: UTF8.self) } ?? "null"
        return "{\"operationId\":\"\(id)\",\"state\":\"\(state)\",\"item\":\(json),\"recoveryId\":null}"
    }
    override func startLoading() {
        let state = Self.state, path = request.url?.path ?? "", body = self.body
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
        let (status, text): (Int, String) = state.lock.withLock {
            state.calls.append((path, request.value(forHTTPHeaderField: "x-fdrive-encrypted-folders")))
            if let answer = state.answer { return answer(path) }
            let parts = path.split(separator: "/").map(String.init)
            if path.hasSuffix("/entries"), let query, let listing = state.listing(query) { return (200, listing) }
            if let route = ["uploads", "folders", "moves"].first(where: { path.hasSuffix("/" + $0) }) {
                let json = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
                let id = json["operationId"] as? String ?? ""
                state.prepared[id] = json.merging(["route": route]) { first, _ in first }
                return (200, Self.result(id, route == "uploads" ? "receiving" : "ready"))
            }
            guard let index = parts.firstIndex(of: "operations"), index + 1 < parts.count else { return (404, "{}") }
            let id = parts[index + 1]
            if path.hasSuffix("/content") {
                if let failure = state.contentFailure { return (failure, "{}") }
                state.uploaded[id] = body
                return (200, Self.result(id, "ready"))
            }
            if path.hasSuffix("/commit"), let json = state.prepared[id] {
                let parent = json["parentId"] as? String ?? "root"
                var name = json["name"] as? String ?? ""
                let route = json["route"] as? String, handle = json["itemId"] as? String ?? UUID().uuidString.lowercased()
                let origin = state.origins[handle], leaf = origin.map { String($0.split(separator: "/").last!) }
                // As the server does: Trash names its items by handle, and a restore under that name takes back the original.
                if parent != "trash", let leaf, name == trashDisplayName(leaf, handle: handle) { name = leaf }
                var item = RemoteEntry(path: (state.folders[parent] ?? "") + "/" + name, name: name,
                                       kind: route == "folders" ? "dir" : "file", size: Int64(json["size"] as? Int ?? 0))
                if parent == "trash", let leaf {
                    item.path = RemoteEntry.trashPath + "/" + handle; item.name = trashDisplayName(leaf, handle: handle)
                    item.trashed = true; item.originalPath = origin
                }
                item.id = handle; item.parentId = parent
                item.version = WriteVersion(content: json["sha256"] as? String ?? "digest", metadata: "committed")
                item.capabilities = EncryptedFolder.full
                return (200, Self.result(id, "completed", item: item))
            }
            return (200, Self.result(id, "acknowledged"))
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                              headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// `/Secret` and a session that reaches `FolderServer`.
private struct Writing {
    let f: EncryptedFolder, writer: WriteCoordinator, session: URLSession, state = FolderServer.State()
    init() async throws {
        f = try await EncryptedFolder()
        FolderServer.state = state
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FolderServer.self]
        session = URLSession(configuration: configuration)
        let client = try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test", session: session, protocolVersion: 2)
        writer = WriteCoordinator(catalog: f.catalog, client: client, maxUploadBytes: 1 << 30)
        state.folders[f.top.id!] = f.top.path
    }
    var client: APIClient { writer.client }
    func file(_ text: String) throws -> URL {
        let url = f.directory.appendingPathComponent(UUID().uuidString)
        try Data(text.utf8).write(to: url)
        return url
    }
    func secret() async throws -> CatalogItem { try await f.catalog.itemAt("/Secret") }
    func upload(_ name: String, _ text: String, parent: String? = nil) async throws -> CatalogItem {
        let secretId = try await secret().id
        return try await writer.perform(route: "uploads", localId: nil, templateKey: name, parentId: parent ?? secretId,
                                        name: name, base: nil, contents: file(text), progress: Progress(totalUnitCount: -1))
    }
    func move(_ item: CatalogItem, to parent: String, name: String) async throws -> CatalogItem {
        try await writer.perform(route: "moves", localId: item.id, templateKey: item.id, parentId: parent, name: name,
                                 base: WriteVersion(content: item.contentVersion, metadata: item.metadataVersion),
                                 contents: nil, progress: Progress(totalUnitCount: -1))
    }
    func close() { session.invalidateAndCancel(); f.close() }
}

@Suite(.serialized, .timeLimit(.minutes(1))) struct EncryptedWriteTests {
    @Test func aNewFileIsEncryptedIntoItsRecoveryCopyUnderAnEncryptedName() async throws {
        let w = try await Writing(); defer { w.close() }
        try await w.f.catalog.reconcile([], folder: "/Secret", encryptedFolder: w.f.info)
        w.state.contentFailure = 503
        await #expect(throws: DriveError.unavailable) { _ = try await w.upload("plan.txt", "hello world") }
        let pending = try #require(try await w.f.catalog.pendingWrites().first)
        #expect(EncryptedNames.decrypt(pending.request.name, key: w.f.folder) == "plan.txt")
        #expect(pending.clearName == "plan.txt" && pending.encryptedIn == w.f.marker.id)
        #expect(pending.plainDigest == sha256(Data("hello world".utf8)))
        let copy = try Data(contentsOf: w.f.catalog.recoveryDirectory.appendingPathComponent(pending.id).appendingPathComponent("content"))
        // The server stages and checks the ciphertext; only this Mac's key opens it.
        #expect(pending.request.sha256 == sha256(copy) && pending.request.size == Int64(copy.count))
        #expect(Int64(copy.count) == Age.encryptedSize(11))
        #expect(try Age.decrypt(copy, identity: w.f.folder.identity) == Data("hello world".utf8))
        // Finder's replay finds the same write although its name and bytes are new each time.
        await #expect(throws: DriveError.unavailable) { _ = try await w.upload("plan.txt", "hello world") }
        #expect(try await w.f.catalog.pendingWrites().count == 1)
        #expect(w.state.lock.withLock { w.state.calls.allSatisfy { $0.encryptedHeader == "1" } })
    }

    @Test func aCommittedFileShowsItsClearNameAndAReimportFindsIt() async throws {
        let w = try await Writing(); defer { w.close() }
        try await w.f.catalog.reconcile([], folder: "/Secret", encryptedFolder: w.f.info)
        let item = try await w.upload("plan.txt", "hello world")
        #expect(item.displayName == "plan.txt" && item.encryptedIn == w.f.marker.id && item.materialized)
        #expect(EncryptedNames.decrypt(item.entry.name, key: w.f.folder) == "plan.txt")
        #expect(item.plainDigest == sha256(Data("hello world".utf8)))
        let uploaded = try #require(w.state.lock.withLock { w.state.uploaded.values.first })
        #expect(try Age.decrypt(uploaded, identity: w.f.folder.identity) == Data("hello world".utf8))
        // A reimport compares plaintext, never the ciphertext.
        var listed = item.entry; listed.version = WriteVersion(content: item.contentVersion, metadata: "committed")
        let listing = Listing(entries: [listed], nextCursor: nil, encryptedFolder: w.f.info)
        let json = String(decoding: try JSONEncoder().encode(listing), as: UTF8.self)
        w.state.lock.withLock { w.state.listing = { $0 == "/Secret" ? json : nil } }
        let secret = try await w.secret()
        let same = try await w.writer.reimport(parentId: secret.id, name: "plan.txt", directory: false, contents: w.file("hello world"))
        #expect(same?.id == item.id)
        #expect(try await w.writer.reimport(parentId: secret.id, name: "plan.txt", directory: false, contents: w.file("changed")) == nil)
        #expect(try await w.writer.reimport(parentId: secret.id, name: "other.txt", directory: false, contents: w.file("x")) == nil)
    }

    @Test func renamesEncryptTheNewNameAndAnUnchangedNameKeepsTheServers() async throws {
        let w = try await Writing(); defer { w.close() }
        let a = try w.f.inside("a.txt"), sub = try w.f.inside("Sub", kind: "dir")
        try await w.f.catalog.reconcile([a, sub], folder: "/Secret", encryptedFolder: w.f.info)
        w.state.folders[sub.id!] = sub.path
        let renamed = try await w.move(try await w.f.shown(a), to: try await w.secret().id, name: "b.txt")
        #expect(renamed.displayName == "b.txt" && renamed.entry.name != a.name)
        #expect(EncryptedNames.decrypt(renamed.entry.name, key: w.f.folder) == "b.txt")
        let moved = try await w.move(renamed, to: try await w.f.shown(sub).id, name: "b.txt")
        #expect(moved.entry.name == renamed.entry.name && moved.entry.path == sub.path + "/" + renamed.entry.name)
        #expect(moved.displayName == "b.txt")
        // Finder's metadata version goes back to the server as the server's own.
        let bases = w.state.lock.withLock { w.state.prepared.values.compactMap { ($0["base"] as? [String: Any])?["metadata"] as? String } }
        #expect(bases.allSatisfy { !$0.contains("\u{1F}") } && bases.count == 2)
    }

    @Test func trashKeepsTheClearNameAndRestoresOnlyIntoTheEncryptedFolder() async throws {
        let w = try await Writing(); defer { w.close() }
        let a = try w.f.inside("a.txt")
        try await w.f.catalog.reconcile([a], folder: "/Secret", encryptedFolder: w.f.info)
        w.state.lock.withLock { w.state.origins[a.id!] = a.path }
        // Finder trashes under the name it shows; the server gets its own.
        let trashed = try await w.move(try await w.f.shown(a), to: "trash", name: "a.txt")
        #expect(trashed.parentId == "trash" && trashed.encryptedIn == w.f.marker.id)
        #expect(trashed.displayName == "a (deleted \(a.id!.prefix(8))).txt")
        await #expect(throws: DriveError.encryptedFolder(WriteCoordinator.restoreRefusal)) {
            _ = try await w.move(trashed, to: "root", name: trashed.displayName)
        }
        let secret = try await w.secret()
        let restored = try await w.move(trashed, to: secret.id, name: trashed.displayName)
        #expect(restored.entry.path == a.path && restored.displayName == "a.txt" && restored.parentId == secret.id)
        let names = w.state.lock.withLock { w.state.prepared.values.map { $0["name"] as? String ?? "" } }
        #expect(Set(names) == [a.name, trashed.entry.name])
    }

    @Test func movesAcrossTheEdgeAndBadNamesAreRefusedBeforeAnythingIsSent() async throws {
        let w = try await Writing(); defer { w.close() }
        let a = try w.f.inside("a.txt")
        try await w.f.catalog.reconcile([a], folder: "/Secret", encryptedFolder: w.f.info)
        let secret = try await w.secret(), plain = try await w.f.catalog.itemAt("/plain.txt")
        await #expect(throws: DriveError.encryptedFolder(WriteCoordinator.edgeRefusal)) {
            _ = try await w.move(plain, to: secret.id, name: "plain.txt")
        }
        await #expect(throws: DriveError.encryptedFolder(WriteCoordinator.edgeRefusal)) {
            _ = try await w.move(try await w.f.shown(a), to: "root", name: "a.txt")
        }
        await #expect(throws: DriveError.nameTooLong) { _ = try await w.upload(String(repeating: "n", count: 129), "x") }
        await #expect(throws: DriveError.self) { _ = try await w.upload("A.TXT", "x") }
        #expect(w.state.paths.isEmpty)
        #expect(try await w.f.catalog.pendingWrites().isEmpty)
    }

    @Test func pairingSendsTheDeviceRecipientAndRefusalsAreNotRetried() async throws {
        let w = try await Writing(); defer { w.close() }
        let pairing = "{\"id\":\"p\",\"secret\":\"s\",\"code\":\"C\",\"expiresAt\":\"2030-01-01T00:00:00.000Z\",\"nonce\":\"n\"}"
        w.state.lock.withLock { w.state.answer = { _ in (200, pairing) } }
        let paired = try await w.client.pair(deviceName: "Mac", deviceRecipient: AgeIdentity.generate().recipient.string)
        #expect(paired.sentRecipient && paired.pairing.nonce == "n")
        // A server older than encrypted folders refuses the field; pairing goes on without it.
        var first = true
        w.state.lock.withLock { w.state.answer = { _ in defer { first = false }; return first ? (400, "{}") : (200, pairing) } }
        #expect(try await !w.client.pair(deviceName: "Mac", deviceRecipient: AgeIdentity.generate().recipient.string).sentRecipient)
        w.state.lock.withLock { w.state.answer = { _ in (404, "{}") } }
        #expect(try await w.client.encryptionKey() == nil)
        let refusal = "{\"error\":{\"message\":\"Only encrypted names belong here\",\"details\":{\"code\":\"encrypted_folder\"}}}"
        w.state.lock.withLock { w.state.answer = { _ in (403, refusal) } }
        await #expect(throws: DriveError.encryptedFolder("Only encrypted names belong here")) { _ = try await w.client.list("/Secret") }
    }
}
