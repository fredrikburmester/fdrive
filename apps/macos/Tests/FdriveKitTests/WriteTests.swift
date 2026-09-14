import Foundation
import Testing
@testable import FdriveKit

private func remote(_ path: String, kind: String = "file", id: String = UUID().uuidString.lowercased()) -> RemoteEntry {
    var entry = RemoteEntry(path: path, name: String(path.split(separator: "/").last!), kind: kind, size: kind == "dir" ? 0 : 5)
    entry.id = id; entry.parentId = "root"; entry.version = WriteVersion(content: "digest", metadata: UUID().uuidString)
    entry.capabilities = WriteCapabilities(create: true, update: true, move: true, trash: false, restore: false)
    return entry
}
private func pending(_ item: CatalogItem, parent: CatalogItem, name: String, route: String = "moves") -> PendingWrite {
    let id = UUID().uuidString.lowercased()
    return PendingWrite(id: id, key: id, localId: item.id, route: route,
        request: WriteRequest(operationId: id, itemId: item.entry.id, parentId: parent.entry.id ?? "root", name: name,
            base: WriteVersion(content: item.contentVersion, metadata: item.metadataVersion)))
}

@Test func trashRestoreKeepsHandlesAndDescendantsLiveInWorkingSet() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Trash")
    let full = WriteCapabilities(create: true, update: true, move: true, trash: true, restore: true)
    try await catalog.configure(full)
    #expect(try await catalog.children("root").isEmpty)
    #expect(try await catalog.item("trash").entry.capabilities?.trash == true)
    #expect(try await catalog.item("trash").entry.capabilities?.create == false)
    let configured = try await catalog.revision()
    try await catalog.configure(full)
    #expect(try await catalog.revision() == configured)
    let folder = remote("/Folder", kind: "dir"), child = remote("/Folder/file.txt")
    try await catalog.reconcile([folder], folder: "/")
    try await catalog.reconcile([child], folder: folder.path)
    let original = try await catalog.itemAt(folder.path), cached = try await catalog.itemAt(child.path)
    _ = try await catalog.downloaded(cached.id, hash: "contents", size: 5)
    let operation = try await catalog.beginWrite(pending(original, parent: catalog.item("trash"), name: folder.name))
    let anchor = try await catalog.revision()
    var trashed = folder
    trashed.path = RemoteEntry.trashPath + "/" + folder.id!; trashed.name = "Folder (deleted test)"
    trashed.parentId = "trash"; trashed.trashed = true; trashed.capabilities = full.forEntry(trashed)
    let receipt = try await catalog.finishWrite(operation, entry: trashed)
    try await catalog.configure(full)
    #expect(receipt.id == original.id && receipt.parentId == "trash")
    #expect(try await catalog.item(cached.id).entry.capabilities?.update == false)
    #expect(try await catalog.item(cached.id).contentVersion == "contents")
    let changes = try await catalog.changes(since: anchor)
    #expect(Set(changes.items.map(\.id)) == Set([original.id, cached.id]))
    #expect(changes.deleted.isEmpty)
    #expect(try await catalog.children("trash").map(\.id) == [original.id])
    try await catalog.reconcile([trashed], folder: RemoteEntry.trashPath)
    let restore = try await catalog.beginWrite(pending(receipt, parent: catalog.item("root"), name: folder.name))
    let restoreAnchor = try await catalog.revision()
    var restored = folder; restored.trashed = false; restored.capabilities = full
    _ = try await catalog.finishWrite(restore, entry: restored)
    #expect(try await catalog.item(cached.id).entry.path == child.path)
    #expect(try await catalog.item(cached.id).entry.capabilities?.update == true)
    #expect(try await catalog.item(cached.id).materialized)
    #expect(try await catalog.changes(since: restoreAnchor).items.count == 2)
    #expect(try await catalog.children("trash").isEmpty)
    try await catalog.configure(.none)
    #expect(try await catalog.all().allSatisfy { $0.entry.capabilities == WriteCapabilities.none })
}

