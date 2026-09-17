import Foundation
import Testing
@testable import FdriveKit

private final class MemoryStorage: LicenseStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    var failWrites = false
    func read() throws -> Data? { lock.withLock { data } }
    func add(_ data: Data) throws -> Bool {
        try lock.withLock {
            if failWrites { throw LicenseError.storage }
            if self.data != nil { return false }
            self.data = data; return true
        }
    }
    func write(_ data: Data) throws {
        try lock.withLock {
            if failWrites { throw LicenseError.storage }
            self.data = data
        }
    }
}
private actor FakeProvider: LicenseProvider {
    var activation: Result<String, LicenseError> = .success("activation-1")
    var validation: LicenseError?
    var deactivation: LicenseError?
    private(set) var validations = 0
    private(set) var deactivated: [String] = []
    func set(activation: Result<String, LicenseError>) { self.activation = activation }
    func set(validation: LicenseError?) { self.validation = validation }
    func set(deactivation: LicenseError?) { self.deactivation = deactivation }
    func activate(key: String, label: String) async throws -> String { try activation.get() }
    func validate(key: String, activationId: String) async throws {
        validations += 1
        if let validation { throw validation }
    }
    func deactivate(key: String, activationId: String) async throws {
        if let deactivation { throw deactivation }
        deactivated.append(activationId)
    }
}
private let start = Date(timeIntervalSince1970: 1_800_000_000)
private let day: TimeInterval = 86_400
private func fixture() -> (LicenseManager, MemoryStorage, FakeProvider) {
    let storage = MemoryStorage(), provider = FakeProvider()
    return (LicenseManager(store: LicenseStore(storage: storage), provider: provider), storage, provider)
}

@Test func trialCountsDownFromFirstReadAndEndsAfterSevenDays() throws {
    let (manager, _, _) = fixture()
    #expect(try manager.state(now: start) == .trial(daysLeft: 7))
    #expect(try manager.state(now: start + 1) == .trial(daysLeft: 7))
    #expect(try manager.state(now: start + day) == .trial(daysLeft: 6))
    #expect(try manager.state(now: start + 6 * day + 1) == .trial(daysLeft: 1))
    #expect(try manager.state(now: start + 7 * day - 1) == .trial(daysLeft: 1))
    #expect(try manager.state(now: start + 7 * day) == .trialEnded)
    #expect(!LicenseState.trialEnded.allowsAccess)
}

@Test func laterReadsAndAnotherProcessNeverRestartTheTrial() throws {
    let (manager, storage, _) = fixture()
    _ = try manager.state(now: start)
    let other = LicenseStore(storage: storage)
    #expect(try other.load(now: start + 5 * day).trialStarted == start)
    #expect(try manager.state(now: start + 8 * day) == .trialEnded)
}

@Test func clockSetBeforeTheTrialNeverExtendsIt() {
    #expect(LicenseRecord(trialStarted: start).state(now: start - 30 * day) == .trial(daysLeft: 7))
}

@Test func unreadableRecordIsAnErrorRatherThanAFreshTrial() throws {
    let storage = MemoryStorage()
    try storage.write(Data("not json".utf8))
    #expect(throws: LicenseError.storage) { try LicenseStore(storage: storage).load(now: start) }
}

@Test func activationLicensesAnExpiredTrialAndTrimsThePastedKey() async throws {
    let (manager, storage, _) = fixture()
    _ = try manager.state(now: start)
    #expect(try await manager.activate(key: "  FDRIVE-KEY\n", label: "Mac", now: start + 10 * day) == .licensed)
    let record = try LicenseStore(storage: storage).load(now: start + 10 * day)
    #expect(record.key == "FDRIVE-KEY")
    #expect(record.activationId == "activation-1")
    #expect(record.trialStarted == start)
}

@Test func rejectedActivationLeavesTheTrialUntouched() async throws {
    let (manager, _, provider) = fixture()
    for failure in [LicenseError.invalidKey, .activationLimit, .unavailable] {
        await provider.set(activation: .failure(failure))
        await #expect(throws: failure) { try await manager.activate(key: "KEY", label: "Mac", now: start) }
    }
    await #expect(throws: LicenseError.invalidKey) { try await manager.activate(key: "  ", label: "Mac", now: start) }
    #expect(try manager.state(now: start) == .trial(daysLeft: 7))
}

