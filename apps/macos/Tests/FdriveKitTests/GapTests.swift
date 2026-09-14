import Foundation
import Testing
@testable import FdriveKit

private func gapFixture() throws -> (Catalog, ConnectionStore, URL) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let store = try ConnectionStore(directory: directory)
    return (try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Gaps"), store, directory)
}

// Case 3: the pairing record outlives a crash between redemption and Keychain storage.
@Test func pendingPairingSurvivesRestartAndExpiresWithTheServerWindow() throws {
    let (_, store, directory) = try gapFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    #expect(try store.pendingPairing() == nil)
    let pairing = Pairing(id: UUID().uuidString, secret: "s3cret", code: "ABCD1234", expiresAt: "2026-09-14T10:05:00.000Z")
    let pending = PendingPairing(server: URL(string: "https://drive.example")!, pairing: pairing)
    try store.savePendingPairing(pending)
    let reopened = try ConnectionStore(directory: directory)
    #expect(try reopened.pendingPairing() == pending)
    let permissions = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("pending-pairing.json").path)[.posixPermissions] as? Int
    #expect(permissions == 0o600)
    let expires = try #require(ISO8601DateFormatter().date(from: "2026-09-14T10:05:00Z"))
    #expect(!pending.isExpired(now: expires.addingTimeInterval(-1)))
    #expect(pending.isExpired(now: expires))
    #expect(PendingPairing(server: pending.server, pairing: Pairing(id: "x", secret: "y", code: "z", expiresAt: "soon")).isExpired())
    try store.clearPendingPairing()
    #expect(try store.pendingPairing() == nil)
    try store.clearPendingPairing()
}

// Case 17: a disabled or missing domain is reported with the way to repair it.
@Test func domainStateMapsToActionableHealth() {
    #expect(locationHealth(nil) == .unregistered)
    #expect(locationHealth(DomainState(userEnabled: false, disconnected: false)) == .disabled)
    #expect(locationHealth(DomainState(userEnabled: false, disconnected: true)) == .disabled)
    #expect(locationHealth(DomainState(userEnabled: true, disconnected: true)) == .disconnected)
    #expect(locationHealth(DomainState(userEnabled: true, disconnected: false)) == .ready)
    #expect(LocationHealth.ready.guidance == nil && !LocationHealth.ready.needsSystemSettings)
    #expect(LocationHealth.disabled.needsSystemSettings && LocationHealth.disabled.guidance?.contains("System Settings") == true)
    #expect(!LocationHealth.unregistered.canRefresh && LocationHealth.disabled.canRefresh)
}

// Case 20: health follows the extension's own callbacks, not only server refresh.
@Test func stalledEnumerationIsDetectedFromTheSharedHeartbeat() async throws {
    let (catalog, _, directory) = try gapFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(!enumerationStale(lastCallback: nil, signalled: nil, now: start))
    #expect(!enumerationStale(lastCallback: nil, signalled: start, now: start.addingTimeInterval(119)))
    #expect(enumerationStale(lastCallback: nil, signalled: start, now: start.addingTimeInterval(120)))
    #expect(enumerationStale(lastCallback: start.addingTimeInterval(-1), signalled: start, now: start.addingTimeInterval(200)))
    #expect(!enumerationStale(lastCallback: start.addingTimeInterval(5), signalled: start, now: start.addingTimeInterval(200)))
    #expect(try await catalog.lastCallback().at == nil)
    let revision = try await catalog.revision()
    try await catalog.recordCallback(error: "Listing failed")
    let recorded = try await catalog.lastCallback()
    #expect(recorded.at.map { abs($0.timeIntervalSinceNow) < 5 } == true && recorded.error == "Listing failed")
    try await catalog.recordCallback()
    #expect(try await catalog.lastCallback().error == nil)
    // The heartbeat never manufactures a change for Finder to re-enumerate.
    #expect(try await catalog.revision() == revision)
    #expect(try await catalog.changes(since: revision).items.isEmpty)
}

