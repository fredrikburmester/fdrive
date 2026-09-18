import Foundation
import Testing
@testable import FdriveKit

private let publishedFolder = """
{"path":"/moved","name":"moved","kind":"dir","size":0,"modifiedAt":"1970-01-01T00:00:00.000Z",\
"readable":true,"id":"33333333-3333-4333-8333-333333333333","parentId":"root",\
"version":{"content":"digest","metadata":"m"},\
"capabilities":{"create":true,"update":true,"move":true,"trash":false,"restore":false}}
"""

/// A server whose operation is already publishing when this device asks about it — what a
/// retry meets after File Provider gives up waiting on a long folder move and issues the
/// modification again. The copy is still running; the outcome is pending, not unknown.
private final class CommittingServer: URLProtocol, @unchecked Sendable {
    /// What the operation settles as once it stops reporting `committing`.
    nonisolated(unsafe) static var settlesAs = "completed"
    /// How many status reads it stays `committing` for.
    nonisolated(unsafe) static var staysCommitting = 3
    private static let lock = NSLock()
    nonisolated(unsafe) private static var reads = 0
    static func reset(settlesAs: String, staysCommitting: Int) {
        lock.withLock { reads = 0; Self.settlesAs = settlesAs; Self.staysCommitting = staysCommitting }
    }
    static var statusReads: Int { lock.withLock { reads } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private func deliver(_ body: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                                              headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    private var operationId: String {
        let parts = (request.url?.path ?? "").split(separator: "/")
        if let index = parts.firstIndex(of: "operations"), index + 1 < parts.count {
            return String(parts[index + 1])
        }
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open(); var read = Data(); let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(buffer, maxLength: 4096)
                if count <= 0 { break }
                read.append(buffer, count: count)
            }
            buffer.deallocate(); stream.close(); body = read
        }
        let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        return json?["operationId"] as? String ?? ""
    }
    override func startLoading() {
        let path = request.url?.path ?? ""
        let id = operationId
        // Any status read, and the prepare that opens the retry, answer the same way:
        // publishing, with how far the copy has got, until it settles.
        if path.hasSuffix("/commit") {
            // A retry must never reach this: the operation is already publishing.
            deliver("{\"operationId\":\"\(id)\",\"state\":\"conflict\",\"item\":null,\"recoveryId\":null}")
            return
        }
        let seen = Self.lock.withLock { () -> Int in Self.reads += 1; return Self.reads }
        if seen > Self.staysCommitting {
            if Self.settlesAs == "completed" {
                deliver("""
                {"operationId":"\(id)","state":"completed","recoveryId":null,"item":\(publishedFolder)}
                """)
            } else {
                deliver("{\"operationId\":\"\(id)\",\"state\":\"\(Self.settlesAs)\",\"item\":null,\"recoveryId\":null}")
            }
            return
        }
        deliver("""
        {"operationId":"\(id)","state":"committing","item":null,"recoveryId":null,\
        "progress":{"completed":\(seen * 250),"total":1000}}
        """)
    }
    override func stopLoading() {}
}

private func coordinator(_ directory: URL, title: String) throws -> (WriteCoordinator, URLSession) {
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: title)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommittingServer.self]
    let session = URLSession(configuration: configuration)
    let client = try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test",
                               session: session, protocolVersion: 2)
    return (WriteCoordinator(catalog: catalog, client: client, progressPoll: .milliseconds(10)), session)
}

/// Serialized: both cases drive the same stub, whose reply depends on how many times it
/// has been asked.
@Suite(.serialized) struct RetryTests {
    // File Provider retries a modification it decides has taken too long. On object storage a
    // folder publish outlasts that easily, so the retry finds the operation still publishing.
    // That is a save still running, not one the server could not confirm.
    @Test func aRetryWaitsForAPublishAlreadyRunningInsteadOfCallingItUncertain() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        CommittingServer.reset(settlesAs: "completed", staysCommitting: 3)
        let (writer, session) = try coordinator(directory, title: "Retry")
        defer { session.invalidateAndCancel() }
        let progress = Progress(totalUnitCount: -1)
        let item = try await writer.perform(route: "moves", localId: nil, templateKey: "folder", parentId: "root",
                                            name: "moved", base: nil, contents: nil, progress: progress)
        #expect(item.entry.name == "moved")
        // It waited rather than asking once and giving up.
        #expect(CommittingServer.statusReads > 3)
        // And it drove the bar from what the running publish reported.
        #expect(progress.totalUnitCount == 1_000)
        // Nothing is left outstanding: no phantom entry in Recovery for a save that worked.
        let outstanding = try await writer.catalog.pendingWrites().filter { $0.result == nil }
        #expect(outstanding.isEmpty)
    }

    // A publish that settles as cancelled is finished, not an outage: the pending write is
    // settled rather than left for a retry of something someone deliberately stopped.
    @Test func aRetryTreatsASettledCancellationAsCancelledRatherThanUnavailable() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        CommittingServer.reset(settlesAs: "cancelled", staysCommitting: 1)
        let (writer, session) = try coordinator(directory, title: "RetryCancelled")
        defer { session.invalidateAndCancel() }
        await #expect(throws: DriveError.cancelled) {
            _ = try await writer.perform(route: "moves", localId: nil, templateKey: "folder", parentId: "root",
                                         name: "moved", base: nil, contents: nil, progress: Progress(totalUnitCount: -1))
        }
        let outstanding = try await writer.catalog.pendingWrites().filter { $0.result == nil }
        #expect(outstanding.isEmpty)
    }
}
