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

/// The next automatic refresh waits four times as long as this one took and, after a refresh that
/// read every browsed folder on the server (checked or listed), at least a fifth of a second per
/// browsed folder, at most 15 minutes: a location with thousands of them would otherwise keep its
/// storage busy most of the time. A refresh that followed the change feed read only the folders
/// that changed, so it passes no folders. Small locations stay due every minute.
public func nextAutomaticRefresh(finished: Date, took duration: TimeInterval, folders: Int = 0) -> Date {
    finished.addingTimeInterval(min(max(max(0, duration) * 4, Double(folders) * 0.2), 900))
}

/// A location that follows the change feed still checks every browsed folder this often. The
/// journal behind the feed misses what the server's indexer never sees (names it skips, a file
/// rewritten with the same size and modification time, changes made while it was down until
/// its next scan), and that scan runs hourly by default, so an hour bounds both alike.
public let fullCheckInterval: TimeInterval = 3_600
/// More feed pages than this in one refresh is a bulk change: checking every folder is cheaper.
public let maxChangePages = 50

/// What a refresh read: only what the change feed named, or every browsed folder.
public enum RefreshKind: Sendable, Equatable { case feed, full }

public protocol CatalogRefreshClient: Sendable {
    func list(_ path: String) async throws -> [RemoteEntry]
    func snapshot(_ path: String) async throws -> (entries: [RemoteEntry], token: String?)
    func checks(_ folders: [FolderCheck]) async throws -> [FolderStatus]
    func changes(since anchor: String?) async throws -> ChangePage
    func versions(_ paths: [String]) async throws -> [ContentVersion]
}
public extension CatalogRefreshClient {
    func snapshot(_ path: String) async throws -> (entries: [RemoteEntry], token: String?) { (try await list(path), nil) }
    func checks(_ folders: [FolderCheck]) async throws -> [FolderStatus] { throw DriveError.missing }
    func changes(since anchor: String?) async throws -> ChangePage { throw DriveError.missing }
}
extension APIClient: CatalogRefreshClient {}

private func isTrash(_ folder: String) -> Bool {
    folder == RemoteEntry.trashPath || folder.hasPrefix(RemoteEntry.trashPath + "/")
}
/// Folders checks cannot vouch for are listed: those without a token from a complete listing,
/// and Trash, whose entries the server derives from other folders.
private func uncheckable(_ folder: String, token: String?) -> Bool { token == nil || isTrash(folder) }

/// Asks the server which browsed folders changed instead of listing each one. A batch the
/// server cannot check (an older server answers 404) is listed as before. A folder this
/// connection may not read loses its token, so later refreshes list it until it can be read.
private func changedFolders(_ folders: [String], catalog: Catalog, client: some CatalogRefreshClient)
    async throws -> (due: [String], unavailable: [String], failure: (any Error)?, settled: Bool) {
    let tokens = try await catalog.folderTokens()
    var due = folders.filter { uncheckable($0, token: tokens[$0]) }
    var pending = folders.compactMap { folder in tokens[folder].map { FolderCheck(path: folder, token: $0) } }
        .filter { !uncheckable($0.path, token: $0.token) }
    var unavailable: [String] = []
    var failure: (any Error)?
    var settled = true
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
                    try await catalog.forgetToken(status.path)
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
            settled = false
            unavailable += batch.map(\.path)
            pending.removeFirst(batch.count)
        }
    }
    return (due.sorted(), unavailable, failure, settled)
}

/// Everything the change feed named after an anchor, over all of its pages.
struct FeedChanges: Sendable {
    var paths: Set<String> = []
    var folders: Set<String> = []
    var anchor: String
    /// Whether `path` is at or below a changed path.
    func covers(_ path: String) -> Bool {
        var current = path
        while true {
            if paths.contains(current) { return true }
            if current == "/" { return false }
            current = parentPath(current)
        }
    }
}
enum FeedAnswer: Sendable { case changes(FeedChanges), resync(String) }