@Test func activationThatCannotBeSavedReleasesItsSeat() async throws {
    let (manager, storage, provider) = fixture()
    _ = try manager.state(now: start)
    storage.failWrites = true
    await #expect(throws: LicenseError.storage) { try await manager.activate(key: "KEY", label: "Mac", now: start) }
    #expect(await provider.deactivated == ["activation-1"])
}

@Test func revalidationIsWeeklyAndAnOutageKeepsTheLicenseThroughTheGrace() async throws {
    let (manager, _, provider) = fixture()
    _ = try await manager.activate(key: "KEY", label: "Mac", now: start)
    #expect(try await manager.revalidateIfDue(now: start + 6 * day) == .licensed)
    #expect(await provider.validations == 0)
    #expect(try await manager.revalidateIfDue(now: start + 7 * day) == .licensed)
    #expect(await provider.validations == 1)

    await provider.set(validation: .unavailable)
    #expect(try await manager.revalidateIfDue(now: start + 37 * day) == .licensed)
    #expect(try await manager.revalidateIfDue(now: start + 37 * day + 1) == .validationOverdue)
    #expect(!LicenseState.validationOverdue.allowsAccess)

    await provider.set(validation: nil)
    #expect(try await manager.revalidateIfDue(now: start + 60 * day) == .licensed)
}

@Test func revokedOrUnknownLicenseFallsBackToTheTrialClock() async throws {
    for failure in [LicenseError.revoked, .invalidKey] {
        let (manager, storage, provider) = fixture()
        _ = try await manager.activate(key: "KEY", label: "Mac", now: start)
        await provider.set(validation: failure)
        #expect(try await manager.revalidateIfDue(now: start + 3 * day) == .licensed)
        #expect(try await manager.revalidateIfDue(now: start + 8 * day) == .trialEnded)
        #expect(try LicenseStore(storage: storage).load(now: start).key == nil)
    }
}

@Test func deactivationFreesTheSeatButAnOutageKeepsTheLicense() async throws {
    let (manager, _, provider) = fixture()
    _ = try await manager.activate(key: "KEY", label: "Mac", now: start)
    await provider.set(deactivation: .unavailable)
    await #expect(throws: LicenseError.unavailable) { try await manager.deactivate(now: start + day) }
    #expect(try manager.state(now: start + day) == .licensed)

    await provider.set(deactivation: nil)
    #expect(try await manager.deactivate(now: start + day) == .trial(daysLeft: 6))
    #expect(await provider.deactivated == ["activation-1"])

    _ = try await manager.activate(key: "KEY", label: "Mac", now: start + day)
    await provider.set(deactivation: .invalidKey)
    #expect(try await manager.deactivate(now: start + 9 * day) == .trialEnded)
}

private final class PolarResponses: @unchecked Sendable {
    let lock = NSLock()
    var requests: [(URL, [String: String])] = []
    var bodies: [(Int, String)]
    init(_ bodies: [(Int, String)]) { self.bodies = bodies }
}
private final class PolarProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var responses: PolarResponses?
    static func use(_ responses: PolarResponses) { lock.withLock { self.responses = responses } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let responses = Self.lock.withLock { Self.responses! }
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; body.append(buffer, count: count) }
        } else if let data = request.httpBody { body = data }
        let fields = (try? JSONDecoder().decode([String: String].self, from: body)) ?? [:]
        let (status, text) = responses.lock.withLock { responses.requests.append((request.url!, fields)); return responses.bodies.removeFirst() }
        if status == 0 { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized)
