import CryptoKit
import Darwin
import Foundation

/// File Provider owns retry scheduling. This coordinator owns immutable snapshots
/// and receipts so a callback replay never starts a second destructive operation.
public struct WriteCoordinator: Sendable {
    public let catalog: Catalog
    public let client: APIClient
    public init(catalog: Catalog, client: APIClient) { self.catalog = catalog; self.client = client }

    public func perform(route: String, localId: String?, templateKey: String, parentId: String,
                        name: String, base: WriteVersion?, contents: URL?, progress: Progress, keepBoth: Bool = true,
                        modificationDate: Date? = nil) async throws -> CatalogItem {
        guard client.protocolVersion == 2 else { throw DriveError.permission }
        guard !name.isEmpty, name.utf8.count <= 255, ![".", ".."].contains(name), !name.contains("/"), !name.contains(":"),
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw DriveError.unsupported }
        let parent = try await catalog.item(parentId)
        let previous = try await localId.mapAsync { try await catalog.item($0) }
        guard let serverParent = parent.id == "root" ? "root" : parent.entry.id,
              localId == nil || previous?.entry.id != nil else { throw DriveError.unavailable }
        let operationId = UUID().uuidString.lowercased()
        let directory = catalog.recoveryDirectory.appendingPathComponent(operationId)
        var retained = false
        defer { if !retained { try? FileManager.default.removeItem(at: directory) } }
        var digest: String?; var size: Int64?
        if route == "uploads" {
            guard let contents else { throw DriveError.unsupported }
            let kind = try contents.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard kind.isRegularFile == true, kind.isSymbolicLink != true else { throw DriveError.unsupported }
            guard let sourceSize = kind.fileSize, sourceSize <= 16 * 1024 * 1024 * 1024 else { throw DriveError.quota }
            let volume = try FileManager.default.attributesOfFileSystem(forPath: catalog.recoveryDirectory.deletingLastPathComponent().path)
            guard let available = volume[.systemFreeSize] as? NSNumber,
                  available.int64Value >= Int64(sourceSize) + 512 * 1024 * 1024 else { throw DriveError.quota }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let payload = directory.appendingPathComponent("content")
            try FileManager.default.copyItem(at: contents, to: payload)
            let file = try FileHandle(forUpdating: payload)
            defer { try? file.close() }
            var sha = SHA256(); var bytes: Int64 = 0
            while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty {
                try Task.checkCancellation(); bytes += Int64(data.count)
                guard bytes <= 16 * 1024 * 1024 * 1024 else { throw DriveError.quota }
                sha.update(data: data)
            }
            try file.synchronize()
            let descriptor = Darwin.open(directory.path, O_RDONLY)
            guard descriptor >= 0 else { throw DriveError.database("Could not persist recovery directory.") }
            defer { Darwin.close(descriptor) }
            guard fsync(descriptor) == 0 else { throw DriveError.database("Could not persist recovery directory.") }
            digest = sha.finalize().map { String(format: "%02x", $0) }.joined(); size = bytes
        }
        let identity = [route, templateKey, parentId, name, base?.content ?? "", base?.metadata ?? "", digest ?? ""]
        let key = SHA256.hash(data: try JSONEncoder().encode(identity)).map { String(format: "%02x", $0) }.joined()
        let request = WriteRequest(operationId: operationId, itemId: previous?.entry.id, parentId: serverParent,
                                   name: name, base: base, size: size, sha256: digest)
        var candidate = PendingWrite(id: operationId, key: key, localId: localId ?? UUID().uuidString,
                                     route: route, request: request)
        candidate.keepBoth = keepBoth
        candidate.localModificationDate = modificationDate
        let pending = try await catalog.beginWrite(candidate)
        retained = pending.id == operationId
        return try await resume(pending, progress: progress)
    }
    public func resume(_ pending: PendingWrite, progress: Progress = Progress(totalUnitCount: -1)) async throws -> CatalogItem {
        if let result = pending.result { return result }
        do {
            var remote = try await client.prepareWrite(pending.request, route: pending.route)
            if remote.state == "receiving" || remote.state == "uploading" {
                let payload = catalog.recoveryDirectory.appendingPathComponent(pending.id).appendingPathComponent("content")
                guard FileManager.default.fileExists(atPath: payload.path) else { throw DriveError.server("Pending upload contents are missing. The operation was not retried.") }
                remote = try await client.uploadWrite(pending.request.operationId, file: payload, progress: progress)
            }
            try Task.checkCancellation()
            if remote.state == "ready" { remote = try await client.commitWrite(pending.request.operationId) }
            switch remote.state {
            case "completed", "acknowledged": break
            case "conflict": throw DriveError.writeConflict("This item changed remotely. Your pending copy is preserved in Recovery.")
            case "committing", "uncertain": throw DriveError.writeUncertain
            default: throw DriveError.unavailable
            }
            guard remote.operationId == pending.request.operationId, let entry = remote.item else { throw DriveError.writeUncertain }
            let result = try await catalog.finishWrite(pending, entry: entry)
            if pending.supersededOperation != nil {
                // The local item now represents the conflict copy. Discover the
                // preserved remote original immediately, even if periodic refresh
                // is backing off after the outage that caused this conflict.
                let folder = parentPath(entry.path)
                do {
                    let listing = try await catalog.beginListing(folder)
                    try await catalog.reconcile(client.list(folder), folder: folder, listing: listing)
                } catch { /* The next normal refresh can finish discovery; the save is already durable. */ }
            }
            // The durable catalog commit precedes both the callback and spool cleanup.
            // Failure to acknowledge only retains an extra recovery copy.
            try? await client.acknowledgeWrite(pending.request.operationId)
            if let superseded = pending.supersededOperation { try? await client.cancelWrite(superseded) }
            try? FileManager.default.removeItem(at: catalog.recoveryDirectory.appendingPathComponent(pending.id))
            progress.completedUnitCount = progress.totalUnitCount
            return result
        } catch {
            if case DriveError.writeConflict = error, pending.route == "uploads", pending.keepBoth != false, pending.supersededOperation == nil {
                return try await resume(catalog.conflictCopy(pending), progress: progress)
            }
            try? await catalog.writeFailed(pending, error: error.localizedDescription)
            throw error
        }
    }
}

private extension Optional where Wrapped: Sendable {
    func mapAsync<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        guard let value = self else { return nil }
        return try await transform(value)
    }
}