/// Reads the feed from `since` to its end. A bulk change of more than `maxChangePages` pages
/// answers resync from where it got to, so the refresh checks every folder instead.
func readChangeFeed(_ client: some CatalogRefreshClient, since: String?) async throws -> FeedAnswer {
    var collected = FeedChanges(anchor: since ?? "")
    var next = since
    for _ in 0..<maxChangePages {
        try Task.checkCancellation()
        let page = try await client.changes(since: next)
        guard page.status == .changes else { return .resync(page.anchor) }
        collected.paths.formUnion(page.paths ?? [])
        collected.folders.formUnion(page.folders ?? [])
        collected.anchor = page.anchor
        guard page.more == true else { return .changes(collected) }
        guard page.anchor != next else { throw DriveError.server("The change feed did not advance.") }
        next = page.anchor
    }
    return .resync(collected.anchor)
}

/// Reconcile independent snapshots even when another folder or file is unavailable.
/// Publish completed changes before reporting a failure to the app's backoff/status.
///
/// With `feed`, the refresh asks the server's change feed what changed since the anchor the
/// catalog stored, and lists only the browsed folders it names, those not listed in full since
/// (folders without a token, as with checks) and Trash, then checks only downloads at or below a
/// changed path. Without a stored anchor, when the server answers resync, after a bulk change,
/// with `checkAll` (a refresh the person asked for) or once `fullCheckInterval` has passed since
/// the last full check, it checks every folder as
/// before the feed (with `checks`, or by listing them) and starts from the anchor the feed gave
/// before that. The anchor is stored only once everything named before it was applied: a folder
/// that is gone counts as applied, one this connection may not read loses its token and is
/// listed by later refreshes instead, and any other failure keeps the old anchor, so the next
/// refresh asks again from it.
@discardableResult
public func refreshCatalog(_ catalog: Catalog, client: some CatalogRefreshClient, checks: Bool = false,
                           feed: Bool = false, checkAll: Bool = false, now: Date = Date(),
                           signalChanges: @Sendable () async throws -> Void) async throws -> RefreshKind {
    var failure: (any Error)?
    var unavailableFolders: [String] = []
    var kind = RefreshKind.full
    do {
        let browsed = try await catalog.folders()
        // Where the feed was before this refresh read anything, and the changes after it.
        var anchor: String?
        var changes: FeedChanges?
        var checkedAt = now
        if feed {
            let stored = try await catalog.changeFeed()
            let due = stored.map { now.timeIntervalSince($0.checkedAt) >= fullCheckInterval || $0.checkedAt > now } ?? true
            do {
                switch try await readChangeFeed(client, since: checkAll || due ? nil : stored?.anchor) {
                case .resync(let fresh): anchor = fresh
                case .changes(let found):
                    changes = found; anchor = found.anchor; checkedAt = stored?.checkedAt ?? now
                }
            } catch DriveError.missing {
                // This server keeps no feed for the location after all.
                try await catalog.forgetChangeFeed()
            } catch {
                // The feed only saves work: check everything this time and keep the old anchor.
                try Task.checkCancellation()
            }
        } else { try await catalog.forgetChangeFeed() }
        var settled = true
        var folders = browsed
        if let changes {
            kind = .feed
            let applied = try await catalog.listedInFull()
            folders = browsed.filter { folder in
                !applied.contains(folder) || isTrash(folder) || changes.folders.contains(folder) || changes.covers(folder)
            }
        } else if checks {
            let checked = try await changedFolders(folders, catalog: catalog, client: client)
            folders = checked.due; unavailableFolders = checked.unavailable; failure = checked.failure
            settled = checked.settled
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
                switch error as? DriveError {
                case .missing: break
                case .forbidden: failure = failure ?? error; try await catalog.forgetToken(folder)
                default: failure = failure ?? error; settled = false
                }
                unavailableFolders.append(folder)
            }
        }
        let cached = try await catalog.all().filter { item in
            item.materialized && item.entry.kind == "file" && changes?.covers(item.entry.path) != false
                && !unavailableFolders.contains { folder in folder == "/" || item.entry.path.hasPrefix(folder + "/") }
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
                if batch.count == 1 || !itemFailure {
                    failure = failure ?? error
                    if ![.forbidden, .missing].contains(error as? DriveError) { settled = false }
                    continue
                }
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
                        if ![.forbidden, .missing].contains(error as? DriveError) { settled = false }
                    }
                }
            }
        }
        if settled, let anchor { try await catalog.saveChangeFeed(anchor: anchor, checkedAt: checkedAt) }
    } catch {
        try Task.checkCancellation()
        failure = failure ?? error
    }
    try Task.checkCancellation()
    try await signalChanges()
    if let failure { throw failure }
    return kind
}
