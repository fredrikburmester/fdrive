import Foundation

/// One File Provider domain this app registered.
public struct RegisteredDomain: Sendable, Equatable {
    public let id: String
    public init(id: String) { self.id = id }
}

/// The part of `NSFileProviderManager` that removal and reconciliation use, so both run in
/// tests without File Provider.
public protocol DomainRegistry: Sendable {
    func domains() async throws -> [RegisteredDomain]
    /// Removes a domain while keeping files changed on this Mac that were not uploaded yet,
    /// and returns where macOS put them, if it kept any. Throws, removing nothing, when it
    /// cannot keep them. Removing a domain that is not registered does nothing.
    func remove(id: String) async throws -> URL?
}

/// A location's catalog still holds writes the server has not acknowledged, so it is not
/// removed: removing it would leave those edits without anything that knows where they go.
public struct UnfinishedWrites: Error, LocalizedError, Equatable, Sendable {
    public let count: Int
    public init(count: Int) { self.count = count }
    public var errorDescription: String? {
        "This location has \(count == 1 ? "a change" : "\(count) changes") not uploaded yet. "
            + "Let \(count == 1 ? "it" : "them") finish, or copy what you need from Show recovery files, before removing it."
    }
}

/// A location, or a domain nothing referred to, that is now gone from this Mac.
public struct RemovedLocation: Sendable, Equatable {
    public let id: String
    /// Where macOS kept files that were changed here and not uploaded, if there were any.
    public let preserved: URL?
    /// The server did not confirm revoking the credential, so it stays valid until it expires.
    public let credentialRemains: Bool
    public init(id: String, preserved: URL?, credentialRemains: Bool) {
        self.id = id; self.preserved = preserved; self.credentialRemains = credentialRemains
    }
}

/// What one reconciliation pass did. Every failure is retried by the next pass.
public struct Reconciliation: Sendable, Equatable {
    public var removed: [RemovedLocation] = []
    /// Locations and domains kept because they still hold writes not yet uploaded.
    public var kept: [String: Int] = [:]
    public var failed: [String: NSError] = [:]
    public init() {}
}

/// Removes locations so that no domain is ever left running on a revoked credential, and
/// nothing the person changed here is lost.
///
/// The order is fixed and every step can run again: mark the location as being removed (from
/// then on neither the app nor the extension uses its credential), remove the domain keeping
/// dirty user data, revoke the credential when the server can be reached, then delete the
/// Keychain item, the catalog and the saved location. A failure stops at that step, and the
/// next reconciliation picks it up from the mark.
public struct LocationRemover: Sendable {
    public let store: ConnectionStore
    public let domains: any DomainRegistry
    /// Best effort and bounded: true when the server confirmed it no longer accepts the credential.
    public let revoke: @Sendable (SavedLocation) async -> Bool
    public init(store: ConnectionStore, domains: any DomainRegistry, revoke: @escaping @Sendable (SavedLocation) async -> Bool) {
        self.store = store; self.domains = domains; self.revoke = revoke
    }

    /// Removes one saved location. Refuses with `UnfinishedWrites`, changing nothing, while its
    /// catalog holds writes the server has not acknowledged. A credential the server already
    /// said is gone is not sent to it again.
    @discardableResult
    public func remove(_ location: SavedLocation) async throws -> RemovedLocation {
        let unfinished = try await store.unfinishedWrites(location.id)
        guard unfinished == 0 else { throw UnfinishedWrites(count: unfinished) }
        try store.update { saved in
            if let index = saved.firstIndex(where: { $0.id == location.id }) { saved[index].disconnecting = true }
        }
        let preserved = try await domains.remove(id: location.id)
        let revoked = location.goneSince != nil ? true : await revoke(location)
        try store.removeToken(location.id)
        try store.removeKeys(location.id)
        try store.removeMetadata(location.id)
        try store.update { $0.removeAll { $0.id == location.id } }
        return RemovedLocation(id: location.id, preserved: preserved, credentialRemains: !revoked)
    }

