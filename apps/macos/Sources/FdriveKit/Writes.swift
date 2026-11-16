import CryptoKit
import Darwin
import Foundation

/// File Provider owns retry scheduling. This coordinator owns immutable snapshots
/// and receipts so a callback replay never starts a second destructive operation.
public struct WriteCoordinator: Sendable {
    public let catalog: Catalog
    public let client: APIClient
    /// The largest file the server accepts, as its location advertised it. Protocol 2
    /// always does; without it the location does not write.
    public let maxUploadBytes: Int64?
    public init(catalog: Catalog, client: APIClient, maxUploadBytes: Int64?) {
        self.catalog = catalog; self.client = client; self.maxUploadBytes = maxUploadBytes
    }

    public func perform(route: String, localId: String?, templateKey: String, parentId: String,
                        name: String, base: WriteVersion?, contents: URL?, progress: Progress, keepBoth: Bool = true,
                        modificationDate: Date? = nil) async throws -> CatalogItem {
        guard client.protocolVersion == 2, let maxUploadBytes else { throw DriveError.permission }
        guard !name.isEmpty, name.utf8.count <= 255, ![".", ".."].contains(name), !name.contains("/"), !name.contains(":"),
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw DriveError.unsupported }
        // Finder sends back its own metadata version, which may tag a decrypted name.
        let base = base.map { WriteVersion(content: $0.content, metadata: CatalogItem.serverVersion($0.metadata)) }
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
        let target = try await target(previous: previous, parent: parent, name: name)
        let operationId = UUID().uuidString.lowercased()
        let directory = catalog.recoveryDirectory.appendingPathComponent(operationId)
        var retained = false
        defer { if !retained { try? FileManager.default.removeItem(at: directory) } }
        var digest: String?; var size: Int64?; var plainDigest: String?
        if route == "uploads" {
            guard let contents else { throw DriveError.unsupported }
            let kind = try contents.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard kind.isRegularFile == true, kind.isSymbolicLink != true, let sourceSize = kind.fileSize.map(Int64.init) else {
                throw DriveError.unsupported
            }
            // Inside an encrypted folder the recovery copy is the ciphertext: the server stages,
            // hashes and counts exactly what was encrypted here.
            let staged = target.key == nil ? sourceSize : Age.encryptedSize(sourceSize)
            guard staged <= maxUploadBytes else { throw DriveError.quota }
            try requireFreeSpace(staged, at: catalog.recoveryDirectory.deletingLastPathComponent())
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let payload = directory.appendingPathComponent("content")
            if let key = target.key {
                let sealed = try Age.encryptFile(contents, to: payload, recipient: key.recipient)
                guard sealed.ciphertext.size <= maxUploadBytes else { throw DriveError.quota }
                digest = sealed.ciphertext.sha256; size = sealed.ciphertext.size; plainDigest = sealed.plaintext.sha256
            } else {
                try FileManager.default.copyItem(at: contents, to: payload)
                let file = try FileHandle(forUpdating: payload)
                defer { try? file.close() }
                var sha = SHA256(); var bytes: Int64 = 0
                while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty {
                    try Task.checkCancellation(); bytes += Int64(data.count)
                    guard bytes <= maxUploadBytes else { throw DriveError.quota }
                    sha.update(data: data)
                }
                try file.synchronize()
                digest = sha.finalize().map { String(format: "%02x", $0) }.joined(); size = bytes
            }
            let descriptor = Darwin.open(directory.path, O_RDONLY)
            guard descriptor >= 0 else { throw DriveError.database("Could not persist recovery directory.") }
            defer { Darwin.close(descriptor) }
            guard fsync(descriptor) == 0 else { throw DriveError.database("Could not persist recovery directory.") }
        }
        // A replayed callback finds its write by what Finder asked for: the clear name and plaintext,
        // since an encrypted name and ciphertext differ on every attempt.
        let identity = [route, templateKey, parentId, name, base?.content ?? "", base?.metadata ?? "", plainDigest ?? digest ?? ""]
        let key = SHA256.hash(data: try JSONEncoder().encode(identity)).map { String(format: "%02x", $0) }.joined()
        let request = WriteRequest(operationId: operationId, itemId: previous?.entry.id, parentId: serverParent,
                                   name: target.name, base: base, size: size, sha256: digest)
        var candidate = PendingWrite(id: operationId, key: key, localId: localId ?? UUID().uuidString,
                                     route: route, request: request)
        candidate.keepBoth = keepBoth
        candidate.localModificationDate = modificationDate
        candidate.encryptedIn = target.folder
        candidate.clearName = target.clearName
        candidate.plainDigest = plainDigest
        let pending = try await catalog.beginWrite(candidate)
        retained = pending.id == operationId
        return try await resume(pending, progress: progress)
    }
    /// A reimport (`mayAlreadyExist`) acknowledges an existing remote item of the same
    /// name and kind when the local bytes match its verified content. Different bytes
    /// return nil so the caller creates normally and the server keeps both. Absence of
    /// bytes never means an empty-file replacement.
    public func reimport(parentId: String, name: String, directory: Bool, contents: URL?) async throws -> CatalogItem? {
        let listed = try await catalog.item(parentId)
        let listing = try await catalog.beginListing(listed.entry.path)
        try await catalog.reconcile(client.folderSnapshot(listed.entry.path), folder: listed.entry.path, listing: listing)
        let parent = try await catalog.item(parentId)
        let existing: CatalogItem
        if parent.encryptedIn != nil || parent.encryptedFolderId != nil {
            // Names inside are encrypted: the item is the one Finder shows under this name.
            guard let found = try await catalog.children(parent.id).first(where: { $0.displayName == name }) else { return nil }
            existing = found
        } else {
            let path = (parent.entry.path == "/" ? "" : parent.entry.path) + "/" + name
            do { existing = try await catalog.itemAt(path) } catch DriveError.missing { return nil }
        }
        guard (existing.entry.kind == "dir") == directory else { throw DriveError.unsupported }
        guard !directory, let contents else { return existing }
        let local = try streamingSHA256(contents)
        if let folderId = existing.encryptedIn { return try await reimportEncrypted(existing, folderId: folderId, local: local) }
        let verified = existing.contentVersion.count == 64 && existing.contentVersion.allSatisfy(\.isHexDigit)
        let remote = existing.materialized && verified
            ? existing.contentVersion
            : try await client.versions([existing.entry.path]).first?.version
        guard remote == local.digest else { return nil }
        return try await catalog.downloaded(existing.id, hash: local.digest, size: local.size, expectedVersion: existing.contentVersion)
    }

    /// Ciphertext is never comparable with the local bytes, so the decrypted contents are: their
    /// digest is known from this Mac's last download or upload of this version, or read by
    /// downloading and decrypting the file without keeping it. Anything that does not match,
    /// or does not decrypt, is kept as a second item.
    private func reimportEncrypted(_ existing: CatalogItem, folderId: String,
                                   local: (digest: String, size: Int64)) async throws -> CatalogItem? {
        guard existing.stray != true else { return nil }
        let verified = existing.contentVersion.count == 64 && existing.contentVersion.allSatisfy(\.isHexDigit)
        var plain = existing.materialized && verified ? existing.plainDigest : nil
        var version = verified ? existing.contentVersion : nil
        var size = existing.entry.size
        if plain == nil {
            let key = try await catalog.folderKey(folderId)
            let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("fdrive-reimport-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: scratch) }
            try requireFreeSpace(existing.entry.size, at: FileManager.default.temporaryDirectory)
            let (file, digest, downloaded) = try await client.download(existing.entry.path, to: scratch,
                                                                       progress: Progress(totalUnitCount: -1))
            guard let decrypted = try? Age.decryptFile(file, to: nil, identity: key.identity) else { return nil }
            plain = decrypted.sha256; version = digest; size = downloaded
        }
        guard plain == local.digest, let version else { return nil }
        return try await catalog.downloaded(existing.id, hash: version, size: size, expectedVersion: existing.contentVersion,
                                            plainDigest: local.digest)
    }

    /// Where a write lands relative to encrypted folders: the name the server gets, the folder
    /// whose key encrypts it, the clear name it stands for, and the key contents are encrypted to.
    private struct Target {
        var name: String
        var folder: String? = nil
        var clearName: String? = nil
        var key: FolderKey? = nil
    }
    static let edgeRefusal = "Items cannot move into or out of an encrypted folder in Finder. Copy the item instead, then move the original to Trash."
    static let restoreRefusal = "An item from an encrypted folder can only be put back inside that folder."
    static let strayRefusal = "This item's name does not decrypt, so FDrive keeps it read-only."

    /// Into Trash an item goes under the server's own name from anywhere. Anything else stays on
    /// its side of an encrypted folder's edge: the server cannot re-encrypt, so a move in or out
    /// (a restore included) is refused here before anything is recorded. Inside, a name that did
    /// not change keeps the server's encrypted one; a new one is checked against the names this
    /// Mac shows there, since the server cannot see duplicates, and encrypted.
    private func target(previous: CatalogItem?, parent: CatalogItem, name: String) async throws -> Target {
        if previous?.stray == true { throw DriveError.encryptedFolder(Self.strayRefusal) }
        let source = previous?.encryptedIn
        if parent.id == "trash" {
            guard let previous, let source else { return Target(name: name) }
            let clear = (try? await catalog.folderKey(source)).flatMap { EncryptedNames.decrypt(previous.entry.name, key: $0) }
            return Target(name: previous.entry.name, folder: source, clearName: clear ?? previous.clearName)
        }
        let destination = try await encryptedFolder(of: parent)
        if let previous, source != destination {
            throw DriveError.encryptedFolder(previous.parentId == "trash" ? Self.restoreRefusal : Self.edgeRefusal)
        }
        guard let destination else { return Target(name: name) }
        let key = try await catalog.folderKey(destination)
        if let previous, name == previous.displayName {
            return Target(name: previous.entry.name, folder: destination,
                          clearName: EncryptedNames.decrypt(previous.entry.name, key: key) ?? previous.clearName, key: key)
        }
        let clear: String
        do { clear = try EncryptedNames.check(name) } catch NameError.tooLong { throw DriveError.nameTooLong }
        func fold(_ name: String) -> String { name.precomposedStringWithCanonicalMapping.lowercased() }
        if try await catalog.children(parent.id).contains(where: { $0.id != previous?.id && fold($0.displayName) == fold(clear) }) {
            throw DriveError.nameCollision("An item named “\(clear)” is already in this encrypted folder. Choose another name.")
        }
        return Target(name: try sealName(clear, key: key), folder: destination, clearName: clear, key: key)
    }

    /// The encrypted folder `parent` is or is inside; nil outside one. One this Mac has not
    /// listed yet is listed first, since its listing carries its key.
    private func encryptedFolder(of parent: CatalogItem) async throws -> String? {
        if let id = parent.encryptedIn ?? parent.encryptedFolderId { return id }
        guard parent.entry.encrypted == true else { return nil }
        let listing = try await catalog.beginListing(parent.entry.path)
        try await catalog.reconcile(client.folderSnapshot(parent.entry.path), folder: parent.entry.path, listing: listing)
        guard let id = try await catalog.item(parent.id).encryptedFolderId else { throw DriveError.unavailable }
        return id
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
            // Settled by the server, on request or by its cleanup: it can never publish.
            case "cancelled": throw DriveError.cancelled
            // A commit still running or stalled by a server crash, or one whose outcome
            // is unknown. The record stays, and the next resume asks again.
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
                    try await catalog.reconcile(client.folderSnapshot(folder), folder: folder, listing: listing)
                } catch { /* The next normal refresh can finish discovery; the save is already durable. */ }
            }
            // The durable catalog commit precedes both the callback and spool cleanup.
            // Failure to acknowledge only retains an extra recovery copy.
            try? await client.acknowledgeWrite(pending.request.operationId)
            for abandoned in pending.abandonedOperations ?? [] { _ = try? await client.cancelWrite(abandoned) }
            try? FileManager.default.removeItem(at: catalog.recoveryDirectory.appendingPathComponent(pending.id))
            progress.completedUnitCount = progress.totalUnitCount
            return result
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { try await stopped(pending) }
            let collision: Bool
            switch error {
            case DriveError.cancelled:
                await forget(pending)
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

    /// Finder stopped this write. A commit the server has begun runs to its end
    /// regardless, so the server decides what happened: only its `cancelled` answer
    /// drops the record and this Mac's copy. A refusal (it is committing, or has
    /// committed) or no answer keeps both for the next resume, which reads the
    /// outcome. Detached, so the cancellation being handled does not cancel the ask.
    private func stopped(_ pending: PendingWrite) async throws -> Never {
        let id = pending.request.operationId
        let answer = await Task.detached { [client] in try? await client.cancelWrite(id) }.value
        if answer?.state == "cancelled" {
            await forget(pending)
        } else {
            try? await catalog.writeFailed(pending, error: DriveError.cancelled.localizedDescription)
        }
        throw DriveError.cancelled
    }

    /// Drops a write the server settled as cancelled, with this Mac's copy of it.
    private func forget(_ pending: PendingWrite) async {
        try? await catalog.writeCancelled(pending)
        try? FileManager.default.removeItem(at: catalog.recoveryDirectory.appendingPathComponent(pending.id))
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
