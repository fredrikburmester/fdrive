import CryptoKit
import Darwin
import Foundation

/// File Provider owns retry scheduling. This coordinator owns immutable snapshots
/// and receipts so a callback replay never starts a second destructive operation.
public struct WriteCoordinator: Sendable {
    public let catalog: Catalog
    public let client: APIClient
    /// How often a running commit is asked how far it has got.
    public let progressPoll: Duration
    public init(catalog: Catalog, client: APIClient, progressPoll: Duration = .seconds(1)) {
        self.catalog = catalog; self.client = client; self.progressPoll = progressPoll
    }

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
        if route == "moves", let localId {
            // Refuse a cycle natively; the server rejects it again at commit.
            var ancestor = parentId, depth = 0
            while ancestor != "root", ancestor != "trash", depth < 4096 {
                guard ancestor != localId else { throw DriveError.unsupported }
                ancestor = try await catalog.item(ancestor).parentId; depth += 1
            }
        }
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
            try requireFreeSpace(Int64(sourceSize), at: catalog.recoveryDirectory.deletingLastPathComponent())
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
    /// A reimport (`mayAlreadyExist`) acknowledges an existing remote item of the same
    /// name and kind when the local bytes match its verified content. Different bytes
    /// return nil so the caller creates normally and the server keeps both. Absence of
    /// bytes never means an empty-file replacement.
    public func reimport(parentId: String, name: String, directory: Bool, contents: URL?) async throws -> CatalogItem? {
        let parent = try await catalog.item(parentId)
        let listing = try await catalog.beginListing(parent.entry.path)
        try await catalog.reconcile(client.list(parent.entry.path), folder: parent.entry.path, listing: listing)
        let path = (parent.entry.path == "/" ? "" : parent.entry.path) + "/" + name
        let existing: CatalogItem
        do { existing = try await catalog.itemAt(path) } catch DriveError.missing { return nil }
        guard (existing.entry.kind == "dir") == directory else { throw DriveError.unsupported }
        guard !directory, let contents else { return existing }
        let local = try streamingSHA256(contents)
        let verified = existing.contentVersion.count == 64 && existing.contentVersion.allSatisfy(\.isHexDigit)
        let remote = existing.materialized && verified
            ? existing.contentVersion
            : try await client.versions([path]).first?.version
        guard remote == local.digest else { return nil }
        return try await catalog.downloaded(existing.id, hash: local.digest, size: local.size, expectedVersion: existing.contentVersion)
    }
    /// Commits, following the server's own account of how far it has got.
    ///
    /// Publishing is usually a rename and returns at once. On storage without one
    /// — object storage — publishing a folder copies every object under it and can
    /// run for minutes, and the server records its progress while it does. Follow
    /// that so Finder shows a proportion instead of an indeterminate bar for the
    /// whole copy. It is advisory: a commit that returns before the first poll
    /// never asks, and a poll that fails or finds nothing recorded leaves the bar
    /// as it was rather than disturbing the write.
    private func commit(_ id: String, progress: Progress) async throws -> WriteResult {
        let watcher = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: progressPoll)
                guard !Task.isCancelled, let reported = try? await client.writeStatus(id).progress,
                      reported.total > 0 else { continue }
                progress.totalUnitCount = reported.total
                progress.completedUnitCount = min(reported.completed, reported.total)
            }
        }
        defer { watcher.cancel() }
        do { return try await client.commitWrite(id) } catch { try await stopped(id, error) }
    }

    /// Rethrows anything that is not this side being asked to stop; ends the work if it is.
    ///
    /// Dropping the request only stops this side of it. Tell the server, or it finishes
    /// a copy nobody is waiting for and leaves what it had written behind. Detached, so
    /// cancelling this task does not cancel the one message that ends the work.
    private func stopped(_ id: String, _ error: Error) async throws -> Never {
        guard error is CancellationError || (error as? URLError)?.code == .cancelled
        else { throw error }
        await Task.detached { [client] in try? await client.cancelWrite(id) }.value
        throw DriveError.cancelled
    }

    /// Follows a commit this call did not start, until the server settles it.
    ///
    /// File Provider retries a modification it decides has taken too long, and on
    /// storage without a rename publishing a folder copies every object under it, so
    /// a large move outlasts that patience easily. The retry then finds the operation
    /// still `committing`. That is not an unknown outcome — it is one that has not
    /// arrived yet, and the server is still reporting how far it has got. Wait for it,
    /// driving the same bar, rather than telling someone their save could not be
    /// confirmed while it is in fact still running.
    ///
    /// A status that cannot be read ends the wait rather than hiding a dead server:
    /// File Provider retries again, and the retry re-attaches here.
    private func follow(_ id: String, progress: Progress) async throws -> WriteResult {
        while true {
            do {
                let current = try await client.writeStatus(id)
                if let reported = current.progress, reported.total > 0 {
                    progress.totalUnitCount = reported.total
                    progress.completedUnitCount = min(reported.completed, reported.total)
                }
                guard current.state == "committing" else { return current }
                try await Task.sleep(for: progressPoll)
            } catch { try await stopped(id, error) }
        }
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
            if remote.state == "ready" {
                remote = try await commit(pending.request.operationId, progress: progress)
            } else if remote.state == "committing" {
                remote = try await follow(pending.request.operationId, progress: progress)
            }
            switch remote.state {
            case "completed", "acknowledged": break
            case "conflict": throw DriveError.writeConflict("This item changed remotely. Your pending copy is preserved in Recovery.")
            // Asked for and already settled, by this device or another: finished, not failed.
            case "cancelled": throw DriveError.cancelled
            // `committing` only survives `follow` when the wait itself could not settle it.
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
            for abandoned in pending.abandonedOperations ?? [] { try? await client.cancelWrite(abandoned) }
            try? FileManager.default.removeItem(at: catalog.recoveryDirectory.appendingPathComponent(pending.id))
            progress.completedUnitCount = progress.totalUnitCount
            return result
        } catch {
            let collision: Bool
            switch error {
            case DriveError.cancelled:
                // Asked for, and the server has taken back what it copied. Finished
                // rather than pending: leaving it would offer to retry what the
                // person deliberately stopped.
                try? await catalog.writeCancelled(pending)
                try? FileManager.default.removeItem(
                    at: catalog.recoveryDirectory.appendingPathComponent(pending.id))
                throw error
            case DriveError.writeConflict: collision = false
            case DriveError.nameCollision: collision = true
            default:
                try? await catalog.writeFailed(pending, error: error.localizedDescription)
                throw error
            }
            if pending.route == "uploads", pending.keepBoth != false {
                // A remote change or taken name keeps the editor's bytes under a new name.
                // A conflict name that is itself taken gets a numbered retry, bounded.
                if pending.supersededOperation == nil, let copy = try await catalog.conflictCopy(pending) {
                    return try await resume(copy, progress: progress)
                }
                if collision, let copy = try await catalog.conflictCopy(pending, retry: true) {
                    return try await resume(copy, progress: progress)
                }
            }
            try? await catalog.writeFailed(pending, error: error.localizedDescription)
            throw error
        }
    }
}

private func streamingSHA256(_ url: URL) throws -> (digest: String, size: Int64) {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var sha = SHA256(); var size: Int64 = 0
    while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty {
        try Task.checkCancellation(); size += Int64(data.count); sha.update(data: data)
    }
    return (sha.finalize().map { String(format: "%02x", $0) }.joined(), size)
}

private extension Optional where Wrapped: Sendable {
    func mapAsync<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        guard let value = self else { return nil }
        return try await transform(value)
    }
}
