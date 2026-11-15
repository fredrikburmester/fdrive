import Foundation
import Security

/// Where each location's bearer secret is kept: the shared Keychain, or memory in tests.
public protocol TokenVault: Sendable {
    func token(_ id: String) throws -> String
    func setToken(_ token: String, id: String) throws
    /// Succeeds when there is no token for `id`.
    func removeToken(_ id: String) throws
}

public struct ConnectionStore: Sendable {
    public let directory: URL
    public let keychainGroup: String?
    public let vault: any TokenVault
    public init(directory: URL, keychainGroup: String? = nil, vault: (any TokenVault)? = nil) throws {
        self.directory = directory; self.keychainGroup = keychainGroup
        self.vault = vault ?? KeychainVault(group: keychainGroup)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    private struct Configuration: Codable { let version: Int; let locations: [SavedLocation] }
    public func load() throws -> [SavedLocation] {
        let path = directory.appendingPathComponent("locations.json")
        guard FileManager.default.fileExists(atPath: path.path) else { return [] }
        let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: path))
        guard config.version == 1 else { throw DriveError.server("Update fdrive for Mac to read these connections.") }
        guard Set(config.locations.map(\.id)).count == config.locations.count, config.locations.allSatisfy({ UUID(uuidString: $0.id) != nil }) else { throw DriveError.database("Invalid saved connections.") }
        return config.locations
    }
    /// The companion is the only writer of connection configuration; extension reads atomically.
    public func save(_ locations: [SavedLocation]) throws {
        try JSONEncoder().encode(Configuration(version: 1, locations: locations)).write(to: directory.appendingPathComponent("locations.json"), options: .atomic)
    }
    /// Reads, changes and saves the configuration as it is on disk now, rather than writing
    /// back a list read earlier over a change made since.
    @discardableResult
    public func update(_ change: (inout [SavedLocation]) throws -> Void) throws -> [SavedLocation] {
        var locations = try load()
        try change(&locations)
        try save(locations)
        return locations
    }
    /// Locations that have a catalog on disk, by ID.
    public func catalogIds() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).compactMap { name in
            guard name.hasSuffix(".sqlite") else { return nil }
            let id = String(name.dropLast(".sqlite".count))
            return UUID(uuidString: id) == nil ? nil : id
        }.sorted()
    }
    /// Journaled writes not yet acknowledged by the server, for a location's catalog; zero
    /// when there is none. Never creates a catalog. A catalog this build cannot open throws,
    /// so nothing is removed on the strength of a count it could not read.
    public func unfinishedWrites(_ id: String) async throws -> Int {
        let file = directory.appendingPathComponent(id + ".sqlite")
        guard FileManager.default.fileExists(atPath: file.path) else { return 0 }
        let catalog = try Catalog(url: file, title: "")
        return try await catalog.pendingWrites().filter { $0.result == nil }.count
    }
    private var pendingPairingURL: URL { directory.appendingPathComponent("pending-pairing.json") }
    public func pendingPairing() throws -> PendingPairing? {
        guard FileManager.default.fileExists(atPath: pendingPairingURL.path) else { return nil }
        return try JSONDecoder().decode(PendingPairing.self, from: Data(contentsOf: pendingPairingURL))
    }
    /// The secret only redeems, confirms or cancels this one pairing for at most five minutes.
    public func savePendingPairing(_ pending: PendingPairing) throws {
        try JSONEncoder().encode(pending).write(to: pendingPairingURL, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pendingPairingURL.path)
    }
    public func clearPendingPairing() throws {
        if FileManager.default.fileExists(atPath: pendingPairingURL.path) { try FileManager.default.removeItem(at: pendingPairingURL) }
    }
    public func catalog(_ location: SavedLocation) throws -> Catalog {
        try Catalog(url: directory.appendingPathComponent(location.id + ".sqlite"), title: location.title)
    }
    public func token(_ id: String) throws -> String { try vault.token(id) }
    public func setToken(_ token: String, id: String) throws { try vault.setToken(token, id: id) }
    public func removeToken(_ id: String) throws { try vault.removeToken(id) }
    public func client(_ location: SavedLocation) throws -> APIClient {
        guard !location.disconnecting else { throw DriveError.authentication }
        return try APIClient(server: location.server, token: token(location.id), protocolVersion: location.location.protocolVersion)
    }
    public func writer(_ location: SavedLocation) throws -> WriteCoordinator {
        WriteCoordinator(catalog: try catalog(location), client: try client(location),
                         maxUploadBytes: location.location.maxUploadBytes)
    }
    public func removeMetadata(_ id: String) throws {
        for suffix in [".sqlite", ".sqlite-wal", ".sqlite-shm"] {
            let file = directory.appendingPathComponent(id + suffix)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
    }
}

/// Credentials in the shared Data Protection Keychain, readable by the app and its extension.
public struct KeychainVault: TokenVault {
    public let group: String?
    public init(group: String?) { self.group = group }
    private func query(_ id: String) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrService as String: "fdrive.desktop", kSecAttrAccount as String: id]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }
    public func token(_ id: String) throws -> String {
        var query = query(id); query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let token = String(data: data, encoding: .utf8) else { throw DriveError.authentication }
        return token
    }
    public func setToken(_ token: String, id: String) throws {
        let query = query(id)
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var entry = query.merging(attributes) { _, value in value }
            entry[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(entry as CFDictionary, nil) == errSecSuccess else { throw DriveError.authentication }
        } else if status != errSecSuccess { throw DriveError.authentication }
    }
    public func removeToken(_ id: String) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw DriveError.authentication }
    }
}
