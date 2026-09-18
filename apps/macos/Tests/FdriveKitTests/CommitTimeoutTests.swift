import Darwin
import Foundation
import Testing
@testable import FdriveKit

private struct ServerUnavailable: Error {}

/// A server that accepts a request and then says nothing at all until a delay has
/// passed — the shape a long publish produces, where the reply comes only once the
/// copy behind it has finished. A `URLProtocol` stub cannot stand in for this: it
/// replaces the loading system that applies the timeout being tested.
private final class StallingServer: @unchecked Sendable {
    private let listener: Int32
    private let delay: TimeInterval
    private let body: String
    let port: UInt16

    init(delay: TimeInterval, body: String) throws {
        self.delay = delay
        self.body = body
        // A local descriptor throughout: the closures below would otherwise capture
        // `self` to reach the stored one, before `port` has a value.
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ServerUnavailable() }
        var reuse: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0 // any free port, so parallel tests never collide
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(descriptor, 8) == 0 else { Darwin.close(descriptor); throw ServerUnavailable() }
        var assigned = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &assigned) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descriptor, $0, &length) }
        }
        guard named == 0 else { Darwin.close(descriptor); throw ServerUnavailable() }
        port = UInt16(bigEndian: assigned.sin_port)
        listener = descriptor
    }

    func start() {
        DispatchQueue.global().async { [self] in
            while true {
                let connection = accept(listener, nil, nil)
                guard connection >= 0 else { return }
                DispatchQueue.global().async { [self] in
                    var request = [UInt8](repeating: 0, count: 8192)
                    _ = recv(connection, &request, request.count, 0)
                    Thread.sleep(forTimeInterval: delay)
                    let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                        + "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    response.withCString { _ = Darwin.send(connection, $0, strlen($0), 0) }
                    Darwin.close(connection)
                }
            }
        }
    }

    func stop() { Darwin.close(listener) }
}

private let publishedFolder = """
{"path":"/moved","name":"moved","kind":"dir","size":0,"modifiedAt":"1970-01-01T00:00:00.000Z",\
"readable":true,"id":"22222222-2222-4222-8222-222222222222","parentId":"root",\
"version":{"content":"digest","metadata":"m"},\
"capabilities":{"create":true,"update":true,"move":true,"trash":false,"restore":false}}
"""

private func stalled(_ server: StallingServer, idleTimeout: TimeInterval) throws -> APIClient {
    let configuration = URLSessionConfiguration.ephemeral
    // Deliberately far shorter than the stall, so anything relying on it gives up.
    configuration.timeoutIntervalForRequest = idleTimeout
    configuration.timeoutIntervalForResource = 86_400
    return try APIClient(server: URL(string: "http://127.0.0.1:\(server.port)")!, token: "fdd_test",
                         session: URLSession(configuration: configuration), protocolVersion: 2)
}

// Publishing a folder on storage without a rename copies every object under it.
// The commit request is open and silent for the whole copy, which outlasts any
// timeout meant for a metadata call, so the commit carries its own.
@Test func aCommitSurvivesASilenceLongerThanTheSessionsIdleTimeout() async throws {
    let server = try StallingServer(delay: 2, body: """
    {"operationId":"op","state":"completed","recoveryId":null,"item":\(publishedFolder)}
    """)
    server.start()
    defer { server.stop() }
    let client = try stalled(server, idleTimeout: 1)
    let result = try await client.commitWrite("op")
    #expect(result.state == "completed")
    #expect(result.item?.name == "moved")
}

// Only the commit waits. A metadata call that goes quiet is still a dead server,
// and the poll behind the progress bar has to fail rather than hang on one.
@Test func anOrdinaryCallStillGivesUpOnASilentServer() async throws {
    let server = try StallingServer(delay: 5, body: """
    {"operationId":"op","state":"committing","recoveryId":null,"item":null}
    """)
    server.start()
    defer { server.stop() }
    let client = try stalled(server, idleTimeout: 1)
    await #expect(throws: URLError.self) { try await client.writeStatus("op") }
}
