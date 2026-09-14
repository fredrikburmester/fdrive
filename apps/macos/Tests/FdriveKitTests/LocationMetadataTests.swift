import Foundation
import Testing
@testable import FdriveKit

private func metadataLocation(name: String = "Home storage", username: String = "alice",
                              account: String = "account", identity: String = "identity", provider: String = "provider",
                              paths: [String] = ["/"], version: Int = 1, readOnly: Bool = true) -> Location {
    Location(protocolVersion: version, accountId: account, identityId: identity, providerId: provider,
             displayName: name, username: username, paths: paths, readOnly: readOnly)
}
private struct MetadataClient: LocationMetadataClient {
    var result: Location?
    func location() async throws -> Location {
        guard let result else { throw DriveError.unavailable }
        return result
    }
}

@Test func metadataRefreshPreservesBindingsGrantsCatalogAndOtherLocations() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try ConnectionStore(directory: directory)
    let saved = SavedLocation(server: URL(string: "https://drive.example")!, location: metadataLocation(name: "Old storage", paths: ["/docs"], version: 2, readOnly: false), expiresAt: "2027-09-13")
    let other = SavedLocation(server: saved.server, location: metadataLocation(identity: "other", provider: "other"))
    try store.save([saved, other])
    let catalog = try store.catalog(saved)
    let entry = RemoteEntry(path: "/cached", name: "cached", kind: "file", size: 3)
    try await catalog.reconcile([entry], folder: "/")
    let item = try await catalog.itemAt("/cached")
    _ = try await catalog.downloaded(item.id, hash: "cached-content", size: 3)
    let original = try await catalog.item(item.id)
    let generation = try await catalog.generation()
    let anchor = try await catalog.revision()
    var domains: [SavedLocation] = []
    let updated = try await refreshLocationMetadata(saved, client: MetadataClient(result: metadataLocation(paths: ["/docs"], version: 2, readOnly: false))) {
        domains.append($0)
    }
    #expect(domains == [updated])
    #expect(updated.id == saved.id && updated.server == saved.server && updated.expiresAt == saved.expiresAt)
    #expect(updated.location.paths == ["/docs"])
    #expect(updated.location.accountId == saved.location.accountId)
    #expect(updated.location.identityId == saved.location.identityId)
    #expect(updated.location.providerId == saved.location.providerId)
    try await catalog.updateRootName(updated.title)
    try store.save([updated, other])
    let reopened = try store.catalog(updated)
    #expect(try store.load() == [updated, other])
    #expect(try await reopened.generation() == generation)
    #expect(try await reopened.item(item.id) == original)
    #expect(try await reopened.item("root").entry.name == "Home storage (alice)")
    #expect(try await reopened.changes(since: anchor).items.map(\.id) == ["root"])
    let revision = try await reopened.revision()
    try await reopened.updateRootName(updated.title)
    #expect(try await reopened.revision() == revision)
}

@Test func mismatchedMetadataNeverUpdatesAnyDomain() async throws {
    let saved = SavedLocation(server: URL(string: "https://drive.example")!, location: metadataLocation(name: "Old"))
    for fresh in [metadataLocation(account: "other"), metadataLocation(identity: "other"), metadataLocation(provider: "other"), metadataLocation(version: 3), metadataLocation(version: 1, readOnly: false)] {
        var updated = false
        await #expect(throws: (any Error).self) {
            _ = try await refreshLocationMetadata(saved, client: MetadataClient(result: fresh)) { _ in updated = true }
        }
        #expect(!updated)
    }
}

@Test func offlineAndFailedRenamesRetainLastSavedMetadataAndRetry() async throws {
    let saved = SavedLocation(server: URL(string: "https://drive.example")!, location: metadataLocation(name: "Old"))
    var updates = 0
    await #expect(throws: DriveError.unavailable) {
        _ = try await refreshLocationMetadata(saved, client: MetadataClient()) { _ in updates += 1 }
    }
    #expect(updates == 0 && saved.location.displayName == "Old")
    await #expect(throws: DriveError.unavailable) {
        _ = try await refreshLocationMetadata(saved, client: MetadataClient(result: metadataLocation())) { _ in
            updates += 1; throw DriveError.unavailable
        }
    }
    #expect(updates == 1 && saved.location.displayName == "Old")
    let updated = try await refreshLocationMetadata(saved, client: MetadataClient(result: metadataLocation())) { _ in updates += 1 }
    #expect(updated.location.displayName == "Home storage" && updates == 2)
    _ = try await refreshLocationMetadata(updated, client: MetadataClient(result: metadataLocation())) { _ in updates += 1 }
    #expect(updates == 2)
}

@Test func cancelledMetadataRefreshNeverRenamesTheDomain() async throws {
    let saved = SavedLocation(server: URL(string: "https://drive.example")!, location: metadataLocation(name: "Old"))
    struct CancelledClient: LocationMetadataClient {
        func location() async throws -> Location {
            withUnsafeCurrentTask { $0?.cancel() }
            return metadataLocation()
        }
    }
    let task = Task {
        var updated = false
        await #expect(throws: CancellationError.self) {
            _ = try await refreshLocationMetadata(saved, client: CancelledClient()) { _ in updated = true }
        }
        #expect(!updated)
    }
    await task.value
}
