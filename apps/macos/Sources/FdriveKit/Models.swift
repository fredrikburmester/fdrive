import Foundation

public enum DriveError: Error, LocalizedError, Sendable, Equatable {
    case invalidServer, authentication, unavailable, missing, expiredSnapshot, changedContent, unsupported, cancelled
    case server(String), database(String)
    case writeConflict(String), writeUncertain, permission, quota, forbidden, diskFull
    case nameCollision(String)
    case unlicensed
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
        case .writeConflict(let message), .nameCollision(let message): message
        case .writeUncertain: "The server could not confirm this save. Your pending copy is preserved in Recovery."
        case .permission: "Write access is unavailable. Your pending copy is preserved in Recovery."
        case .quota: "Storage is full or this file exceeds the upload limit. Your pending copy is preserved."
        case .forbidden: "This connection does not have access to this item."
        case .diskFull: "Not enough free disk space on this Mac for this file."
        case .server(let message), .database(let message): message
        case .unlicensed: "The FDrive trial has ended. Open FDrive to buy or enter a license. Your files and pending changes are kept."
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
public struct Pairing: Codable, Sendable, Equatable {
    public let id: String
    public let secret: String
    public let code: String
    public let expiresAt: String
    public init(id: String, secret: String, code: String, expiresAt: String) {
        self.id = id; self.secret = secret; self.code = code; self.expiresAt = expiresAt
    }
}
public struct PairResult: Codable, Sendable {
    public let status: String
    public let credentials: [Credential]?
}
/// A pairing the app has started but not yet confirmed. Persisted before the first poll so
/// a crash between redemption and Keychain storage can be resumed instead of orphaning the
/// server credential; the server revokes bundles nobody confirms when the window closes.
public struct PendingPairing: Codable, Sendable, Equatable {
    public let server: URL
    public let pairing: Pairing
    public init(server: URL, pairing: Pairing) { self.server = server; self.pairing = pairing }
    public func isExpired(now: Date = Date()) -> Bool {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expires = format.date(from: pairing.expiresAt) ?? ISO8601DateFormatter().date(from: pairing.expiresAt) else { return true }
        return expires <= now
    }
}
/// What the File Provider framework reports about a location's domain.
public struct DomainState: Equatable, Sendable {
    public var userEnabled: Bool
    public var disconnected: Bool
    public init(userEnabled: Bool, disconnected: Bool) { self.userEnabled = userEnabled; self.disconnected = disconnected }
}
public enum LocationHealth: Equatable, Sendable {
    case ready, unregistered, disabled, disconnected
    /// Shown beneath the status; nil when Finder can serve the location.
    public var guidance: String? {
        switch self {
        case .ready: nil
        case .unregistered: "This location is not registered with Finder. Choose Reconnect."
        case .disabled: "Enable FDrive under System Settings › General › Login Items & Extensions › File Providers."
        case .disconnected: "Finder disconnected this location. Choose Reconnect."
        }
    }
    public var needsSystemSettings: Bool { self == .disabled }
    /// Network refresh is pointless without a domain to publish into.
    public var canRefresh: Bool { self != .unregistered }
}
public func locationHealth(_ state: DomainState?) -> LocationHealth {
    guard let state else { return .unregistered }
    if !state.userEnabled { return .disabled }
    if state.disconnected { return .disconnected }
    return .ready
}
/// Finder should answer a signalled enumerator well within one refresh interval. Two
/// intervals without any extension callback means the daemon, not the server, is stuck.
public func enumerationStale(lastCallback: Date?, signalled: Date?, now: Date, interval: TimeInterval = 60) -> Bool {
    guard let signalled, now.timeIntervalSince(signalled) >= 2 * interval else { return false }
    guard let lastCallback else { return true }
    return lastCallback < signalled
}
/// The signal Finder still has to answer. Only a signal carrying revisions newer than the last
/// callback needs one: with nothing new, the daemon may skip enumeration and so record no callback.
/// The earliest unanswered signal is kept, so frequent refreshes cannot keep postponing the verdict.
public func unansweredSignal(previous: Date?, signalled: Date, revision: Int64,
                             lastCallback: Date?, callbackRevision: Int64?) -> Date? {
    guard let lastCallback else { return previous ?? signalled }
    if let previous, lastCallback < previous { return previous }
    // A heartbeat from before revisions were recorded proves nothing either way; wait for the next.
    guard let callbackRevision else { return nil }
    return revision > callbackRevision ? signalled : nil
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

    /// A metadata response can rename this connection or change its write capabilities,
    /// never rebind it to another account, identity or provider.
    public func updatingMetadata(from fresh: Location) throws -> SavedLocation {
        guard (fresh.protocolVersion == 1 && fresh.readOnly) || fresh.protocolVersion == 2 else { throw DriveError.unsupported }
        guard fresh.accountId == location.accountId, fresh.identityId == location.identityId,
              fresh.providerId == location.providerId else {
            throw DriveError.server("The server returned a different storage login. This location was not changed.")
        }
        var updated = self
        updated.location = fresh
        return updated
    }
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
/// How far a publication that runs long enough to be worth watching has got, in
/// bytes. Only a publication that copies object by object reports it.
public struct WriteProgress: Codable, Sendable {
    public let completed: Int64, total: Int64
}
public struct WriteResult: Codable, Sendable {
    public let operationId: String, state: String
    public let item: RemoteEntry?
    public let recoveryId: String?
    public var progress: WriteProgress? = nil
}
public struct PendingWrite: Codable, Sendable, Identifiable {
    public let id: String, key: String, localId: String, route: String
    public var request: WriteRequest
    public var keepBoth: Bool? = nil
    public var localModificationDate: Date? = nil
    public var supersededOperation: String? = nil
    /// The editor's name, retained across renamed conflict-copy attempts.
    public var originalName: String? = nil
    public var conflictAttempts: Int? = nil
    /// Server operations replaced by a conflict copy; cancelled after the durable commit.
    public var abandonedOperations: [String]? = nil
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
/// Refuse a transfer that would fill the volume; the headroom keeps the system usable.
public func requireFreeSpace(_ bytes: Int64, at directory: URL, headroom: Int64 = 512 * 1024 * 1024) throws {
    let attributes = try FileManager.default.attributesOfFileSystem(forPath: directory.path)
    guard let available = (attributes[.systemFreeSize] as? NSNumber)?.int64Value,
          available - headroom >= bytes else { throw DriveError.diskFull }
}
public func parentPath(_ path: String) -> String {
    let parts = path.split(separator: "/").dropLast()
    return "/" + parts.joined(separator: "/")
}
