import Foundation

public enum DriveError: Error, LocalizedError, Sendable, Equatable {
    case invalidServer, authentication, unavailable, missing, expiredSnapshot, changedContent, unsupported, cancelled
    case server(String), database(String)
    case writeConflict(String), writeUncertain, permission, quota
    public var errorDescription: String? {
        switch self {
        case .invalidServer: "Enter an HTTPS fdrive address. HTTP is supported only on loopback for development."
        case .authentication: "Sign in again to reconnect this location."
        case .unavailable: "The server is unavailable. Downloaded files may still be available offline."
        case .missing: "This item no longer exists."
        case .expiredSnapshot: "The folder changed or its listing expired. Refresh to try again."
        case .changedContent: "The file changed during download. Open it again to get the current version."
        case .unsupported: "This location supports reading regular files and folders only."
        case .cancelled: "The operation was cancelled."
        case .writeConflict(let message): message
        case .writeUncertain: "The server could not confirm this save. Your pending copy is preserved in Recovery."
        case .permission: "Write access is unavailable. Your pending copy is preserved in Recovery."
        case .quota: "Storage is full or this file exceeds the upload limit. Your pending copy is preserved."
        case .server(let message), .database(let message): message
        }
    }
}

public struct RemoteEntry: Codable, Sendable, Equatable {
    public static let trashPath = "/.fdrive-desktop/trash"
    public var path: String
    public var name: String
    public var kind: String
    public var size: Int64
    public var modifiedAt: String
    public var readable: Bool
    public var id: String?
    public var parentId: String?
    public var version: WriteVersion?
    public var capabilities: WriteCapabilities?
    public var trashed: Bool?
    public init(path: String, name: String, kind: String, size: Int64 = 0,
                modifiedAt: String = "1970-01-01T00:00:00.000Z", readable: Bool = true) {
        self.path = path; self.name = name; self.kind = kind; self.size = size
        self.modifiedAt = modifiedAt; self.readable = readable
    }
    public var date: Date {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: modifiedAt) ?? ISO8601DateFormatter().date(from: modifiedAt) ?? .distantPast
    }
    /// Recovery handles are path components; their display names retain the file type.
    public var hasValidListingName: Bool {
        guard !name.isEmpty, name.utf8.count <= 255, ![".", ".."].contains(name),
              !name.contains("/"), !name.contains(":"),
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return false }
        let leaf = path.split(separator: "/").last.map(String.init)
        if parentPath(path) == Self.trashPath {
            return trashed == true && parentId == "trash" && id == leaf && id.flatMap(UUID.init(uuidString:)) != nil
        }
        return leaf == name
    }
}
public struct Location: Codable, Sendable, Equatable {
    public let protocolVersion: Int
    public let accountId: String
    public let identityId: String
    public let providerId: String
    public let displayName: String
    public let username: String
    public let paths: [String]
    public let readOnly: Bool
    public var capabilities: WriteCapabilities? = nil
    public var maxUploadBytes: Int64? = nil
    public var writeUnavailableReason: String? = nil
}
public struct Credential: Codable, Sendable {
    public let token: String
    public let tokenId: String
    public let expiresAt: String
    public let location: Location
}
public struct Pairing: Codable, Sendable {
    public let id: String
    public let secret: String
    public let code: String
    public let expiresAt: String
}
public struct PairResult: Codable, Sendable {
    public let status: String
    public let credentials: [Credential]?
}
public struct Listing: Codable, Sendable { public let entries: [RemoteEntry]; public let nextCursor: String? }
public struct ContentVersion: Codable, Sendable { public let path: String; public let version: String; public let size: Int64 }
public struct Versions: Codable, Sendable { public let items: [ContentVersion] }

public struct SavedLocation: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let server: URL
    public var location: Location
    public let expiresAt: String?
    public var disconnecting: Bool
    public init(id: String = UUID().uuidString, server: URL, location: Location, expiresAt: String? = nil, disconnecting: Bool = false) {
        self.id = id; self.server = server; self.location = location; self.expiresAt = expiresAt; self.disconnecting = disconnecting
    }
    public var title: String { "\(location.displayName) (\(location.username))" }
}
public struct CatalogItem: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public var parentId: String
    public var entry: RemoteEntry
    public var contentVersion: String
    public var metadataVersion: String
    public var materialized: Bool
    public var localModificationDate: Date? = nil
}
public struct WriteCapabilities: Codable, Sendable, Equatable {
    public var create: Bool, update: Bool, move: Bool, trash: Bool, restore: Bool
    public static let none = Self(create: false, update: false, move: false, trash: false, restore: false)
    public func forEntry(_ entry: RemoteEntry) -> Self {
        guard entry.readable else { return .none }
        if entry.path == RemoteEntry.trashPath {
            return Self(create: false, update: false, move: false, trash: trash, restore: false)
        }
        if entry.trashed == true {
            return Self(create: false, update: false, move: restore, trash: false, restore: restore)
        }
        return self
    }
}
public struct WriteVersion: Codable, Sendable, Equatable {
    public let content: String, metadata: String
    public init(content: String, metadata: String) { self.content = content; self.metadata = metadata }
}
public struct WriteRequest: Codable, Sendable {
    public let operationId: String
    public let itemId: String?
    public let parentId: String
    public let name: String
    public let base: WriteVersion?
    public let size: Int64?
    public let sha256: String?
    public init(operationId: String, itemId: String?, parentId: String, name: String, base: WriteVersion?, size: Int64? = nil, sha256: String? = nil) {
        self.operationId = operationId; self.itemId = itemId; self.parentId = parentId; self.name = name
        self.base = base; self.size = size; self.sha256 = sha256
    }
    // The upload contract requires an explicit null base on creation; the
    // folder contract has neither itemId nor base. Encode per operation below.
    public func body(route: String) throws -> Data {
        var object: [String: Any] = ["operationId": operationId, "parentId": parentId, "name": name]
        if let itemId { object["itemId"] = itemId }
        if let base { object["base"] = ["content": base.content, "metadata": base.metadata] }
        else if route == "uploads" { object["base"] = NSNull() }
        if let size { object["size"] = size }
        if let sha256 { object["sha256"] = sha256 }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}
public struct WriteResult: Codable, Sendable {
    public let operationId: String, state: String
    public let item: RemoteEntry?
    public let recoveryId: String?
}
public struct PendingWrite: Codable, Sendable, Identifiable {
    public let id: String, key: String, localId: String, route: String
    public var request: WriteRequest
    public var keepBoth: Bool? = nil
    public var localModificationDate: Date? = nil
    public var supersededOperation: String? = nil
    public var result: CatalogItem?
    public var error: String?
}
public struct Changes: Sendable { public let items: [CatalogItem]; public let deleted: [String]; public let anchor: Int64 }

public func canonicalPath(_ raw: String) throws -> String {
    guard raw.hasPrefix("/"), raw.utf8.count <= 4096,
          !raw.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw DriveError.unsupported }
    let parts = raw.split(separator: "/", omittingEmptySubsequences: true)
    guard !parts.contains(".."), !parts.contains(".") else { throw DriveError.unsupported }
    return "/" + parts.joined(separator: "/")
}
public func parentPath(_ path: String) -> String {
    let parts = path.split(separator: "/").dropLast()
    return "/" + parts.joined(separator: "/")
}
