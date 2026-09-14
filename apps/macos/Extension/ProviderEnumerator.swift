import Foundation
import FdriveKit
@preconcurrency import FileProvider

final class ProviderEnumerator: NSObject, NSFileProviderEnumerator, @unchecked Sendable {
    let repository: Catalog
    let client: APIClient
    let container: NSFileProviderItemIdentifier
    private let lock = NSLock()
    private var tasks: [Task<Void, Never>] = []
    init(repository: Catalog, client: APIClient, container: NSFileProviderItemIdentifier) {
        self.repository = repository; self.client = client; self.container = container
    }
    private func add(_ task: Task<Void, Never>) { lock.withLock { tasks.append(task) } }
    func invalidate() { lock.withLock { tasks.forEach { $0.cancel() }; tasks.removeAll() } }
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        let observer = Callback(observer)
        add(Task {
            do {
                let items: [CatalogItem]
                if container == .workingSet {
                    items = try await repository.all()
                } else {
                    let folder = try await repository.item(NativeEnvironment.id(container))
                    do {
                        let listing = try await repository.beginListing(folder.entry.path)
                        let entries = try await client.list(folder.entry.path)
                        try Task.checkCancellation()
                        try await repository.reconcile(entries, folder: folder.entry.path, listing: listing)
                    } catch {
                        // Offline browsing uses an explicit existing snapshot only. Permission,
                        // malformed-listing and missing-item failures are never hidden as offline.
                        let offline = error is URLError || (error as? DriveError) == .unavailable
                        guard offline, try await repository.hasListing(folder.entry.path) else { throw error }
                    }
                    items = try await repository.children(folder.id)
                }
                try Task.checkCancellation()
                // The HTTP client already pages into one consistent snapshot. Emit bounded batches
                // in this enumeration rather than handing the OS an unstable path-based offset.
                for offset in stride(from: 0, to: items.count, by: 500) {
                    observer.value.didEnumerate(items[offset..<min(offset + 500, items.count)].map(ProviderItem.init))
                }
                try? await repository.recordCallback()
                observer.value.finishEnumerating(upTo: nil)
            } catch {
                try? await repository.recordCallback(error: error.localizedDescription)
                observer.value.finishEnumeratingWithError(NativeEnvironment.error(error))
            }
        })
    }
    private func anchor(_ revision: Int64) async throws -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data("\(try await repository.generation()):\(revision)".utf8))
    }
    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        let handler = Callback(completionHandler)
        add(Task { handler.value(try? await anchor(repository.revision())) })
    }
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        let observer = Callback(observer)
        add(Task {
            do {
                let parts = String(data: anchor.rawValue, encoding: .utf8)?.split(separator: ":") ?? []
                guard parts.count == 2, parts[0] == (try await repository.generation()), let revision = Int64(parts[1]) else {
                    throw DriveError.expiredSnapshot
                }
                let changes = try await repository.changes(since: revision, parent: container == .workingSet ? nil : NativeEnvironment.id(container))
                try Task.checkCancellation()
                observer.value.didUpdate(changes.items.map(ProviderItem.init))
                observer.value.didDeleteItems(withIdentifiers: changes.deleted.map(NativeEnvironment.id))
                try? await repository.recordCallback()
                observer.value.finishEnumeratingChanges(upTo: try await self.anchor(changes.anchor), moreComing: false)
            } catch {
                try? await repository.recordCallback(error: error.localizedDescription)
                observer.value.finishEnumeratingWithError(NativeEnvironment.error(error))
            }
        })
    }
}
