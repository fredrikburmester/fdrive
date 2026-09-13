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
    private let connection: DatabaseConnection
    private let retainedRevisions: Int64
    private var database: OpaquePointer { connection.pointer }
    public init(url: URL, title: String, retainedRevisions: Int64 = 100_000) throws {
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
        let supported = sqlite3_step(version) == SQLITE_ROW && sqlite3_column_int(version, 0) <= 2
        sqlite3_finalize(version)
        guard supported else {
            throw DriveError.database("This metadata store requires a newer version of fdrive.")
        }
        let schema = """
        PRAGMA journal_mode=WAL;
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
        PRAGMA user_version=2;
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
        try rows("SELECT value FROM items WHERE parent=? AND id!='root' AND deleted=0 ORDER BY path", [parent]).map { try decode($0[0]) }
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
            for entry in entries {
                guard try canonicalPath(entry.path) == entry.path, parentPath(entry.path) == folder,
                      paths.insert(entry.path).inserted else { throw DriveError.server("Invalid folder snapshot.") }
                // Refuse an ambiguous listing on the default case-insensitive macOS volume.
                guard names.insert(entry.name.precomposedStringWithCanonicalMapping.lowercased()).inserted,
                      !entry.name.contains(":"), entry.name != ".", entry.name != ".." else {
                    throw DriveError.server("This folder contains names that conflict on macOS. Rename them in fdrive and refresh.")
                }
            }
            let existing = try children(parent.id)
            let kinds = Dictionary(uniqueKeysWithValues: entries.map { ($0.path, $0.kind) })
            let removed = existing.filter { kinds[$0.entry.path] != $0.entry.kind }
            let knownItems = removed.isEmpty ? [] : try all()
            for removedItem in removed {
                for descendant in knownItems where descendant.entry.path == removedItem.entry.path || descendant.entry.path.hasPrefix(removedItem.entry.path + "/") {
                    try execute("UPDATE items SET deleted=1,revision=? WHERE id=?", [String(try next()), descendant.id])
                    try execute("DELETE FROM folders WHERE path=?", [descendant.entry.path])
                    try execute("DELETE FROM listings WHERE path=?", [descendant.entry.path])
                }
            }
            for entry in entries {
                let found: CatalogItem?
                do { found = try itemAt(entry.path) } catch DriveError.missing { found = nil }
                if var current = found {
                    if current.entry != entry {
                        if current.entry.size != entry.size || current.entry.modifiedAt != entry.modifiedAt {
                            current.contentVersion = UUID().uuidString
                        }
                        current.entry = entry; current.metadataVersion = UUID().uuidString
                        try save(current)
                    }
                } else {
                    try save(CatalogItem(id: UUID().uuidString, parentId: parent.id, entry: entry,
                                         contentVersion: UUID().uuidString, metadataVersion: UUID().uuidString, materialized: false))
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
            for version in versions {
                let found: CatalogItem?
                do { found = try itemAt(version.path) } catch DriveError.missing { found = nil }
                guard var current = found, current.materialized,
                      current.contentVersion != version.version,
                      expecting == nil || expecting?[version.path] == current.contentVersion else { continue }
                current.contentVersion = version.version; current.entry.size = version.size
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
            return Changes(items: try changed.filter { $0[2] == "0" }.map { try decode($0[0]) },
                           deleted: changed.filter { $0[2] == "1" }.map { $0[1] }, anchor: end)
        }
    }
}