private final class Exchange: @unchecked Sendable {
    let lock = NSLock()
    var requests: [URLRequest] = []
    var lastName = ""
    var completed: String?
    var collisions: Int
    let remoteId = UUID().uuidString.lowercased()
    init(collisions: Int) { self.collisions = collisions }
    func respond(_ request: URLRequest) -> (Int, String) {
        lock.withLock {
            requests.append(request)
            let path = request.url?.path ?? ""
            let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let operation = body?["operationId"] as? String ?? path.split(separator: "/").dropLast().last.map(String.init) ?? ""
            if path.hasSuffix("/uploads") {
                lastName = body?["name"] as? String ?? ""
                return (200, "{\"operationId\":\"\(operation)\",\"state\":\"receiving\",\"item\":null,\"recoveryId\":null}")
            }
            if path.hasSuffix("/content") { return (200, "{\"operationId\":\"\(operation)\",\"state\":\"ready\",\"item\":null,\"recoveryId\":null}") }
            if path.hasSuffix("/commit") {
                if collisions > 0 {
                    collisions -= 1
                    return (409, "{\"error\":{\"kind\":\"conflict\",\"message\":\"An item with this name already exists\",\"details\":{\"code\":\"name_collision\"}}}")
                }
                let item = "{\"path\":\"/\(lastName)\",\"name\":\"\(lastName)\",\"kind\":\"file\",\"size\":5,\"modifiedAt\":\"2026-09-14T10:00:00.000Z\",\"readable\":true,\"id\":\"\(remoteId)\",\"parentId\":\"root\",\"version\":{\"content\":\"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\",\"metadata\":\"m\"}}"
                completed = item
                return (200, "{\"operationId\":\"\(operation)\",\"state\":\"completed\",\"item\":\(item),\"recoveryId\":null}")
            }
            if path.hasSuffix("/entries") { return (200, "{\"entries\":[\(completed ?? "")],\"nextCursor\":null}") }
            return (200, "{\"operationId\":\"\(operation)\",\"state\":\"acknowledged\",\"item\":null,\"recoveryId\":null}")
        }
    }
}
private final class ExchangeProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var exchange: Exchange?
    static func use(_ exchange: Exchange) { lock.withLock { self.exchange = exchange } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var request = self.request
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open(); var data = Data(); let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            while stream.hasBytesAvailable { let read = stream.read(buffer, maxLength: 4096); if read <= 0 { break }; data.append(buffer, count: read) }
            buffer.deallocate(); stream.close()
            if request.value(forHTTPHeaderField: "Content-Type") == "application/json" { request.httpBody = data }
        }
        let (status, body) = Self.lock.withLock { Self.exchange! }.respond(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private func exchangeClient(_ exchange: Exchange) throws -> (APIClient, URLSession) {
    ExchangeProtocol.use(exchange)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ExchangeProtocol.self]
    let session = URLSession(configuration: configuration)
    return (try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test", session: session, protocolVersion: 2), session)
}

// Case 81: a taken conflict name gets bounded numbered retries; the fourth collision
// keeps the pending copy with a persistent error instead of an endless loop.
@Test func conflictCopyNamesRetryWhenTakenAndStopAfterThreeAttempts() async throws {
    let (catalog, _, directory) = try gapFixture()
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("hello.txt")
    try Data("hello".utf8).write(to: file)
    // Original name taken, first conflict name taken, second conflict name free.
    let exchange = Exchange(collisions: 2)
    let (client, session) = try exchangeClient(exchange); defer { session.invalidateAndCancel() }
    let coordinator = WriteCoordinator(catalog: catalog, client: client)
    let result = try await coordinator.perform(route: "uploads", localId: nil, templateKey: "template", parentId: "root",
                                               name: "hello.txt", base: nil, contents: file, progress: Progress(totalUnitCount: -1))
    let names = exchange.requests.filter { $0.url?.path.hasSuffix("/uploads") == true }
        .compactMap { $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["name"] as? String }
    #expect(names.count == 3 && names[0] == "hello.txt")
    #expect(names[1].hasPrefix("hello (conflict ") && names[1].hasSuffix(").txt") && !names[1].contains("-2"))
    #expect(names[2].hasPrefix("hello (conflict ") && names[2].hasSuffix("-2).txt"))
    #expect(result.entry.name == names[2] && result.materialized)
    let pending = try #require(try await catalog.pendingWrites().first)
    #expect(pending.result?.id == result.id && pending.originalName == "hello.txt" && pending.conflictAttempts == 2)
    let cancelled = exchange.requests.filter { $0.url?.path.hasSuffix("/cancel") == true }.map { $0.url!.path.split(separator: "/").dropLast().last! }
    #expect(Set(cancelled.map(String.init)) == Set(pending.abandonedOperations ?? []) && cancelled.count == 2)
    #expect(!FileManager.default.fileExists(atPath: catalog.recoveryDirectory.appendingPathComponent(pending.id).path))
    // Every attempt collides: the error stands after the third numbered name.
    let stubborn = Exchange(collisions: 10)
    let (blocked, second) = try exchangeClient(stubborn); defer { second.invalidateAndCancel() }
    try Data("again".utf8).write(to: file)
    await #expect(throws: DriveError.self) {
        _ = try await WriteCoordinator(catalog: catalog, client: blocked).perform(route: "uploads", localId: nil, templateKey: "again",
            parentId: "root", name: "again.txt", base: nil, contents: file, progress: Progress(totalUnitCount: -1))
    }
    let attempted = stubborn.requests.filter { $0.url?.path.hasSuffix("/uploads") == true }
        .compactMap { $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["name"] as? String }
    #expect(attempted.count == 4 && attempted.last?.hasSuffix("-3).txt") == true)
    let stuck = try #require(try await catalog.pendingWrites().first { $0.result == nil })
    #expect(stuck.conflictAttempts == 3 && stuck.error?.contains("already exists") == true)
    #expect(FileManager.default.fileExists(atPath: catalog.recoveryDirectory.appendingPathComponent(stuck.id).appendingPathComponent("content").path))
    // Replaying the callback resumes the current attempt instead of starting a fourth name.
    await #expect(throws: DriveError.self) {
        _ = try await WriteCoordinator(catalog: catalog, client: blocked).perform(route: "uploads", localId: nil, templateKey: "again",
            parentId: "root", name: "again.txt", base: nil, contents: file, progress: Progress(totalUnitCount: -1))
    }
    #expect(try await catalog.pendingWrites().filter { $0.result == nil }.count == 1)
}
