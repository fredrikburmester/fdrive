import Foundation
import Testing
@testable import FdriveKit

/// How the server answers this Mac's request to cancel an operation.
enum CancelAnswer: Sendable { case refused, unreachable, confirmed }

/// Resolves once the stub has seen a commit, so a test waits on that rather than a clock.
private final class Arrival: @unchecked Sendable {
    private let lock = NSLock()
    private var arrived = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func signal() {
        let waiting = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            arrived = true; defer { waiters = [] }; return waiters
        }
        waiting.forEach { $0.resume() }
    }
    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let now = lock.withLock { () -> Bool in
                if arrived { return true }
                waiters.append(continuation); return false
            }
            if now { continuation.resume() }
        }
    }
}

/// One write as the server plays it: prepare answers `prepared`, an upload makes it ready, and
/// a commit never answers, the way a commit still running looks from the Mac.
private final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var _prepared: String
    private var _paths: [String] = []
    private var _prepares: [String] = []
    let cancel: CancelAnswer
    let committing = Arrival()
    init(prepared: String = "receiving", cancel: CancelAnswer = .refused) { _prepared = prepared; self.cancel = cancel }
    var prepared: String {
        get { lock.withLock { _prepared } }
        set { lock.withLock { _prepared = newValue } }
    }
    func record(_ path: String) { lock.withLock { _paths.append(path) } }
    func record(prepare id: String) { lock.withLock { _prepares.append(id) } }
    /// The operation every prepare named, in order.
    var prepares: [String] { lock.withLock { _prepares } }
    /// The last segment of every request path, in order: `uploads`, `content`, `commit`, ...
    var calls: [String] { lock.withLock { _paths.map { String($0.split(separator: "/").last ?? "") } } }
}

private let digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

private final class WriteServer: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var script = Script()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private func reply(_ status: Int, _ body: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                              headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    private func result(_ id: String, _ state: String) -> String {
        let item = state != "completed" ? "null" : """
        {"path":"/hello.txt","name":"hello.txt","kind":"file","size":5,"modifiedAt":"1970-01-01T00:00:00.000Z",\
        "readable":true,"id":"44444444-4444-4444-8444-444444444444","parentId":"root",\
        "version":{"content":"\(digest)","metadata":"m"},\
        "capabilities":{"create":true,"update":true,"move":true,"trash":false,"restore":false}}
        """
        return "{\"operationId\":\"\(id)\",\"state\":\"\(state)\",\"item\":\(item),\"recoveryId\":null}"
    }
    private var operationId: String {
        let parts = (request.url?.path ?? "").split(separator: "/")
        if let index = parts.firstIndex(of: "operations"), index + 1 < parts.count { return String(parts[index + 1]) }
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var read = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                read.append(buffer, count: count)
            }
            body = read
        }
        return (body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["operationId"] as? String ?? ""
    }
    override func startLoading() {
        let script = Self.script, path = request.url?.path ?? "", id = operationId
        script.record(path)
        if path.hasSuffix("/uploads") { script.record(prepare: id); reply(200, result(id, script.prepared)) }
        else if path.hasSuffix("/content") { reply(200, result(id, "ready")) }
        else if path.hasSuffix("/commit") { script.committing.signal() }
        else if path.hasSuffix("/cancel") {
            switch script.cancel {
            case .refused: reply(409, "{\"error\":{\"message\":\"An active or uncertain commit cannot be discarded\"}}")
            case .unreachable: client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            case .confirmed: reply(200, result(id, "cancelled"))
            }
        } else { reply(200, result(id, "acknowledged")) }
    }
    override func stopLoading() {}
}

private struct Fixture {
    let writer: WriteCoordinator, file: URL, directory: URL, session: URLSession
    init(_ script: Script) throws {
        WriteServer.script = script
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Retry")
        file = directory.appendingPathComponent("hello.txt")
        try Data("hello".utf8).write(to: file)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WriteServer.self]
        session = URLSession(configuration: configuration)
        let client = try APIClient(server: URL(string: "https://drive.invalid")!, token: "fdd_test",
                                   session: session, protocolVersion: 2)
        writer = WriteCoordinator(catalog: catalog, client: client, maxUploadBytes: 1 << 20)
    }
    /// The same save each time, so a retry resumes the pending write instead of starting another.
    func save() async throws -> CatalogItem {
        try await writer.perform(route: "uploads", localId: nil, templateKey: "hello", parentId: "root", name: "hello.txt",
                                 base: nil, contents: file, progress: Progress(totalUnitCount: -1))
    }
    func outstanding() async throws -> [PendingWrite] {
        try await writer.catalog.pendingWrites().filter { $0.result == nil }
    }
    var recoveryCopies: [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: writer.catalog.recoveryDirectory.path)) ?? []
    }
    func recoveryContent(_ pending: PendingWrite) -> Data? {
        try? Data(contentsOf: writer.catalog.recoveryDirectory.appendingPathComponent(pending.id).appendingPathComponent("content"))
    }
    func close() { session.invalidateAndCancel(); try? FileManager.default.removeItem(at: directory) }
}