struct PolarLicenseProviderTests {
    private let organization = "0b8f4a52-6f0e-4a63-9f2b-2f3b1f6f7a11"
    private func provider(_ responses: PolarResponses) -> (PolarLicenseProvider, URLSession) {
        PolarProtocol.use(responses)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PolarProtocol.self]
        let session = URLSession(configuration: config)
        return (PolarLicenseProvider(organizationId: organization, session: session, now: { start }), session)
    }
    @Test func activationSendsOnlyTheKeyLabelAndOrganization() async throws {
        let responses = PolarResponses([(200, #"{"id":"A1","license_key":{"status":"granted"}}"#)])
        let (polar, session) = provider(responses); defer { session.invalidateAndCancel() }
        #expect(try await polar.activate(key: "KEY", label: "Work Mac") == "A1")
        let (url, fields) = responses.requests[0]
        #expect(url.absoluteString == "https://api.polar.sh/v1/customer-portal/license-keys/activate")
        #expect(fields == ["key": "KEY", "label": "Work Mac", "organization_id": organization])
    }
    @Test func activationFailuresAreDistinguished() async throws {
        for (status, expected) in [(403, LicenseError.activationLimit), (404, .invalidKey), (422, .invalidKey), (500, .unavailable), (429, .unavailable), (0, .unavailable)] {
            let (polar, session) = provider(PolarResponses([(status, "{}")])); defer { session.invalidateAndCancel() }
            await #expect(throws: expected) { try await polar.activate(key: "KEY", label: "Mac") }
        }
        let (polar, session) = provider(PolarResponses([(200, "<html>")])); defer { session.invalidateAndCancel() }
        await #expect(throws: LicenseError.unavailable) { try await polar.activate(key: "KEY", label: "Mac") }
    }
    @Test func validationRequiresAGrantedUnexpiredKeyWithThisActivation() async throws {
        let cases: [(String, LicenseError?)] = [
            (#"{"status":"granted","expires_at":null,"activation":{"id":"a1"}}"#, nil),
            (#"{"status":"granted","expires_at":"2099-01-01T00:00:00.000000Z","activation":{"id":"A1"}}"#, nil),
            (#"{"status":"granted","expires_at":"2020-01-01T00:00:00Z","activation":{"id":"A1"}}"#, .revoked),
            (#"{"status":"revoked","expires_at":null,"activation":{"id":"A1"}}"#, .revoked),
            (#"{"status":"disabled","expires_at":null,"activation":{"id":"A1"}}"#, .revoked),
            (#"{"status":"granted","expires_at":null,"activation":null}"#, .revoked),
            (#"{"status":"granted","expires_at":null,"activation":{"id":"other"}}"#, .revoked)
        ]
        for (body, expected) in cases {
            let responses = PolarResponses([(200, body)])
            let (polar, session) = provider(responses); defer { session.invalidateAndCancel() }
            if let expected { await #expect(throws: expected) { try await polar.validate(key: "KEY", activationId: "A1") } }
            else { try await polar.validate(key: "KEY", activationId: "A1") }
            #expect(responses.requests[0].1["activation_id"] == "A1")
        }
    }
    @Test func validationOutagesAreNeverReportedAsRevocation() async throws {
        for (status, expected) in [(404, LicenseError.invalidKey), (500, .unavailable), (503, .unavailable), (0, .unavailable)] {
            let (polar, session) = provider(PolarResponses([(status, "{}")])); defer { session.invalidateAndCancel() }
            await #expect(throws: expected) { try await polar.validate(key: "KEY", activationId: "A1") }
        }
        let (polar, session) = provider(PolarResponses([(200, "{}")])); defer { session.invalidateAndCancel() }
        await #expect(throws: LicenseError.unavailable) { try await polar.validate(key: "KEY", activationId: "A1") }
    }
    @Test func deactivationAcceptsNoContent() async throws {
        let responses = PolarResponses([(204, ""), (404, "{}"), (500, "{}")])
        let (polar, session) = provider(responses); defer { session.invalidateAndCancel() }
        try await polar.deactivate(key: "KEY", activationId: "A1")
        await #expect(throws: LicenseError.invalidKey) { try await polar.deactivate(key: "KEY", activationId: "A1") }
        await #expect(throws: LicenseError.unavailable) { try await polar.deactivate(key: "KEY", activationId: "A1") }
        #expect(responses.requests[0].0.lastPathComponent == "deactivate")
    }
    @Test func sandboxKeysOnlyReachTheSandboxServer() async throws {
        let responses = PolarResponses([(200, #"{"id":"A1"}"#)])
        PolarProtocol.use(responses)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PolarProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        _ = try await PolarLicenseProvider(organizationId: organization, sandbox: true, session: session).activate(key: "KEY", label: "Mac")
        #expect(responses.requests[0].0.host == "sandbox-api.polar.sh")
    }
}
