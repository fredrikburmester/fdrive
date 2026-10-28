import Foundation

public protocol LocationMetadataClient: Sendable {
    func location() async throws -> Location
}
extension APIClient: LocationMetadataClient {}

/// Keep the last saved metadata on network/framework failure. Repeating the same-ID
/// domain update repairs a previous update interrupted before the configuration was saved.
public func refreshLocationMetadata(
    _ saved: SavedLocation,
    client: some LocationMetadataClient,
    isolation: isolated (any Actor)? = #isolation,
    updateDomain: (SavedLocation) async throws -> Void
) async throws -> SavedLocation {
    let updated = try saved.updatingMetadata(from: await client.location())
    try Task.checkCancellation()
    if updated.title != saved.title {
        try await updateDomain(updated)
        try Task.checkCancellation()
    }
    return updated
}

/// The next automatic refresh waits four times as long as this one took, and at least a fifth
/// of a second per browsed folder, at most 15 minutes. Every refresh still reads each browsed
/// folder on the server, checked or listed: a location with thousands of them would otherwise
/// keep its storage busy most of the time. Small ones stay due every minute.
public func nextAutomaticRefresh(finished: Date, took duration: TimeInterval, folders: Int = 0) -> Date {
    finished.addingTimeInterval(min(max(max(0, duration) * 4, Double(folders) * 0.2), 900))
}

public protocol CatalogRefreshClient: Sendable {
    func list(_ path: String) async throws -> [RemoteEntry]
    func snapshot(_ path: String) async throws -> (entries: [RemoteEntry], token: String?)
    func checks(_ folders: [FolderCheck]) async throws -> [FolderStatus]
    func versions(_ paths: [String]) async throws -> [ContentVersion]
}
public extension CatalogRefreshClient {
    func snapshot(_ path: String) async throws -> (entries: [RemoteEntry], token: String?) { (try await list(path), nil) }
    func checks(_ folders: [FolderCheck]) async throws -> [FolderStatus] { throw DriveError.missing }
}
extension APIClient: CatalogRefreshClient {}

/// Folders checks cannot vouch for are listed: those without a token from a complete listing,
/// and Trash, whose entries the server derives from other folders.
private func uncheckable(_ folder: String, token: String?) -> Bool {
    token == nil || folder == RemoteEntry.trashPath || folder.hasPrefix(RemoteEntry.trashPath + "/")
}

/// Asks the server which browsed folders changed instead of listing each one. A batch the
/// server cannot check (an older server answers 404) is listed as before.
private func changedFolders(_ folders: [String], catalog: Catalog, client: some CatalogRefreshClient)
    async throws -> (due: [String], unavailable: [String], failure: (any Error)?) {
    let tokens = try await catalog.folderTokens()
    var due = folders.filter { uncheckable($0, token: tokens[$0]) }
    var pending = folders.compactMap { folder in tokens[folder].map { FolderCheck(path: folder, token: $0) } }
        .filter { !uncheckable($0.path, token: $0.token) }
    var unavailable: [String] = []
    var failure: (any Error)?
    while !pending.isEmpty {
        try Task.checkCancellation()
        let batch = Array(pending.prefix(100))
        do {
            let statuses = try await client.checks(batch)
            for status in statuses {
                switch status.status {
                case .unchanged: break
                case .changed: due.append(status.path)
                case .missing: unavailable.append(status.path)
                case .forbidden:
                    unavailable.append(status.path)
                    failure = failure ?? DriveError.forbidden
                }
            }
            let answered = Set(statuses.map(\.path))
            pending.removeAll { answered.contains($0.path) }
        } catch DriveError.missing {
            due += batch.map(\.path)
            pending.removeFirst(batch.count)
        } catch {
            try Task.checkCancellation()
            failure = failure ?? error
            unavailable += batch.map(\.path)
            pending.removeFirst(batch.count)
        }
    }
    return (due.sorted(), unavailable, failure)
}

/// Reconcile independent snapshots even when another folder or file is unavailable.
/// Publish completed changes before reporting a failure to the app's backoff/status.
public func refreshCatalog(_ catalog: Catalog, client: some CatalogRefreshClient, checks: Bool = false,
                           signalChanges: @Sendable () async throws -> Void) async throws {
    var failure: (any Error)?
    var unavailableFolders: [String] = []
    do {
        var folders = try await catalog.folders()
        if checks {
            let checked = try await changedFolders(folders, catalog: catalog, client: client)
            folders = checked.due; unavailableFolders = checked.unavailable; failure = checked.failure
        }
        for folder in folders {
            try Task.checkCancellation()
            do {
                let listing = try await catalog.beginListing(folder)
                let snapshot = try await client.snapshot(folder)
                try Task.checkCancellation()
                try await catalog.reconcile(snapshot.entries, folder: folder, listing: listing, token: snapshot.token)
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
                let itemFailure = [.authentication, .forbidden, .missing].contains(error as? DriveError)
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
