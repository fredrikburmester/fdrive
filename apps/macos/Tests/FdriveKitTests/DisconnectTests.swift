import Foundation
import Testing
@testable import FdriveKit

/// A server that answers disconnection however the test asks it to — including by not
/// being there at all, which is the case that used to strand a location.
private final class DisconnectServer: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    /// `nil` means the request fails as an unreachable host does.
    nonisolated(unsafe) private static var status: Int?
    nonisolated(unsafe) private static var asked = 0
    nonisolated(unsafe) private static var timeouts: [TimeInterval] = []
    static func reset(status: Int?) { lock.withLock { Self.status = status; asked = 0; timeouts = [] } }
    static var requests: Int { lock.withLock { asked } }
    /// The per-request limits the client asked for, in order.
    static var requestTimeouts: [TimeInterval] { lock.withLock { timeouts } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let status = Self.lock.withLock {
            Self.asked += 1; Self.timeouts.append(request.timeoutInterval); return Self.status
        }
        guard let status else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                              headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"ok\":true}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func client(_ session: URLSession) throws -> APIClient {
    try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test",
                  session: session, protocolVersion: 2)
}

private func session() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [DisconnectServer.self]
    return URLSession(configuration: configuration)
}

/// Serialized: every case drives the same stub.
@Suite(.serialized) struct DisconnectTests {
    // Disconnecting is local work. A server that is down, moved, or never coming back
    // must not be able to refuse it — the location would be stuck in the list forever.
    @Test func revocationReportsFailureRatherThanThrowingWhenTheServerIsUnreachable() async throws {
        DisconnectServer.reset(status: nil)
        let live = session()
        defer { live.invalidateAndCancel() }
        let api = try client(live)
        #expect(await api.revokeAccess() == false)
        #expect(DisconnectServer.requests == 1)
    }

    // Nothing waits on the answer, so a host that drops packets instead of refusing
    // must not hold Disconnect for the session's full sixty seconds.
    @Test func revocationAsksForAShortTimeout() async throws {
        DisconnectServer.reset(status: 200)
        let live = session()
        defer { live.invalidateAndCancel() }
        let api = try client(live)
        _ = await api.revokeAccess()
        #expect(DisconnectServer.requestTimeouts == [APIClient.revokeTimeout])
        #expect(APIClient.revokeTimeout < 60)
    }

    // A server that answers but does not revoke leaves the credential live. The
    // location still goes; the app is told so it can say the access remains.
    @Test func revocationReportsFailureForAServerThatDoesNotRevoke() async throws {
        // 503: the server is up but failing. 404: the host no longer serves fdrive at
        // all — an fdrive server answers an unknown token with 401, never 404.
        for status in [503, 404] {
            DisconnectServer.reset(status: status)
            let live = session()
            defer { live.invalidateAndCancel() }
            let api = try client(live)
            #expect(await api.revokeAccess() == false, "status \(status)")
        }
    }

    @Test func revocationSucceedsWhenTheServerAccepts() async throws {
        DisconnectServer.reset(status: 200)
        let live = session()
        defer { live.invalidateAndCancel() }
        let api = try client(live)
        #expect(await api.revokeAccess() == true)
    }

    // A credential the server refuses is one it has already forgotten or revoked:
    // nothing is left to revoke.
    @Test func revocationCountsARefusedCredentialAsRevoked() async throws {
        DisconnectServer.reset(status: 401)
        let live = session()
        defer { live.invalidateAndCancel() }
        let api = try client(live)
        #expect(await api.revokeAccess() == true)
    }
}
