import Foundation

public protocol CatalogRefreshClient: Sendable {
    func list(_ path: String) async throws -> [RemoteEntry]
    func versions(_ paths: [String]) async throws -> [ContentVersion]
}
extension APIClient: CatalogRefreshClient {}

/// Reconcile independent snapshots even when another folder or file is unavailable.
/// Publish completed changes before reporting a failure to the app's backoff/status.
public func refreshCatalog(_ catalog: Catalog, client: some CatalogRefreshClient,
                           signalChanges: @Sendable () async throws -> Void) async throws {
    var failure: (any Error)?
    var unavailableFolders: [String] = []
    do {
        for folder in try await catalog.folders() {
            try Task.checkCancellation()
            do {
                let listing = try await catalog.beginListing(folder)
                let entries = try await client.list(folder)
                try Task.checkCancellation()
                try await catalog.reconcile(entries, folder: folder, listing: listing)
            } catch {
                try Task.checkCancellation()
                // A parent snapshot may already have removed this folder and its children.
                if (error as? DriveError) != .missing { failure = failure ?? error }
                unavailableFolders.append(folder)
            }
        }
        let cached = try await catalog.all().filter { item in
            item.materialized && item.entry.kind == "file" && !unavailableFolders.contains { folder in
                folder == "/" || item.entry.path.hasPrefix(folder + "/")
            }
        }
        let expected = Dictionary(uniqueKeysWithValues: cached.map { ($0.entry.path, $0.contentVersion) })
        let paths = cached.map { $0.entry.path }
        for start in stride(from: 0, to: paths.count, by: 16) {
            try Task.checkCancellation()
            let batch = Array(paths[start..<min(start + 16, paths.count)])
            do {
                let versions = try await client.versions(batch)
                try Task.checkCancellation()
                try await catalog.validate(versions, expecting: expected)
            } catch {
                try Task.checkCancellation()
                let itemFailure = (error as? DriveError) == .authentication || (error as? DriveError) == .missing
                if batch.count == 1 || !itemFailure { failure = failure ?? error; continue }
                // A batch response is all-or-nothing. Retry separately so a denied file
                // cannot prevent validation of readable files in the same batch.
                for path in batch {
                    try Task.checkCancellation()
                    do {
                        let versions = try await client.versions([path])
                        try Task.checkCancellation()
                        try await catalog.validate(versions, expecting: expected)
                    } catch {
                        try Task.checkCancellation()
                        failure = failure ?? error
                    }
                }
            }
        }
    } catch {
        try Task.checkCancellation()
        failure = failure ?? error
    }
    try Task.checkCancellation()
    try await signalChanges()
    if let failure { throw failure }
}