/// Serialized: every case drives the one stub.
@Suite(.serialized, .timeLimit(.minutes(1))) struct RetryTests {
    // A commit the server has begun runs to its end whatever the Mac does, and the server
    // refuses to cancel it. Only a cancel it confirms may cost this Mac its copy of the edit.
    @Test(arguments: [CancelAnswer.refused, .unreachable, .confirmed])
    func stoppingASaveDuringItsCommitKeepsThePendingCopyUnlessTheServerConfirmsTheCancel(_ answer: CancelAnswer) async throws {
        let script = Script(cancel: answer)
        let fixture = try Fixture(script); defer { fixture.close() }
        let task = Task { try await fixture.save() }
        await script.committing.wait()
        task.cancel()
        let outcome = await task.result
        #expect(throws: DriveError.cancelled) { try outcome.get() }
        #expect(script.calls == ["uploads", "content", "commit", "cancel"])
        let outstanding = try await fixture.outstanding()
        if answer == .confirmed {
            #expect(outstanding.isEmpty)
            #expect(fixture.recoveryCopies.isEmpty)
        } else {
            let kept = try #require(outstanding.first)
            #expect(outstanding.count == 1)
            #expect(kept.error == DriveError.cancelled.localizedDescription)
            #expect(fixture.recoveryContent(kept) == Data("hello".utf8))
        }
    }

    // The commit Finder stopped was published after all. The retry reads that from the server
    // and finishes the same write: no second upload, no second commit, no conflict copy.
    @Test func aSaveStoppedDuringItsCommitIsFinishedByTheNextResume() async throws {
        let script = Script(cancel: .refused)
        let fixture = try Fixture(script); defer { fixture.close() }
        let task = Task { try await fixture.save() }
        await script.committing.wait()
        task.cancel()
        _ = await task.result
        script.prepared = "completed"
        let item = try await fixture.save()
        #expect(item.entry.name == "hello.txt" && item.materialized)
        #expect(script.calls == ["uploads", "content", "commit", "cancel", "uploads", "acknowledge"])
        // The same operation, not a new one that would publish the edit a second time.
        #expect(script.prepares.count == 2 && Set(script.prepares).count == 1)
        #expect(try await fixture.outstanding().isEmpty)
        #expect(fixture.recoveryCopies.isEmpty)
    }

    // A commit still running, or stuck after a server crash, and one whose outcome the server
    // cannot tell: the Mac neither waits on it nor cancels it, and keeps its copy for later.
    @Test(arguments: ["committing", "uncertain"])
    func aRetryThatFindsTheCommitUnsettledKeepsThePendingCopy(_ state: String) async throws {
        let script = Script(prepared: state)
        let fixture = try Fixture(script); defer { fixture.close() }
        await #expect(throws: DriveError.writeUncertain) { _ = try await fixture.save() }
        #expect(script.calls == ["uploads"])
        let kept = try #require(try await fixture.outstanding().first)
        #expect(kept.error == DriveError.writeUncertain.localizedDescription)
        #expect(fixture.recoveryContent(kept) == Data("hello".utf8))
    }

    // Settled as cancelled by the server, on request or by its cleanup: it can never publish,
    // so nothing is left to retry or recover.
    @Test func aRetryThatFindsTheWriteCancelledForgetsIt() async throws {
        let script = Script(prepared: "cancelled")
        let fixture = try Fixture(script); defer { fixture.close() }
        await #expect(throws: DriveError.cancelled) { _ = try await fixture.save() }
        #expect(script.calls == ["uploads"])
        #expect(try await fixture.outstanding().isEmpty)
        #expect(fixture.recoveryCopies.isEmpty)
    }
}
