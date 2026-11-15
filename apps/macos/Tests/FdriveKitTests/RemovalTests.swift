import Foundation
import Testing
@testable import FdriveKit

/// Domains as File Provider would hold them, with removal failures on request.
private final class Domains: DomainRegistry, @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [String]
    private var failing: [String: any Error] = [:]
    private var preserving: [String: URL] = [:]
    private var calls: [String] = []
    init(_ ids: [String]) { self.ids = ids }
    var registered: [String] { lock.withLock { ids } }
    /// Every remove call, in order, including failed ones.
    var removals: [String] { lock.withLock { calls } }
    func fail(_ id: String, with error: (any Error)?) { lock.withLock { failing[id] = error } }
    func preserve(_ id: String, at url: URL) { lock.withLock { preserving[id] = url } }
    func domains() async throws -> [RegisteredDomain] { lock.withLock { ids.map(RegisteredDomain.init) } }
    func remove(id: String) async throws -> URL? {
        try lock.withLock {
            calls.append(id)
            if let error = failing[id] { throw error }
            guard ids.contains(id) else { return nil }
            ids.removeAll { $0 == id }
            return preserving[id]
        }
    }
}

private final class MemoryVault: TokenVault, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]
    func token(_ id: String) throws -> String {
        try lock.withLock { guard let token = tokens[id] else { throw DriveError.authentication }; return token }
    }
    func setToken(_ token: String, id: String) throws { lock.withLock { tokens[id] = token } }
    func removeToken(_ id: String) throws { _ = lock.withLock { tokens.removeValue(forKey: id) } }
    func has(_ id: String) -> Bool { lock.withLock { tokens[id] != nil } }
}

/// What each revocation saw of the rest of the state when it ran.
private final class Revocations: @unchecked Sendable {
    struct Seen: Equatable { let id: String; let domainRegistered: Bool; let tokenKept: Bool; let marked: Bool }
    private let lock = NSLock()
    private var seen: [Seen] = []
    var all: [Seen] { lock.withLock { seen } }
    func record(_ value: Seen) { lock.withLock { seen.append(value) } }
}

private struct Fixture {
    let directory: URL
    let store: ConnectionStore
    let vault: MemoryVault
    let domains: Domains
    let revocations = Revocations()
    let a: SavedLocation
    let b: SavedLocation
    /// What the server answers to a revocation.
    var revokes = true
    var remover: LocationRemover {
        let (store, vault, domains, revocations, revokes) = (store, vault, domains, revocations, revokes)
        return LocationRemover(store: store, domains: domains) { location in
            let marked = (try? store.load().first { $0.id == location.id }?.disconnecting) ?? false
            revocations.record(.init(id: location.id, domainRegistered: domains.registered.contains(location.id),
                                     tokenKept: vault.has(location.id), marked: marked == true))
            return revokes
        }
    }
    func catalogExists(_ id: String) -> Bool {
        FileManager.default.fileExists(atPath: directory.appendingPathComponent(id + ".sqlite").path)
    }
}

private func location(_ name: String, goneSince: Date? = nil, disconnecting: Bool = false) -> SavedLocation {
    SavedLocation(server: URL(string: "https://drive.example")!,
                  location: Location(protocolVersion: 2, accountId: "account", identityId: name, providerId: "provider",
                                     displayName: name, username: "alice", paths: ["/"], readOnly: false,
                                     capabilities: WriteCapabilities(create: true, update: true, move: true, trash: true, restore: true)),
                  disconnecting: disconnecting, goneSince: goneSince)
}

private func fixture(a: SavedLocation = location("A"), b: SavedLocation = location("B"), registered: [String]? = nil) async throws -> Fixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let vault = MemoryVault()
    let store = try ConnectionStore(directory: directory, vault: vault)
    try store.save([a, b])
    for saved in [a, b] {
        try vault.setToken("fdd_\(saved.location.displayName)", id: saved.id)
        _ = try await store.catalog(saved).revision()
    }
    return Fixture(directory: directory, store: store, vault: vault, domains: Domains(registered ?? [a.id, b.id]), a: a, b: b)
}

/// Leaves one write the server has not acknowledged in a location's catalog.
private func pendingWrite(_ store: ConnectionStore, _ saved: SavedLocation) async throws {
    let catalog = try store.catalog(saved)
    _ = try await catalog.beginWrite(PendingWrite(
        id: UUID().uuidString, key: UUID().uuidString, localId: UUID().uuidString, route: "uploads",
        request: WriteRequest(operationId: UUID().uuidString, itemId: nil, parentId: "root", name: "draft.txt", base: nil)))
}

