import Foundation
import Security

public struct ConnectionStore: Sendable {
    public let directory: URL
    public let keychainGroup: String?
    public init(directory: URL, keychainGroup: String? = nil) throws {
        self.directory = directory; self.keychainGroup = keychainGroup
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
    public func catalog(_ location: SavedLocation) throws -> Catalog {
        try Catalog(url: directory.appendingPathComponent(location.id + ".sqlite"), title: location.title)
    }
    private func query(_ id: String) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrService as String: "fdrive.desktop", kSecAttrAccount as String: id]
        if let keychainGroup { query[kSecAttrAccessGroup as String] = keychainGroup }
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
    public func client(_ location: SavedLocation) throws -> APIClient {
        guard !location.disconnecting else { throw DriveError.authentication }
        return try APIClient(server: location.server, token: token(location.id), protocolVersion: location.location.protocolVersion)
    }
    public func removeMetadata(_ id: String) throws {
        for suffix in [".sqlite", ".sqlite-wal", ".sqlite-shm"] {
            let file = directory.appendingPathComponent(id + suffix)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
    }
}
