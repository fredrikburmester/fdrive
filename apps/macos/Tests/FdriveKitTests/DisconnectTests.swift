import Foundation
import Testing
@testable import FdriveKit

/// A server that answers disconnection however the test asks it to — including by not
/// being there at all, which is the case that used to strand a location.
private final class DisconnectServer: URLProtocol, @unchecked Sendable {
    /// `nil` means the request fails as an unreachable host does.
    nonisolated(unsafe) static var status: Int?
    private static let lock = NSLock()
    nonisolated(unsafe) private static var asked = 0
    static func reset(status: Int?) { lock.withLock { Self.status = status; asked = 0 } }
    static var requests: Int { lock.withLock { asked } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.withLock { Self.asked += 1 }
        guard let status = Self.status else {
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

    // A server that is up but refusing is no different: still nothing to revoke, and
    // still no reason to keep the location.
    @Test func revocationReportsFailureForAServerThatRefuses() async throws {
        DisconnectServer.reset(status: 503)
        let live = session()
        defer { live.invalidateAndCancel() }
        let api = try client(live)
        #expect(await api.revokeAccess() == false)
    }

    @Test func revocationSucceedsWhenTheServerAccepts() async throws {
        DisconnectServer.reset(status: 200)
        let live = session()
        defer { live.invalidateAndCancel() }
        let api = try client(live)
        #expect(await api.revokeAccess() == true)
    }

    // A credential the server has already forgotten, or already refuses, needs no
    // revoking: nothing is left to revoke either way.
    @Test func revocationCountsAnAlreadyInvalidCredentialAsRevoked() async throws {
        for status in [401, 404] {
            DisconnectServer.reset(status: status)
            let live = session()
            let api = try client(live)
            #expect(await api.revokeAccess() == true, "status \(status)")
            live.invalidateAndCancel()
        }
    }
}
