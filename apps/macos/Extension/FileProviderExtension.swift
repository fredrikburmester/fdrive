import Foundation
import FdriveKit
@preconcurrency import FileProvider

final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension, @unchecked Sendable {
    let domain: NSFileProviderDomain
    init(domain: NSFileProviderDomain) { self.domain = domain; super.init() }
    func invalidate() {}
    private func connection() throws -> (Catalog, APIClient) {
        let store = try NativeEnvironment.store()
        guard let location = try store.load().first(where: { $0.id == domain.identifier.rawValue }) else { throw DriveError.authentication }
        return (try store.catalog(location), try store.client(location))
    }
    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        let (repository, client) = try connection()
        return ProviderEnumerator(repository: repository, client: client, container: containerItemIdentifier)
    }
    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest,
              completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let handler = Callback(completionHandler)
        let progress = Progress(totalUnitCount: 1)
        let task = Task {
            do {
                let (repository, _) = try connection()
                handler.value(ProviderItem(try await repository.item(NativeEnvironment.id(identifier))), nil)
                progress.completedUnitCount = 1
            } catch { handler.value(nil, NativeEnvironment.error(error)) }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }
    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?,
                       request: NSFileProviderRequest, completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let handler = Callback(completionHandler)
        let expectedContentVersion = requestedVersion?.contentVersion
        let progress = Progress(totalUnitCount: -1)
        let task = Task {
            var temporary: URL?
            do {
                let (repository, client) = try connection()
                let item = try await repository.item(NativeEnvironment.id(itemIdentifier))
                guard item.entry.kind == "file", item.entry.readable else { throw DriveError.unsupported }
                guard let manager = NSFileProviderManager(for: domain) else { throw DriveError.unavailable }
                let directory = try manager.temporaryDirectoryURL()
                try requireFreeSpace(item.entry.size, at: directory)
                let (url, digest, size) = try await client.download(item.entry.path, to: directory, progress: progress)
                temporary = url
                try Task.checkCancellation()
                if let expectedContentVersion, expectedContentVersion != Data(digest.utf8) {
                    throw NSFileProviderError(.versionNoLongerAvailable)
                }
                let record = try await repository.downloaded(item.id, hash: digest, size: size, expectedVersion: item.contentVersion)
                handler.value(url, ProviderItem(record), nil)
                temporary = nil // Ownership passes to File Provider only after success.
            } catch {
                if let temporary { try? FileManager.default.removeItem(at: temporary) }
                handler.value(nil, nil, NativeEnvironment.error(error))
            }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }
    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                    options: NSFileProviderCreateItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let handler = Callback(completionHandler)
        let parentId = NativeEnvironment.id(itemTemplate.parentItemIdentifier)
        let templateKey = itemTemplate.itemIdentifier.rawValue
        let name = itemTemplate.filename
        let modificationDate = itemTemplate.contentModificationDate ?? nil
        let directory = itemTemplate.contentType?.conforms(to: .directory) == true
        let reimport = options.contains(.mayAlreadyExist)
        let progress = Progress(totalUnitCount: -1)
        let task = Task {
            do {
                let (repository, client) = try connection()
                let coordinator = WriteCoordinator(catalog: repository, client: client)
                if reimport {
                    // Matching remote bytes or metadata are acknowledged without a second
                    // copy; differing bytes fall through to a create that keeps both.
                    if let existing = try await coordinator.reimport(parentId: parentId, name: name, directory: directory, contents: url) {
                        handler.value(ProviderItem(existing), [], url == nil && !directory, nil)
                        return
                    }
                    guard url != nil || directory else { throw DriveError.missing }
                }
                let result = try await coordinator.perform(
                    route: directory ? "folders" : "uploads", localId: nil, templateKey: templateKey,
                    parentId: parentId, name: name, base: nil, contents: url, progress: progress, modificationDate: modificationDate)
                await signalChanges(parents: [parentId])
                handler.value(ProviderItem(result), [], false, nil)
            } catch { handler.value(nil, [], false, NativeEnvironment.error(error)) }
        }
        progress.cancellationHandler = { task.cancel() }
        return progress
    }
    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields,
                    contents newContents: URL?, options: NSFileProviderModifyItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let remoteFields: NSFileProviderItemFields = [.contents, .filename, .parentItemIdentifier]
        if newContents != nil || !changedFields.intersection(remoteFields).isEmpty {
            let handler = Callback(completionHandler)
            let id = NativeEnvironment.id(item.itemIdentifier)
            let parentId = NativeEnvironment.id(item.parentItemIdentifier)
            let name = item.filename
            let modificationDate = item.contentModificationDate ?? nil
            let base = WriteVersion(content: String(decoding: version.contentVersion, as: UTF8.self),
                                    metadata: String(decoding: version.metadataVersion, as: UTF8.self))
            let hasContents = changedFields.contains(.contents)
            let keepBoth = !options.contains(.failOnConflict)
            let progress = Progress(totalUnitCount: -1)
            let task = Task {
                do {
                    let (repository, client) = try connection()
                    let previous = try await repository.item(id)
                    guard !hasContents || newContents != nil else { throw DriveError.unsupported }
                    let result = try await WriteCoordinator(catalog: repository, client: client).perform(
                        route: hasContents ? "uploads" : "moves", localId: id, templateKey: id,
                        parentId: parentId, name: name, base: base, contents: newContents, progress: progress, keepBoth: keepBoth, modificationDate: modificationDate)
                    await signalChanges(parents: [previous.parentId, parentId])
                    handler.value(ProviderItem(result), [], false, nil)
                } catch { handler.value(nil, [], false, NativeEnvironment.error(error)) }
            }
            progress.cancellationHandler = { task.cancel() }
            return progress
        }
        // Local Finder/editor bookkeeping (including TextEdit's Unlock chmod) never goes
        // to storage. Returning canonical metadata restores read-only permissions without
        // sending an unsupported metadata change through an endless retry loop.
        let handler = Callback(completionHandler)
        return self.item(for: item.itemIdentifier, request: request) { result, error in handler.value(result, [], false, error) }
    }
    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion,
                    options: NSFileProviderDeleteItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (Error?) -> Void) -> Progress {
        // Finder trashing uses modifyItem -> trashContainer. This callback means
        // permanent removal, including direct unlink requests from applications.
        // Rejection makes the system restore its local item instead of losing it.
        completionHandler(NSError(domain: NSFileProviderErrorDomain, code: NSFileProviderError.deletionRejected.rawValue,
                                  userInfo: [NSLocalizedDescriptionKey: "Permanent deletion is disabled. Use Move to Trash to retain a recoverable copy."]))
        return Progress(totalUnitCount: 0)
    }
    private func signalChanges(parents: [String]) async {
        guard let manager = NSFileProviderManager(for: domain) else { return }
        try? await manager.signalEnumerator(for: .workingSet)
        for parent in Set(parents) { try? await manager.signalEnumerator(for: NativeEnvironment.id(parent)) }
    }
    func materializedItemsDidChange(completionHandler: @escaping () -> Void) {
        guard let (repository, _) = try? connection(), let manager = NSFileProviderManager(for: domain) else {
            completionHandler(); return
        }
        let observer = MaterializedObserver(repository: repository, enumerator: manager.enumeratorForMaterializedItems(), completion: completionHandler)
        observer.start()
    }
}

