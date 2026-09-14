import Foundation
import SQLite3

private final class DatabaseConnection: @unchecked Sendable {
    let pointer: OpaquePointer
    init(_ pointer: OpaquePointer) { self.pointer = pointer }
    deinit { sqlite3_close(pointer) }
}

/// Each domain has a SQLite store shared between the app and extension. FULLMUTEX protects
/// a connection; BEGIN IMMEDIATE serializes revision allocation across the two processes.
public actor Catalog {
    public nonisolated let recoveryDirectory: URL
    private let connection: DatabaseConnection
    private let retainedRevisions: Int64
    private var database: OpaquePointer { connection.pointer }
    public init(url: URL, title: String, retainedRevisions: Int64 = 100_000) throws {
        self.recoveryDirectory = url.deletingPathExtension().appendingPathExtension("recovery")
        guard retainedRevisions > 0 else { throw DriveError.database("Invalid history retention.") }
        self.retainedRevisions = retainedRevisions
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var connection: OpaquePointer?
        guard sqlite3_open_v2(url.path, &connection, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let connection else { throw DriveError.database("Could not open the local metadata store.") }
        self.connection = DatabaseConnection(connection)
        sqlite3_busy_timeout(connection, 10_000)
        var version: OpaquePointer?
        sqlite3_prepare_v2(connection, "PRAGMA user_version", -1, &version, nil)
        let supported = sqlite3_step(version) == SQLITE_ROW && sqlite3_column_int(version, 0) <= 3
        sqlite3_finalize(version)
        guard supported else {
            throw DriveError.database("This metadata store requires a newer version of fdrive.")
        }
        let schema = """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO state VALUES ('revision','0');
        INSERT OR IGNORE INTO state VALUES ('generation',lower(hex(randomblob(16))));
        INSERT OR IGNORE INTO state VALUES ('retainedRevision','0');
        CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, path TEXT NOT NULL, parent TEXT NOT NULL,
          value BLOB NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS live_path ON items(path) WHERE deleted=0;
        CREATE INDEX IF NOT EXISTS item_parent ON items(parent,deleted);
        CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS listings (path TEXT PRIMARY KEY, token TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pending (key TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, localId TEXT NOT NULL, value TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS departures (id TEXT NOT NULL, parent TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS departure_revision ON departures(revision);
        PRAGMA user_version=3;
        COMMIT;
        """
        guard sqlite3_exec(connection, schema, nil, nil, nil) == SQLITE_OK else {
            throw DriveError.database("Could not initialize the local metadata store.")
        }
        let root = CatalogItem(id: "root", parentId: "root", entry: .init(path: "/", name: title, kind: "dir"),
                               contentVersion: "root", metadataVersion: "root", materialized: false)
        let bytes = try JSONEncoder().encode(root)
        var statement: OpaquePointer?
        sqlite3_prepare_v2(connection, "INSERT OR IGNORE INTO items VALUES ('root','/','root',?,0,0)", -1, &statement, nil)
        defer { sqlite3_finalize(statement) }
        _ = bytes.withUnsafeBytes { sqlite3_bind_blob(statement, 1, $0.baseAddress, Int32($0.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw DriveError.database("Could not initialize the root folder.") }
    }
    private func execute(_ sql: String, _ values: [String] = []) throws {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw DriveError.database(String(cString: sqlite3_errmsg(database))) }
    }
    private func prepare(_ sql: String, _ values: [String]) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw DriveError.database(String(cString: sqlite3_errmsg(database)))
        }
        for (index, value) in values.enumerated() {
            _ = value.withCString { sqlite3_bind_text(statement, Int32(index + 1), $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
        }
        return statement
    }
    private func rows(_ sql: String, _ values: [String] = []) throws -> [[String]] {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        var rows: [[String]] = []
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
            rows.append((0..<sqlite3_column_count(statement)).map { column in
                sqlite3_column_text(statement, column).map { String(cString: $0) } ?? ""
            })
            result = sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw DriveError.database("Could not read local metadata.") }
        return rows
    }
    private func decode(_ value: String) throws -> CatalogItem { try JSONDecoder().decode(CatalogItem.self, from: Data(value.utf8)) }
    public func item(_ id: String) throws -> CatalogItem {
        guard let row = try rows("SELECT value FROM items WHERE id=? AND deleted=0", [id]).first else { throw DriveError.missing }
        return try decode(row[0])
    }
    public func itemAt(_ path: String) throws -> CatalogItem {
        guard let row = try rows("SELECT value FROM items WHERE path=? AND deleted=0", [path]).first else { throw DriveError.missing }
        return try decode(row[0])
    }
    public func children(_ parent: String) throws -> [CatalogItem] {
        try rows("SELECT value FROM items WHERE parent=? AND id NOT IN ('root','trash') AND deleted=0 ORDER BY path", [parent]).map { try decode($0[0]) }
    }
    public func all() throws -> [CatalogItem] { try rows("SELECT value FROM items WHERE deleted=0 ORDER BY path").map { try decode($0[0]) } }
    public func folders() throws -> [String] { try rows("SELECT path FROM folders ORDER BY path").map { $0[0] } }
    public func hasListing(_ path: String) throws -> Bool { !(try rows("SELECT path FROM folders WHERE path=?", [path])).isEmpty }
    public func generation() throws -> String { try rows("SELECT value FROM state WHERE key='generation'")[0][0] }
    public func revision() throws -> Int64 { Int64(try rows("SELECT value FROM state WHERE key='revision'")[0][0]) ?? 0 }
    /// Rename only the domain root's display metadata; preserve the catalog and cached items.
    public func updateRootName(_ title: String) throws {
        try transaction {
            var root = try item("root")
            guard root.entry.name != title else { return }
            root.entry.name = title
            root.metadataVersion = UUID().uuidString
            try save(root)
        }
    }
    private func next() throws -> Int64 {
        try execute("UPDATE state SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")
        return try revision()
    }
    private func save(_ item: CatalogItem) throws {
        if let previous = try? self.item(item.id), previous.parentId != item.parentId {
            try execute("INSERT INTO departures VALUES (?,?,?)", [item.id, previous.parentId, String(try next())])
        }
        let json = String(decoding: try JSONEncoder().encode(item), as: UTF8.self)
        try execute("INSERT INTO items VALUES (?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,parent=excluded.parent,value=excluded.value,deleted=0,revision=excluded.revision",
                    [item.id, item.entry.path, item.parentId, json, String(try next())])
    }
    private func transaction<T>(_ action: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let value = try action()
            let floor = max(0, try revision() - retainedRevisions)
            try execute("DELETE FROM items WHERE deleted=1 AND revision<=?", [String(floor)])
            try execute("DELETE FROM departures WHERE revision<=?", [String(floor)])
            try execute("UPDATE state SET value=MAX(CAST(value AS INTEGER),CAST(? AS INTEGER)) WHERE key='retainedRevision'", [String(floor)])
            try execute("COMMIT"); return value
        }
        catch { try? execute("ROLLBACK"); throw error }
    }
    /// Reserve before network access. A slower listing cannot overwrite a newer request
    /// from the other process, or recreate descendants removed while it was in flight.
    public func beginListing(_ folder: String) throws -> String {
        try transaction {
            _ = try itemAt(folder)
            let token = UUID().uuidString
            try execute("INSERT INTO listings VALUES (?,?) ON CONFLICT(path) DO UPDATE SET token=excluded.token", [folder, token])
            return token
        }
    }
    /// Only complete listings enter this transaction. A timeout cannot turn a folder empty.
    public func reconcile(_ entries: [RemoteEntry], folder: String, listing: String? = nil) throws {
        try transaction {
            if let listing, try rows("SELECT token FROM listings WHERE path=?", [folder]).first?.first != listing { return }
            let parent = try itemAt(folder)
            guard parent.entry.kind == "dir" else { throw DriveError.unsupported }
            var names = Set<String>(); var paths = Set<String>()
            // The synthetic recovery container occupies ".Trash" in the root folder.
            let reserved: Set<String> = folder == "/" && (try? item("trash")) != nil ? [".trash"] : []
            for entry in entries {
                guard try canonicalPath(entry.path) == entry.path, parentPath(entry.path) == folder,
                      entry.hasValidListingName, paths.insert(entry.path).inserted else { throw DriveError.server("Invalid folder snapshot.") }
                // Refuse an ambiguous listing on the default case-insensitive macOS volume.
                let key = entry.name.precomposedStringWithCanonicalMapping.lowercased()
                guard names.insert(key).inserted, !reserved.contains(key),
                      !entry.name.contains(":"), entry.name != ".", entry.name != ".." else {
                    throw DriveError.server("This folder contains names that conflict on macOS. Rename them in fdrive and refresh.")
                }
            }
            let existing = try children(parent.id)
            let pendingIds = Set(try pendingWrites().filter { $0.result == nil }.map(\.localId))
            let byPath = Dictionary(uniqueKeysWithValues: entries.map { ($0.path, $0) })
            // A different kind or server handle at an unchanged path is a removal followed
            // by a new item, so cached bytes never serve a recreated file. A handle that
            // moved elsewhere in this listing reclaims its item below by remote ID.
            let removed = existing.filter { item in
                guard let entry = byPath[item.entry.path], entry.kind == item.entry.kind else { return true }
                if let old = item.entry.id, let new = entry.id, old != new { return true }
                return false
            }
            let knownItems = removed.isEmpty ? [] : try all()
            for removedItem in removed {
                if pendingIds.contains(removedItem.id) { continue }
                for descendant in knownItems where descendant.entry.path == removedItem.entry.path || descendant.entry.path.hasPrefix(removedItem.entry.path + "/") {
                    if pendingIds.contains(descendant.id) { continue }
                    try execute("UPDATE items SET deleted=1,revision=? WHERE id=?", [String(try next()), descendant.id])
                    try execute("DELETE FROM folders WHERE path=?", [descendant.entry.path])
                    try execute("DELETE FROM listings WHERE path=?", [descendant.entry.path])
                }
            }
            for entry in entries {
                let found: CatalogItem?
                if let remoteId = entry.id, let row = try rows("SELECT value FROM items WHERE json_extract(value,'$.entry.id')=?", [remoteId]).first {
                    found = try decode(row[0])
                } else { do { found = try itemAt(entry.path) } catch DriveError.missing { found = nil } }
                if var current = found {
                    if pendingIds.contains(current.id) { continue }
                    if current.entry != entry || (try? self.item(current.id)) == nil {
                        if current.entry.size != entry.size || current.entry.modifiedAt != entry.modifiedAt {
                            current.contentVersion = UUID().uuidString
                            current.localModificationDate = nil
                        }
                        current.entry = entry; current.parentId = parent.id
                        current.metadataVersion = entry.version?.metadata ?? UUID().uuidString
                        try save(current)
                    }
                } else {
                    try save(CatalogItem(id: UUID().uuidString, parentId: parent.id, entry: entry,
                                         contentVersion: entry.version?.content ?? UUID().uuidString, metadataVersion: entry.version?.metadata ?? UUID().uuidString, materialized: false))
                }
            }
            try execute("INSERT OR IGNORE INTO folders VALUES (?)", [folder])
        }
    }
    public func downloaded(_ id: String, hash: String, size: Int64, expectedVersion: String? = nil) throws -> CatalogItem {
        try transaction {
            var current = try item(id)
            if let expectedVersion, current.contentVersion != expectedVersion { throw DriveError.changedContent }
            current.contentVersion = hash; current.entry.size = size; current.materialized = true
            try save(current); return current
        }
    }
    public func validate(_ versions: [ContentVersion], expecting: [String: String]? = nil) throws {
        try transaction {
            let pendingIds = Set(try pendingWrites().filter { $0.result == nil }.map(\.localId))
            for version in versions {
                let found: CatalogItem?
                do { found = try itemAt(version.path) } catch DriveError.missing { found = nil }
                guard var current = found, current.materialized, !pendingIds.contains(current.id),
                      current.contentVersion != version.version,
                      expecting == nil || expecting?[version.path] == current.contentVersion else { continue }
                current.contentVersion = version.version; current.entry.size = version.size
                current.localModificationDate = nil
                try save(current)
            }
        }
    }
    public func setMaterialized(_ ids: Set<String>) throws {
        try transaction {
            for var item in try all() where item.materialized != ids.contains(item.id) {
                item.materialized = ids.contains(item.id)
                // Bookkeeping does not manufacture a remote content update.
                let json = String(decoding: try JSONEncoder().encode(item), as: UTF8.self)
                try execute("UPDATE items SET value=? WHERE id=?", [json, item.id])
            }
        }
    }
    public func changes(since anchor: Int64, parent: String? = nil) throws -> Changes {
        try transaction {
            let end = try revision()
            let floor = Int64(try rows("SELECT value FROM state WHERE key='retainedRevision'")[0][0]) ?? 0
            guard anchor >= floor, anchor <= end else { throw DriveError.expiredSnapshot }
            let changed = try rows("SELECT value,id,deleted FROM items WHERE revision>?" + (parent == nil ? "" : " AND parent=?") + " ORDER BY revision", [String(anchor)] + (parent.map { [$0] } ?? []))
            let departures = try parent.map { parent in
                try rows("SELECT DISTINCT id FROM departures WHERE parent=? AND revision>? AND id NOT IN (SELECT id FROM items WHERE parent=? AND deleted=0)", [parent, String(anchor), parent]).map { $0[0] }
            } ?? []
            let live = try changed.filter { $0[2] == "0" }.map { try decode($0[0]) }
            // Replicated macOS providers must keep known Trash descendants live.
            // Reporting their IDs as deleted removes local children and can block
            // restoration of the containing directory.
            return Changes(items: live.filter { parent == nil || $0.id != "trash" },
                           deleted: Array(Set(changed.filter { $0[2] == "1" }.map { $0[1] } + departures)), anchor: end)
        }
    }
    /// Extension heartbeat. No revision bump: anchors and change enumeration are unaffected.
    public func recordCallback(error: String? = nil) throws {
        try execute("INSERT INTO state VALUES ('lastCallbackAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [String(Date().timeIntervalSince1970)])
        try execute("INSERT INTO state VALUES ('lastCallbackError',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [error ?? ""])
    }
    public func lastCallback() throws -> (at: Date?, error: String?) {
        let at = try rows("SELECT value FROM state WHERE key='lastCallbackAt'").first?.first.flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
        let error = try rows("SELECT value FROM state WHERE key='lastCallbackError'").first?.first
        return (at, error?.isEmpty == false ? error : nil)
    }
    public func configure(_ capabilities: WriteCapabilities) throws {
        try transaction {
            // App updates can change native filesystem flags without changing any
            // remote version. Republish metadata once so existing placeholders pick
            // up the current policy (notably writable recovery directories).
            let refreshPolicy = try rows("SELECT value FROM state WHERE key='providerPolicy'").first?.first != "2"
            if capabilities.trash || capabilities.restore, (try? item("trash")) == nil {
                var entry = RemoteEntry(path: RemoteEntry.trashPath, name: "Trash", kind: "dir")
                entry.id = "trash"; entry.parentId = "root"; entry.capabilities = .none
                try save(CatalogItem(id: "trash", parentId: "root", entry: entry, contentVersion: "trash",
                                     metadataVersion: "trash", materialized: false))
                try execute("INSERT OR IGNORE INTO folders VALUES (?)", [RemoteEntry.trashPath])
            }
            for var item in try all() where refreshPolicy || item.entry.capabilities != capabilities.forEntry(item.entry) {
                item.entry.capabilities = capabilities.forEntry(item.entry)
                try save(item)
            }
            try execute("INSERT INTO state VALUES ('providerPolicy','2') ON CONFLICT(key) DO UPDATE SET value='2'")
        }
    }
    public func pendingWrites() throws -> [PendingWrite] {
        try rows("SELECT value FROM pending").map { try JSONDecoder().decode(PendingWrite.self, from: Data($0[0].utf8)) }
    }
    public func pendingWrite(key: String) throws -> PendingWrite? {
        try rows("SELECT value FROM pending WHERE key=?", [key]).first.map { try JSONDecoder().decode(PendingWrite.self, from: Data($0[0].utf8)) }
    }
    public func beginWrite(_ pending: PendingWrite) throws -> PendingWrite {
        try transaction {
            if let existing = try pendingWrite(key: pending.key) { return existing }
            let active = try pendingWrites().filter { $0.result == nil }
            guard !active.contains(where: { $0.localId == pending.localId }), active.count < 128 else { throw DriveError.unavailable }
            if let current = try? item(pending.localId) {
                for other in active {
                    if let related = try? item(other.localId),
                       related.entry.path.hasPrefix(current.entry.path + "/") || current.entry.path.hasPrefix(related.entry.path + "/") {
                        throw DriveError.unavailable
                    }
                }
            }
            try execute("INSERT INTO pending VALUES (?,?,?,?,0)", [pending.key, pending.id, pending.localId, String(decoding: try JSONEncoder().encode(pending), as: UTF8.self)])
            // Invalidate snapshots that started before this write was admitted.
            try execute("DELETE FROM listings")
            return pending
        }
    }
    public func writeFailed(_ pending: PendingWrite, error: String) throws {
        var copy = pending; copy.error = error
        try execute("UPDATE pending SET value=? WHERE key=? AND completed=0", [String(decoding: try JSONEncoder().encode(copy), as: UTF8.self), pending.key])
    }
    public static let conflictAttempts = 3
    /// Replace the pending request with a uniquely named create. A replay returns the
    /// current attempt; `retry` starts the next one after that name was taken as well.
    /// Nil means every attempt collided and the error should stand.
    public func conflictCopy(_ pending: PendingWrite, retry: Bool = false) throws -> PendingWrite? {
        try transaction {
            guard let current = try pendingWrite(key: pending.key) else { throw DriveError.writeUncertain }
            if current.supersededOperation != nil && !retry { return current }
            let attempt = (current.conflictAttempts ?? 0) + 1
            guard attempt <= Self.conflictAttempts else { return nil }
            var copy = current
            let request = current.request
            let name = (current.originalName ?? request.name) as NSString
            var suffix = name.pathExtension.isEmpty ? "" : "." + name.pathExtension
            while suffix.utf8.count > 64 { suffix.removeLast() }
            let marker = " (conflict \(current.id.prefix(8))\(attempt > 1 ? "-\(attempt)" : ""))"
            var stem = name.deletingPathExtension
            while stem.utf8.count + marker.utf8.count + suffix.utf8.count > 255 { stem.removeLast() }
            let conflictName = stem + marker + suffix
            copy.originalName = current.originalName ?? request.name
            copy.supersededOperation = current.supersededOperation ?? request.operationId
            copy.conflictAttempts = attempt
            copy.abandonedOperations = (current.abandonedOperations ?? []) + [request.operationId]
            copy.request = WriteRequest(operationId: UUID().uuidString.lowercased(), itemId: nil, parentId: request.parentId,
                                        name: conflictName, base: nil, size: request.size, sha256: request.sha256)
            copy.error = nil
            try execute("UPDATE pending SET value=? WHERE key=? AND completed=0", [String(decoding: try JSONEncoder().encode(copy), as: UTF8.self), copy.key])
            return copy
        }
    }
    public func finishWrite(_ pending: PendingWrite, entry: RemoteEntry) throws -> CatalogItem {
        try transaction {
            if let finished = try pendingWrite(key: pending.key)?.result { return finished }
            guard let remoteId = entry.id, let version = entry.version else { throw DriveError.server("The server omitted the write receipt.") }
            let parent = try itemAt(parentPath(entry.path))
            let previous = try? item(pending.localId)
            // A concurrent enumerator can discover a newly created remote item first.
            if let duplicate = try? itemAt(entry.path), duplicate.id != pending.localId {
                guard duplicate.entry.id == remoteId else { throw DriveError.writeUncertain }
                try execute("UPDATE items SET deleted=1,revision=? WHERE id=?", [String(try next()), duplicate.id])
            }
            var result = CatalogItem(id: pending.localId, parentId: parent.id, entry: entry,
                                     contentVersion: pending.request.sha256 ?? previous?.contentVersion ?? version.content,
                                     metadataVersion: version.metadata, materialized: pending.route == "uploads" || previous?.materialized == true)
            // Preserve the editor's timestamp on our own save. Replacing it with
            // WebDAV's second-resolution timestamp makes TextEdit report its own
            // synchronized save as an edit by another application.
            result.localModificationDate = pending.localModificationDate ?? previous?.localModificationDate
            try save(result)
            if let previous, previous.entry.path != entry.path, previous.entry.kind == "dir" {
                for var child in try all() where child.entry.path.hasPrefix(previous.entry.path + "/") {
                    let oldPath = child.entry.path
                    child.entry.path = entry.path + String(oldPath.dropFirst(previous.entry.path.count))
                    child.entry.trashed = entry.trashed
                    child.entry.capabilities = entry.capabilities?.forEntry(child.entry)
                    try save(child)
                    if try hasListing(oldPath) {
                        try execute("DELETE FROM folders WHERE path=?", [oldPath])
                        try execute("INSERT OR IGNORE INTO folders VALUES (?)", [child.entry.path])
                    }
                }
                if try hasListing(previous.entry.path) {
                    try execute("DELETE FROM folders WHERE path=?", [previous.entry.path])
                    try execute("INSERT OR IGNORE INTO folders VALUES (?)", [entry.path])
                }
            }
            try execute("DELETE FROM listings")
            var finished = pending; finished.result = result; finished.error = nil
            try execute("UPDATE pending SET value=?,completed=1 WHERE key=?", [String(decoding: try JSONEncoder().encode(finished), as: UTF8.self), pending.key])
            return result
        }
    }
}