@Suite struct RemovalTests {
    @Test func removalTakesTheDomainFirstThenRevokesThenForgetsTheLocation() async throws {
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.directory) }
        let preserved = f.directory.appendingPathComponent("Preserved")
        f.domains.preserve(f.a.id, at: preserved)
        let removed = try await f.remover.remove(f.a)
        #expect(removed == RemovedLocation(id: f.a.id, preserved: preserved, credentialRemains: false))
        // The server heard about it only once the domain was gone, while the token still existed.
        #expect(f.revocations.all == [.init(id: f.a.id, domainRegistered: false, tokenKept: true, marked: true)])
        #expect(try f.store.load() == [f.b])
        #expect(!f.vault.has(f.a.id) && !f.catalogExists(f.a.id))
        // The other location is untouched.
        #expect(f.domains.registered == [f.b.id] && f.vault.has(f.b.id) && f.catalogExists(f.b.id))
    }

    @Test func aServerThatDoesNotRevokeStillLetsTheLocationGoAndSaysSo() async throws {
        var f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.directory) }
        f.revokes = false
        let removed = try await f.remover.remove(f.a)
        #expect(removed.credentialRemains)
        #expect(try f.store.load() == [f.b] && !f.vault.has(f.a.id))
    }

    // An older build's extension still running answers -2004. The location must stay marked,
    // so nothing uses its credential, and the credential must not be revoked under a live domain.
    @Test func aDomainThatCannotBeRemovedKeepsItsCredentialUnusedAndUnrevokedUntilARetrySucceeds() async throws {
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.directory) }
        f.domains.fail(f.a.id, with: NSError(domain: "NSFileProviderErrorDomain", code: -2004))
        await #expect(throws: NSError.self) { try await f.remover.remove(f.a) }
        #expect(f.revocations.all.isEmpty)
        let marked = try #require(try f.store.load().first { $0.id == f.a.id })
        #expect(marked.disconnecting && f.vault.has(f.a.id) && f.catalogExists(f.a.id))
        #expect(throws: DriveError.authentication) { _ = try f.store.client(marked) }
        // A reconciliation retries it and fails the same way, still without revoking.
        let failing = try await f.remover.reconcile()
        #expect(failing.removed.isEmpty && failing.failed.keys.sorted() == [f.a.id] && f.revocations.all.isEmpty)
        // Once the framework lets go, the next pass finishes in order.
        f.domains.fail(f.a.id, with: nil)
        let report = try await f.remover.reconcile()
        #expect(report.removed.map(\.id) == [f.a.id] && report.failed.isEmpty)
        #expect(f.revocations.all == [.init(id: f.a.id, domainRegistered: false, tokenKept: true, marked: true)])
        #expect(try f.store.load() == [f.b] && !f.vault.has(f.a.id) && !f.catalogExists(f.a.id))
    }

    @Test func unacknowledgedWritesKeepTheLocationAndChangeNothing() async throws {
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.directory) }
        try await pendingWrite(f.store, f.a)
        await #expect(throws: UnfinishedWrites(count: 1)) { try await f.remover.remove(f.a) }
        #expect(try f.store.load() == [f.a, f.b] && f.domains.removals.isEmpty && f.revocations.all.isEmpty)
        // Marked by an earlier build before it checked: kept, not removed.
        try f.store.update { $0[0].disconnecting = true }
        let report = try await f.remover.reconcile()
        #expect(report.kept == [f.a.id: 1] && report.removed.isEmpty && f.domains.removals.isEmpty)
        #expect(f.vault.has(f.a.id) && f.catalogExists(f.a.id))
    }

    @Test func aCredentialTheServerSaidIsGoneIsNotSentAgain() async throws {
        let gone = location("A", goneSince: Date(timeIntervalSince1970: 1_000))
        var f = try await fixture(a: gone)
        defer { try? FileManager.default.removeItem(at: f.directory) }
        f.revokes = false
        let removed = try await f.remover.remove(gone)
        #expect(f.revocations.all.isEmpty && !removed.credentialRemains)
        #expect(try f.store.load() == [f.b] && f.domains.registered == [f.b.id])
    }

    @Test func reconciliationRemovesDomainsNoLocationRefersTo() async throws {
        let orphan = location("Orphan")
        let f = try await fixture(registered: nil)
        defer { try? FileManager.default.removeItem(at: f.directory) }
        // A location removed from the configuration, its domain, token and catalog left behind.
        let domains = Domains([f.a.id, orphan.id, f.b.id])
        try f.vault.setToken("fdd_orphan", id: orphan.id)
        _ = try await f.store.catalog(orphan).revision()
        let preserved = f.directory.appendingPathComponent("Orphan preserved")
        domains.preserve(orphan.id, at: preserved)
        let remover = LocationRemover(store: f.store, domains: domains) { _ in Issue.record("nothing to revoke"); return false }
        let report = try await remover.reconcile()
        #expect(report.removed == [RemovedLocation(id: orphan.id, preserved: preserved, credentialRemains: false)])
        #expect(domains.registered == [f.a.id, f.b.id])
        #expect(!f.vault.has(orphan.id) && !f.catalogExists(orphan.id))
        #expect(try f.store.load() == [f.a, f.b] && f.vault.has(f.a.id) && f.catalogExists(f.a.id))
        // Nothing left to do: a second pass changes nothing.
        let again = try await remover.reconcile()
        #expect(again == Reconciliation() && domains.removals == [orphan.id])
    }

    @Test func anOrphanDomainWithUnacknowledgedWritesIsKept() async throws {
        let orphan = location("Orphan")
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.directory) }
        try await pendingWrite(f.store, orphan)
        let domains = Domains([f.a.id, f.b.id, orphan.id])
        let report = try await LocationRemover(store: f.store, domains: domains) { _ in false }.reconcile()
        #expect(report.kept == [orphan.id: 1] && report.removed.isEmpty && domains.removals.isEmpty)
        #expect(f.catalogExists(orphan.id))
    }

    @Test func reconciliationNeverTakesAnUnreadableConfigurationForNoLocations() async throws {
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.directory) }
        try Data("not json".utf8).write(to: f.directory.appendingPathComponent("locations.json"))
        await #expect(throws: (any Error).self) { try await f.remover.reconcile() }
        #expect(f.domains.removals.isEmpty && f.vault.has(f.a.id) && f.catalogExists(f.a.id))
    }

    @Test func reconciliationDeletesCatalogsNothingRefersToButKeepsTheirRecoveryFiles() async throws {
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.directory) }
        let leftover = location("Leftover"), unsent = location("Unsent")
        let catalog = try f.store.catalog(leftover)
        _ = try await catalog.revision()
        try FileManager.default.createDirectory(at: catalog.recoveryDirectory, withIntermediateDirectories: true)
        try await pendingWrite(f.store, unsent)
        let report = try await f.remover.reconcile()
        #expect(report == Reconciliation())
        #expect(!f.catalogExists(leftover.id) && FileManager.default.fileExists(atPath: catalog.recoveryDirectory.path))
        #expect(f.catalogExists(unsent.id) && f.catalogExists(f.a.id) && f.catalogExists(f.b.id))
    }

    @Test func reconciliationLeavesAloneWhatAnotherTaskIsRemoving() async throws {
        let f = try await fixture(a: location("A", disconnecting: true))
        defer { try? FileManager.default.removeItem(at: f.directory) }
        let report = try await f.remover.reconcile(skipping: [f.a.id])
        #expect(report == Reconciliation() && f.domains.removals.isEmpty && f.catalogExists(f.a.id))
    }

    @Test func aConfigurationFromAnOlderBuildLoadsWithoutGoneSince() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try ConnectionStore(directory: directory, vault: MemoryVault())
        let saved = location("A", goneSince: Date(timeIntervalSince1970: 1_000))
        try store.save([saved])
        let file = directory.appendingPathComponent("locations.json")
        var object = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var entries = try #require(object["locations"] as? [[String: Any]])
        #expect(entries[0]["goneSince"] != nil)
        entries[0].removeValue(forKey: "goneSince")
        object["locations"] = entries
        try JSONSerialization.data(withJSONObject: object).write(to: file)
        var older = saved; older.goneSince = nil
        #expect(try store.load() == [older])
    }
}

