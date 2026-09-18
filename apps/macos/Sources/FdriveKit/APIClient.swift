import CryptoKit
import Foundation

private final class TransferDelegate: NSObject, URLSessionTaskDelegate, URLSessionDownloadDelegate, @unchecked Sendable {
    let progress: Progress?
    init(progress: Progress? = nil) { self.progress = progress }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Credentials and pairing secrets never follow even same-host protocol redirects.
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        progress?.totalUnitCount = totalBytesExpectedToWrite
        progress?.completedUnitCount = totalBytesWritten
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        progress?.totalUnitCount = totalBytesExpectedToSend
        progress?.completedUnitCount = totalBytesSent
    }
}

public struct APIClient: Sendable {
    public let server: URL
    public let protocolVersion: Int
    private let token: String?
    private let session: URLSession
    /// How long a commit may go without a byte from the server before it is abandoned.
    ///
    /// The session's own sixty seconds fits metadata calls, which answer at once. A
    /// commit does not: the server replies only once the write is published, and on
    /// storage without a rename publishing a folder copies every object under it.
    /// That runs for as long as the folder is large, and sends nothing meanwhile, so
    /// sixty seconds of silence is the normal case rather than a failure. Hold the
    /// connection to the session's resource limit instead and let the two things that
    /// can actually judge the move end it early: the progress poll, which says whether
    /// the server is still working, and Finder's cancel.
    static let commitTimeout: TimeInterval = 86_400
    public init(server: URL, token: String? = nil, session: URLSession? = nil, protocolVersion: Int = 1) throws {
        self.server = try Self.normalizeServer(server)
        self.token = token
        self.protocolVersion = protocolVersion
        if let session { self.session = session } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.urlCache = nil
            configuration.timeoutIntervalForRequest = 60
            configuration.timeoutIntervalForResource = 86_400
            configuration.httpMaximumConnectionsPerHost = 4
            self.session = URLSession(configuration: configuration)
        }
    }
    public static func normalizeServer(_ url: URL) throws -> URL {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
        else { throw DriveError.invalidServer }
        parts.host = host; parts.path = ""
        guard let normalized = parts.url else { throw DriveError.invalidServer }
        return normalized
    }
    private func request(_ route: String, query: [URLQueryItem] = [], body: Data? = nil,
                         timeout: TimeInterval? = nil) throws -> URLRequest {
        var url = URLComponents(url: server.appendingPathComponent("api/v\(protocolVersion)/desktop/" + route), resolvingAgainstBaseURL: false)!
        url.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: url.url!)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("fdrive", forHTTPHeaderField: "X-Requested-With")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        // A request that sets this wins over the session's `timeoutIntervalForRequest`.
        if let timeout { request.timeoutInterval = timeout }
        return request
    }
    private func check(_ response: URLResponse, data: Data? = nil, writing: Bool = false) throws {
        guard let response = response as? HTTPURLResponse else { throw DriveError.unavailable }
        let error = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["error"] as? [String: Any]
        let message = error?["message"] as? String
        if writing, let details = error?["details"] as? [String: Any], let code = details["code"] as? String {
            switch code {
            case "version_conflict": throw DriveError.writeConflict(message ?? "This item changed remotely. Your pending copy is preserved.")
            case "name_collision": throw DriveError.nameCollision(message ?? "An item with this name already exists. Your pending copy is preserved.")
            case "operation_uncertain": throw DriveError.writeUncertain
            case "operation_cancelled": throw DriveError.cancelled
            case "quota_exceeded": throw DriveError.quota
            case "unsupported", "permission_denied": throw DriveError.permission
            default: break
            }
        }
        switch response.statusCode {
        case 200..<300: return
        case 401: throw DriveError.authentication
        // A denied path is not an expired login; reconnecting cannot repair it.
        case 403: throw writing ? DriveError.permission : DriveError.forbidden
        case 404: throw DriveError.missing
        // Storage locks and other unclassified write refusals are conflicts, not stale listings.
        case 409 where writing: throw DriveError.writeConflict(message ?? "This item changed remotely. Your pending copy is preserved in Recovery.")
        case 409: throw DriveError.expiredSnapshot
        case 413 where writing: throw DriveError.quota
        case 429, 500...599: throw DriveError.unavailable
        default: throw DriveError.server("The server rejected this request (\(response.statusCode)).")
        }
    }
    private func send<T: Decodable & Sendable>(_ route: String, query: [URLQueryItem] = [], body: Data? = nil,
                                              writing: Bool = false, timeout: TimeInterval? = nil) async throws -> T {
        let (data, response) = try await session.data(for: request(route, query: query, body: body, timeout: timeout),
                                                      delegate: TransferDelegate())
        try check(response, data: data, writing: writing)
        guard data.count <= 8 * 1024 * 1024 else { throw DriveError.server("The metadata response is too large.") }
        return try JSONDecoder().decode(T.self, from: data)
    }
    public func pair(deviceName: String) async throws -> Pairing {
        try await send("pairings", body: JSONEncoder().encode(["deviceName": deviceName]))
    }
    public func poll(_ pairing: Pairing) async throws -> PairResult {
        try await send("pairings/\(pairing.id)/poll", body: JSONEncoder().encode(["secret": pairing.secret]))
    }
    public func cancel(_ pairing: Pairing) async throws {
        struct Result: Decodable, Sendable { let ok: Bool }
        let _: Result = try await send("pairings/\(pairing.id)/cancel", body: JSONEncoder().encode(["secret": pairing.secret]))
    }
    /// Tell the server the issued bundle is stored; unconfirmed bundles are revoked at expiry.
    public func confirm(_ pairing: Pairing) async throws {
        struct Result: Decodable, Sendable { let ok: Bool }
        let _: Result = try await send("pairings/\(pairing.id)/confirm", body: JSONEncoder().encode(["secret": pairing.secret]))
    }
    public func location() async throws -> Location {
        let result: Location = try await send("location")
        guard (result.protocolVersion == 1 && result.readOnly) || (result.protocolVersion == 2 && result.capabilities != nil) else { throw DriveError.server("Update fdrive for Mac to connect to this server.") }
        return result
    }
    public func list(_ rawPath: String) async throws -> [RemoteEntry] {
        let path = try canonicalPath(rawPath)
        var result: [RemoteEntry] = []
        var cursor: String?
        var seen = Set<String>()
        repeat {
            try Task.checkCancellation()
            var query = [URLQueryItem(name: "path", value: path)]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            let page: Listing = try await send("entries", query: query)
            for entry in page.entries {
                guard try canonicalPath(entry.path) == entry.path, parentPath(entry.path) == path,
                      entry.hasValidListingName,
                      seen.insert(entry.path).inserted, entry.size >= 0 else { throw DriveError.server("Invalid folder listing.") }
            }
            result += page.entries
            guard result.count <= 100_000 else { throw DriveError.server("Folder exceeds the listing limit.") }
            if page.nextCursor != nil && (page.entries.isEmpty || page.nextCursor == cursor) {
                throw DriveError.server("The server returned an invalid continuation.")
            }
            cursor = page.nextCursor
        } while cursor != nil
        return result
    }
    public func stat(_ path: String) async throws -> RemoteEntry {
        try await send("entry", query: [.init(name: "path", value: try canonicalPath(path))])
    }
    public func versions(_ paths: [String]) async throws -> [ContentVersion] {
        let result: Versions = try await send("versions", body: JSONEncoder().encode(["paths": paths]))
        guard result.items.count == paths.count, Set(result.items.map(\.path)) == Set(paths),
              result.items.allSatisfy({ $0.version.count == 64 && $0.version.allSatisfy(\.isHexDigit) }) else {
            throw DriveError.server("Invalid content validation response.")
        }
        return result.items
    }
    public func disconnect() async throws {
        struct Result: Decodable, Sendable { let ok: Bool }
        let _: Result = try await send("disconnect", body: Data("{}".utf8))
    }
    public func prepareWrite(_ operation: WriteRequest, route: String) async throws -> WriteResult {
        guard protocolVersion == 2 else { throw DriveError.permission }
        return try await send(route, body: operation.body(route: route), writing: true)
    }
    public func uploadWrite(_ id: String, file: URL, progress: Progress) async throws -> WriteResult {
        var upload = try request("operations/\(id)/content")
        upload.httpMethod = "PUT"; upload.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.upload(for: upload, fromFile: file, delegate: TransferDelegate(progress: progress))
        try check(response, data: data, writing: true)
        return try JSONDecoder().decode(WriteResult.self, from: data)
    }
    public func commitWrite(_ id: String) async throws -> WriteResult {
        try await send("operations/\(id)/commit", body: Data("{}".utf8), writing: true, timeout: Self.commitTimeout)
    }
    public func writeStatus(_ id: String) async throws -> WriteResult {
        try await send("operations/\(id)")
    }
    public func acknowledgeWrite(_ id: String) async throws {
        let _: WriteResult = try await send("operations/\(id)/acknowledge", body: Data("{}".utf8), writing: true)
    }
    public func cancelWrite(_ id: String) async throws {
        let _: WriteResult = try await send("operations/\(id)/cancel", body: Data("{}".utf8), writing: true)
    }
    public func download(_ path: String, to directory: URL, progress: Progress) async throws -> (URL, String, Int64) {
        let delegate = TransferDelegate(progress: progress)
        let (temporary, response) = try await session.download(for: request("content", query: [.init(name: "path", value: try canonicalPath(path))]), delegate: delegate)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try check(response)
        let file = try FileHandle(forReadingFrom: temporary)
        defer { try? file.close() }
        var digest = SHA256(); var size: Int64 = 0
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            try Task.checkCancellation(); digest.update(data: chunk); size += Int64(chunk.count)
        }
        if response.expectedContentLength >= 0 && response.expectedContentLength != size {
            throw DriveError.server("The download ended before the file was complete.")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: temporary, to: destination)
        let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
        return (destination, hash, size)
    }
}
