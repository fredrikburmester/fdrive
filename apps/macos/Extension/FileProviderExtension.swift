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
    // Cocoa permission errors are treated as transient by File Provider and retried
    // indefinitely. cannotSynchronize is a persistent, visible rejection of a write.
    private var writeDenied: NSError { NSError(domain: NSFileProviderErrorDomain, code: NSFileProviderError.cannotSynchronize.rawValue,
                                              userInfo: [NSLocalizedDescriptionKey: "This fdrive location is read-only. Save a copy outside it."]) }
    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?,
                    options: NSFileProviderCreateItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, writeDenied); return Progress(totalUnitCount: 0)
    }
    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields,
                    contents newContents: URL?, options: NSFileProviderModifyItemOptions, request: NSFileProviderRequest,
                    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let remoteFields: NSFileProviderItemFields = [.contents, .filename, .parentItemIdentifier]
        guard newContents == nil, changedFields.intersection(remoteFields).isEmpty else {
            completionHandler(nil, [], false, writeDenied); return Progress(totalUnitCount: 0)
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
        completionHandler(writeDenied); return Progress(totalUnitCount: 0)
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