@Suite struct CredentialVerdictTests {
    let start = Date(timeIntervalSince1970: 1_000_000)

    @Test func aPlainRefusalOnlySignsOutHoweverLongItLasts() {
        for later: TimeInterval in [0, goneConfirmation, 30 * 86_400] {
            #expect(credentialVerdict(DriveError.authentication, goneSince: nil, now: start + later) == .signedOut)
            #expect(credentialVerdict(DriveError.authentication, goneSince: start, now: start + later) == .signedOut)
        }
    }

    @Test func aGoneCredentialIsRemovedOnlyWhenTheServerStillSaysSoAnHourLater() {
        #expect(credentialVerdict(DriveError.credentialGone, goneSince: nil, now: start) == .gone(since: start))
        #expect(credentialVerdict(DriveError.credentialGone, goneSince: start, now: start + goneConfirmation - 1) == .gone(since: start))
        #expect(credentialVerdict(DriveError.credentialGone, goneSince: start, now: start + goneConfirmation) == .remove)
        // Accepted again in between (a restore rolled back): the caller forgets the first answer.
        #expect(credentialVerdict(nil, goneSince: start, now: start + 10) == .valid)
    }

    @Test func transientFailuresSayNothingAboutTheCredential() {
        let failures: [any Error] = [DriveError.unavailable, DriveError.missing, DriveError.forbidden,
                                     DriveError.server("The server rejected this request (502)."),
                                     URLError(.notConnectedToInternet), URLError(.timedOut), CancellationError()]
        for failure in failures {
            #expect(credentialVerdict(failure, goneSince: nil, now: start) == .unknown)
            #expect(credentialVerdict(failure, goneSince: start, now: start + 2 * goneConfirmation) == .unknown)
        }
    }

    @Test func aClockThatWentBackStartsTheWaitAgain() {
        let future = start + 86_400
        #expect(credentialVerdict(DriveError.credentialGone, goneSince: future, now: start) == .gone(since: start))
        #expect(credentialCheckDue(goneSince: future, now: start))
    }

    @Test func aLocationWaitingToBeRemovedIsNotAskedAboutUntilTheHourIsUp() {
        #expect(credentialCheckDue(goneSince: nil, now: start))
        #expect(!credentialCheckDue(goneSince: start, now: start))
        #expect(!credentialCheckDue(goneSince: start, now: start + goneConfirmation - 1))
        #expect(credentialCheckDue(goneSince: start, now: start + goneConfirmation))
    }
}
