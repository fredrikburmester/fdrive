import Foundation
import Testing
@testable import FdriveKit

/// A server whose folder move takes a while and reports how far it has got, the
/// shape object storage produces: publishing copies every object under the tree.
private final class SlowMoveServer: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var polls = 0
    nonisolated(unsafe) static var total: Int64 = 0
    private static let lock = NSLock()
    static func reset(total: Int64) {
        lock.withLock { polls = 0; Self.total = total }
    }
    static var pollCount: Int { lock.withLock { polls } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private func deliver(_ body: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                                              headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    /// The coordinator makes its own operation id; every reply has to carry that
    /// one back or the write is treated as having lost track of itself.
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
        if path.hasSuffix("/commit") {
            // The commit answers only once the client has asked twice, so the test
            // proves polling rather than waiting on a clock. Off this queue, or the
            // polls it is waiting for could never be served. Bounded, so a client
            // that never polls fails the expectation instead of hanging.
            DispatchQueue.global().async { [self] in
                let deadline = Date().addingTimeInterval(5)
                while Self.pollCount < 2 && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
                deliver("""
                {"operationId":"\(id)","state":"completed","recoveryId":null,"item":{"path":"/moved",\
                "name":"moved","kind":"dir","size":0,"modifiedAt":"1970-01-01T00:00:00.000Z","readable":true,\
                "id":"22222222-2222-4222-8222-222222222222","parentId":"root",\
                "version":{"content":"digest","metadata":"m"},\
                "capabilities":{"create":true,"update":true,"move":true,"trash":false,"restore":false}}}
                """)
            }
            return
        }
        if request.httpMethod == "GET", path.contains("/operations/") {
            let seen = Self.lock.withLock { () -> Int in Self.polls += 1; return Self.polls }
            let done = min(Int64(seen) * Self.total / 4, Self.total)
            deliver("""
            {"operationId":"\(id)","state":"committing","item":null,"recoveryId":null,\
            "progress":{"completed":\(done),"total":\(Self.total)}}
            """)
            return
        }
        deliver("{\"operationId\":\"\(id)\",\"state\":\"ready\",\"item\":null,\"recoveryId\":null}")
    }
    override func stopLoading() {}
}

/// Every value the bar took, recorded from whichever thread moved it.
private final class Samples: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int64] = []
    func add(_ value: Int64) { lock.withLock { values.append(value) } }
    var all: [Int64] { lock.withLock { values } }
}

// A folder move on storage without a rename copies every object and can run for
// minutes. Finder shows a proportion for it instead of an indeterminate bar.
@Test func longFolderMoveReportsItsProgressWhileTheCommitRuns() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Progress")
    SlowMoveServer.reset(total: 4_000)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SlowMoveServer.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let client = try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test",
                               session: session, protocolVersion: 2)
    let progress = Progress(totalUnitCount: -1)
    let samples = Samples()
    let observation = progress.observe(\.completedUnitCount) { bar, _ in samples.add(bar.completedUnitCount) }
    defer { observation.invalidate() }
    let coordinator = WriteCoordinator(catalog: catalog, client: client, progressPoll: .milliseconds(20))
    _ = try await coordinator.perform(route: "moves", localId: nil, templateKey: "folder", parentId: "root",
                                      name: "moved", base: nil, contents: nil, progress: progress)
    // The bar became determinate from what the server reported, rather than
    // staying at the indeterminate -1 it started with for the whole copy.
    #expect(SlowMoveServer.pollCount >= 2)
    // Determinate, from what the server reported: nothing else moves it off -1.
    #expect(progress.totalUnitCount == 4_000)
    #expect(progress.completedUnitCount == 4_000)
    // And it advanced while the copy ran, rather than jumping only at the end.
    #expect(samples.all.contains { $0 > 0 && $0 < 4_000 })
}