    /// Brings the registered domains and the saved locations back in line: finishes every
    /// removal under way, removes each domain no saved location refers to, and deletes catalogs
    /// that belong to neither. Nothing holding unacknowledged writes is removed. `skipping`
    /// names locations another task is working on. Throws, changing nothing, when the domains
    /// or the configuration cannot be read: an unreadable configuration is never taken to mean
    /// that no locations exist.
    public func reconcile(skipping: Set<String> = []) async throws -> Reconciliation {
        let registered = try await domains.domains()
        let saved = try store.load()
        var report = Reconciliation()
        for location in saved where location.disconnecting && !skipping.contains(location.id) {
            do { report.removed.append(try await remove(location)) }
            catch let refused as UnfinishedWrites { report.kept[location.id] = refused.count }
            catch { report.failed[location.id] = error as NSError }
        }
        let known = Set(saved.map(\.id))
        for domain in registered where !known.contains(domain.id) && !skipping.contains(domain.id) {
            // No saved location means no server to revoke at and nothing that can use the
            // domain: the extension refuses every request for it.
            do {
                let unfinished = try await store.unfinishedWrites(domain.id)
                guard unfinished == 0 else { report.kept[domain.id] = unfinished; continue }
                let preserved = try await domains.remove(id: domain.id)
                try store.removeToken(domain.id)
                try store.removeKeys(domain.id)
                try store.removeMetadata(domain.id)
                report.removed.append(RemovedLocation(id: domain.id, preserved: preserved, credentialRemains: false))
            } catch { report.failed[domain.id] = error as NSError }
        }
        let registeredIds = Set(registered.map(\.id))
        for id in try store.catalogIds()
        where !known.contains(id) && !registeredIds.contains(id) && !skipping.contains(id) {
            // A catalog left by an earlier build or a removal cut short. Its recovery folder stays.
            guard (try? await store.unfinishedWrites(id)) == 0 else { continue }
            try? store.removeMetadata(id)
        }
        return report
    }
}

/// How long FDrive waits after the server first says a credential is gone before it removes
/// the location, asking once more when the hour is up. A restore that is rolled back, or a
/// server briefly started on another database, answers like a revoked credential; an hour
/// lets either be put right before anything changes on this Mac.
public let goneConfirmation: TimeInterval = 3_600

/// What a refresh learned about a location's credential.
public enum CredentialVerdict: Sendable, Equatable {
    /// The server accepted it.
    case valid
    /// The request failed for another reason (offline, a 5xx, a 404, a denied path): nothing
    /// about the credential changes.
    case unknown
    /// A plain 401: expired, or refused by a server that cannot say why. Stop asking and let
    /// the person reconnect or remove it. Never removed automatically.
    case signedOut
    /// The server says it no longer holds the credential; ask again once `goneConfirmation`
    /// has passed since `since`.
    case gone(since: Date)
    /// Still gone `goneConfirmation` after the server first said so: remove the location.
    case remove
}

/// Judges the outcome of asking the server, given when it first said the credential is gone.
/// A first answer from a clock that has since gone backwards starts the wait again.
public func credentialVerdict(_ error: (any Error)?, goneSince: Date?, now: Date) -> CredentialVerdict {
    guard let error else { return .valid }
    switch error as? DriveError {
    case .credentialGone:
        guard let goneSince, goneSince <= now else { return .gone(since: now) }
        return now.timeIntervalSince(goneSince) >= goneConfirmation ? .remove : .gone(since: goneSince)
    case .authentication: return .signedOut
    default: return .unknown
    }
}

/// Whether a refresh should ask the server about a location the server said is gone: only once
/// the wait is over, so a location waiting to be removed sends nothing in the meantime.
public func credentialCheckDue(goneSince: Date?, now: Date) -> Bool {
    guard let goneSince, goneSince <= now else { return true }
    return now.timeIntervalSince(goneSince) >= goneConfirmation
}
