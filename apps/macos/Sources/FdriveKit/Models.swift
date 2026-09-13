import Foundation

public enum DriveError: Error, LocalizedError, Sendable, Equatable {
    case invalidServer, authentication, unavailable, missing, expiredSnapshot, changedContent, unsupported, cancelled
    case server(String), database(String)
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
        case .server(let message), .database(let message): message
        }
    }
}

public struct RemoteEntry: Codable, Sendable, Equatable {
    public var path: String
    public var name: String
    public var kind: String
    public var size: Int64
    public var modifiedAt: String
    public var readable: Bool
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
    public let parentId: String
    public var entry: RemoteEntry
    public var contentVersion: String
    public var metadataVersion: String
    public var materialized: Bool
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
