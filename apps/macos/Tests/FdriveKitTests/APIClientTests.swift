import Foundation
import Testing
@testable import FdriveKit

private final class Responses: @unchecked Sendable {
    let lock = NSLock()
    var requests: [URLRequest] = []
    var bodies: [(Int, String)]
    init(_ bodies: [(Int, String)]) { self.bodies = bodies }
    func respond(_ request: URLRequest) -> (Int, String) {
        lock.withLock { requests.append(request); return bodies.removeFirst() }
    }
}
private final class MockProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var responses: Responses?
    static func use(_ responses: Responses) { lock.withLock { self.responses = responses } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = Self.lock.withLock { Self.responses! }
        let (status, body) = response.respond(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized)
struct APIClientTests {
    private func client(_ responses: Responses) throws -> (APIClient, URLSession) {
        MockProtocol.use(responses)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockProtocol.self]
        let session = URLSession(configuration: config)
        return (try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test", session: session), session)
    }
    @Test func pagesMetadataAndEncodesPathsWithoutDownloading() async throws {
        let entry = RemoteEntry(path: "/docs/a% b.txt", name: "a% b.txt", kind: "file", size: 4)
        let first = String(decoding: try JSONEncoder().encode(Listing(entries: [entry], nextCursor: "next")), as: UTF8.self)
        let second = String(decoding: try JSONEncoder().encode(Listing(entries: [.init(path: "/docs/b.txt", name: "b.txt", kind: "file")], nextCursor: nil)), as: UTF8.self)
        let responses = Responses([(200, first), (200, second)])
        let (api, session) = try client(responses); defer { session.invalidateAndCancel() }
        #expect(try await api.list("/docs").count == 2)
        #expect(responses.requests.allSatisfy { $0.url?.path == "/api/v1/desktop/entries" })
        #expect(responses.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fdd_test" })
        #expect(URLComponents(url: responses.requests[1].url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(.init(name: "cursor", value: "next")) == true)
    }
    @Test func rejectsRepeatedPathsAndInvalidContinuations() async throws {
        for entries in [[RemoteEntry(path: "/outside/a", name: "a", kind: "file")], []] {
            let json = String(decoding: try JSONEncoder().encode(Listing(entries: entries, nextCursor: "loop")), as: UTF8.self)
            let (api, session) = try client(Responses([(200, json)])); defer { session.invalidateAndCancel() }
            await #expect(throws: DriveError.self) { try await api.list("/docs") }
        }
        let entry = RemoteEntry(path: "/a", name: "a", kind: "file")
        let json = String(decoding: try JSONEncoder().encode(Listing(entries: [entry, entry], nextCursor: nil)), as: UTF8.self)
        let (api, session) = try client(Responses([(200, json)])); defer { session.invalidateAndCancel() }
        await #expect(throws: DriveError.self) { try await api.list("/") }
    }
    @Test func reportsOfflineAuthenticationAndExpiredSnapshotsWithoutEmptyListings() async throws {
        for (status, expected) in [(401, DriveError.authentication), (403, .forbidden), (404, .missing), (409, .expiredSnapshot), (429, .unavailable), (503, .unavailable)] {
            let (api, session) = try client(Responses([(status, "{}")])); defer { session.invalidateAndCancel() }
            await #expect(throws: expected) { try await api.list("/") }
        }
    }
    @Test func rejectsUnrelatedContentValidators() async throws {
        let json = "{\"items\":[{\"path\":\"/other\",\"version\":\"bad\",\"size\":3}]}"
        let (api, session) = try client(Responses([(200, json)])); defer { session.invalidateAndCancel() }
        await #expect(throws: DriveError.self) { try await api.versions(["/a"]) }
    }
    // Case 83: a storage lock or unclassified 409 on a write is a conflict, never an expired listing.
    @Test func unclassifiedWriteConflictsAreConflictsNotExpiredSnapshots() async throws {
        let (api, session) = try client(Responses([(409, "{\"error\":{\"kind\":\"conflict\",\"message\":\"Locked by another client\"}}")]))
        defer { session.invalidateAndCancel() }
        await #expect(throws: DriveError.writeConflict("Locked by another client")) { try await api.commitWrite(UUID().uuidString.lowercased()) }
    }
    @Test func preservesRetryAndQuotaErrorsForPendingWrites() async throws {
        for (status, expected) in [(413, DriveError.quota), (502, .unavailable), (503, .unavailable)] {
            let (api, session) = try client(Responses([(status, "{\"error\":{\"message\":\"Storage rejected the save\"}}")]))
            defer { session.invalidateAndCancel() }
            await #expect(throws: expected) { try await api.commitWrite(UUID().uuidString.lowercased()) }
        }
    }
}