private final class MaterializedObserver: NSObject, NSFileProviderEnumerationObserver, @unchecked Sendable {
    let repository: Catalog
    let enumerator: NSFileProviderEnumerator
    let completion: Callback<() -> Void>
    var identifiers = Set<String>()
    // Keep the observer alive until the final callback, including multi-page enumerations.
    var retained: MaterializedObserver?
    init(repository: Catalog, enumerator: NSFileProviderEnumerator, completion: @escaping () -> Void) {
        self.repository = repository; self.enumerator = enumerator; self.completion = Callback(completion)
    }
    func start() { retained = self; enumerator.enumerateItems(for: self, startingAt: NSFileProviderPage(Data())) }
    func didEnumerate(_ updatedItems: [NSFileProviderItem]) { identifiers.formUnion(updatedItems.map { NativeEnvironment.id($0.itemIdentifier) }) }
    func finishEnumerating(upTo nextPage: NSFileProviderPage?) {
        if let nextPage { enumerator.enumerateItems(for: self, startingAt: nextPage); return }
        let ids = identifiers
        Task { try? await repository.setMaterialized(ids); finish() }
    }
    func finishEnumeratingWithError(_ error: Error) { finish() }
    private func finish() { enumerator.invalidate(); completion.value(); retained = nil }
}