@Test func opaqueTrashNamesAreAllowedOnlyForValidatedRecoveryHandles() throws {
    let id = UUID().uuidString.lowercased()
    var entry = remote(RemoteEntry.trashPath + "/" + id, id: id)
    entry.name = "File (deleted 12345678).txt"; entry.parentId = "trash"; entry.trashed = true
    #expect(entry.hasValidListingName)
    entry.id = UUID().uuidString
    #expect(!entry.hasValidListingName)
    entry.id = id; entry.trashed = false
    #expect(!entry.hasValidListingName)
    entry.trashed = true; entry.name = "../escape"
    #expect(!entry.hasValidListingName)
    entry.name = "File.txt"; entry.path = "/normal/" + id
    #expect(!entry.hasValidListingName)
}

@Test func committedFolderMovePreservesDescendantsAndNotifiesBothParents() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Writes")
    let a = remote("/A", kind: "dir"); let b = remote("/B", kind: "dir")
    try await catalog.reconcile([a, b], folder: "/")
    let folder = remote("/A/folder", kind: "dir")
    try await catalog.reconcile([folder], folder: "/A")
    let child = remote("/A/folder/file.txt")
    try await catalog.reconcile([child], folder: folder.path)
    let original = try await catalog.itemAt(folder.path)
    let cached = try await catalog.itemAt(child.path)
    _ = try await catalog.downloaded(cached.id, hash: "contents", size: 5)
    let firstParent = try await catalog.itemAt("/A"), secondParent = try await catalog.itemAt("/B")
    let operation = try await catalog.beginWrite(pending(original, parent: secondParent, name: "moved"))
    let obsolete = try await catalog.beginListing("/A")
    let anchor = try await catalog.revision()
    var result = folder; result.path = "/B/moved"; result.name = "moved"; result.parentId = b.id
    _ = try await catalog.finishWrite(operation, entry: result)
    try await catalog.reconcile([folder], folder: "/A", listing: obsolete)
    #expect(try await catalog.item(original.id).entry.path == "/B/moved")
    #expect(try await catalog.item(cached.id).entry.path == "/B/moved/file.txt")
    #expect(try await catalog.item(cached.id).materialized)
    #expect(try await catalog.item(cached.id).contentVersion == "contents")
    #expect(try await catalog.folders().contains("/B/moved"))
    #expect(try await catalog.changes(since: anchor, parent: firstParent.id).deleted == [original.id])
    #expect(try await catalog.changes(since: anchor, parent: secondParent.id).items.map(\.id) == [original.id])
    let revision = try await catalog.revision()
    #expect(try await catalog.finishWrite(operation, entry: result).id == original.id)
    #expect(try await catalog.revision() == revision)
}

@Test func ownSaveKeepsEditorTimestampUntilRemoteContentChanges() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Writes")
    let entry = remote("/file.txt")
    try await catalog.reconcile([entry], folder: "/")
    let item = try await catalog.itemAt(entry.path)
    var operation = pending(item, parent: try await catalog.item("root"), name: entry.name, route: "uploads")
    let editorDate = Date(timeIntervalSince1970: 1_800_000_000.123)
    operation.localModificationDate = editorDate
    _ = try await catalog.beginWrite(operation)
    var result = entry; result.modifiedAt = "2027-01-15T08:00:01.000Z"
    _ = try await catalog.finishWrite(operation, entry: result)
    try await catalog.reconcile([result], folder: "/")
    #expect(try await catalog.item(item.id).localModificationDate == editorDate)
    result.modifiedAt = "2027-01-15T08:00:02.000Z"
    try await catalog.reconcile([result], folder: "/")
    #expect(try await catalog.item(item.id).localModificationDate == nil)
    try await catalog.reconcile([], folder: "/")
    try await catalog.reconcile([result], folder: "/")
    #expect(try await catalog.itemAt(entry.path).id == item.id)
}

@Test func oversizedSaveIsRejectedBeforeCreatingARecoveryCopyOrMakingARequest() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Writes")
    let file = directory.appendingPathComponent("oversized")
    _ = FileManager.default.createFile(atPath: file.path, contents: nil)
    let handle = try FileHandle(forWritingTo: file)
    try handle.truncate(atOffset: 16 * 1024 * 1024 * 1024 + 1); try handle.close()
    let client = try APIClient(server: URL(string: "http://127.0.0.1:1")!, protocolVersion: 2)
    await #expect(throws: DriveError.quota) {
        _ = try await WriteCoordinator(catalog: catalog, client: client).perform(route: "uploads", localId: nil,
            templateKey: "oversized", parentId: "root", name: "large", base: nil, contents: file, progress: Progress(totalUnitCount: 0))
    }
    #expect(try await catalog.pendingWrites().isEmpty)
    #expect(!FileManager.default.fileExists(atPath: catalog.recoveryDirectory.path))
}

@Test func pendingSaveSurvivesRefreshRemovalValidationAndRestart() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("catalog.sqlite")
    let catalog = try Catalog(url: url, title: "Writes")
    let entry = remote("/save.txt")
    try await catalog.reconcile([entry], folder: "/")
    let original = try await catalog.itemAt(entry.path)
    _ = try await catalog.downloaded(original.id, hash: "base", size: 5)
    let operation = try await catalog.beginWrite(pending(catalog.item(original.id), parent: catalog.item("root"), name: entry.name, route: "uploads"))
    try await catalog.reconcile([], folder: "/")
    try await catalog.validate([ContentVersion(path: entry.path, version: "remote", size: 10)])
    #expect(try await catalog.item(original.id).contentVersion == "base")
    try await catalog.writeFailed(operation, error: "Offline")
    let restarted = try Catalog(url: url, title: "Writes")
    #expect(try await restarted.pendingWrites().first?.error == "Offline")
    #expect(try await restarted.beginWrite(operation).id == operation.id)
    let copy = try await restarted.conflictCopy(operation)
    #expect(copy.request.itemId == nil)
    #expect(copy.request.base == nil)
    #expect(copy.request.name.contains("conflict"))
    #expect(copy.request.operationId != operation.id)
    #expect(try await restarted.conflictCopy(operation).request.operationId == copy.request.operationId)
}

@Test func upgradingRemoteHandlesPreservesLocalIdentifiersAndContentBases() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let catalog = try Catalog(url: directory.appendingPathComponent("catalog.sqlite"), title: "Writes")
    let v1 = RemoteEntry(path: "/old.txt", name: "old.txt", kind: "file", size: 5)
    try await catalog.reconcile([v1], folder: "/")
    let original = try await catalog.itemAt(v1.path)
    _ = try await catalog.downloaded(original.id, hash: "known", size: 5)
    let v2 = remote(v1.path)
    try await catalog.reconcile([v2], folder: "/")
    #expect(try await catalog.itemAt(v1.path).id == original.id)
    #expect(try await catalog.item(original.id).contentVersion == "known")
    #expect(try await catalog.item(original.id).metadataVersion == v2.version?.metadata)
    try await catalog.configure(.none)
    #expect(try await catalog.item(original.id).entry.capabilities == WriteCapabilities.none)
}

@Test func encodesNullUploadBaseAndNeverSendsFolderContentFields() throws {
    let request = WriteRequest(operationId: UUID().uuidString.lowercased(), itemId: nil, parentId: "root", name: "new", base: nil)
    let upload = try JSONSerialization.jsonObject(with: request.body(route: "uploads")) as! [String: Any]
    #expect(upload["base"] is NSNull)
    let folder = try JSONSerialization.jsonObject(with: request.body(route: "folders")) as! [String: Any]
    #expect(folder["base"] == nil && folder["size"] == nil && folder["itemId"] == nil)
}
