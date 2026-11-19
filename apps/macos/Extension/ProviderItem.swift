import Foundation
import FdriveKit
@preconcurrency import FileProvider
import UniformTypeIdentifiers

final class ProviderItem: NSObject, NSFileProviderItem {
    let record: CatalogItem
    init(_ record: CatalogItem) { self.record = record }
    var itemIdentifier: NSFileProviderItemIdentifier { NativeEnvironment.id(record.id) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { NativeEnvironment.id(record.parentId) }
    /// Inside an encrypted folder, the decrypted name; the server's stays in `record.entry`.
    var filename: String { record.id == "trash" ? ".Trash" : record.displayName }
    var contentType: UTType {
        record.entry.kind == "dir" ? .folder : UTType(filenameExtension: (filename as NSString).pathExtension) ?? .data
    }
    /// Inside an encrypted folder the server's size is the ciphertext's; Finder shows the plaintext's.
    var documentSize: NSNumber? {
        guard record.entry.kind == "file" else { return nil }
        guard record.encryptedIn != nil else { return NSNumber(value: record.entry.size) }
        return NSNumber(value: Age.decryptedSize(record.entry.size) ?? record.entry.size)
    }
    var contentModificationDate: Date? { record.localModificationDate ?? record.entry.date }
    var capabilities: NSFileProviderItemCapabilities {
        guard record.entry.readable else { return [] }
        // A name that does not decrypt is read-only; in Trash it can still be deleted for good.
        if record.stray == true {
            var result: NSFileProviderItemCapabilities = record.encryptedIn == nil ? [] : [.allowsReading]
            if record.parentId == "trash", record.entry.capabilities?.restore == true { result.insert(.allowsDeleting) }
            return result
        }
        let remote = record.entry.capabilities ?? .none
        var result: NSFileProviderItemCapabilities = [.allowsReading]
        if record.entry.kind == "dir", remote.create { result.insert(.allowsAddingSubItems) }
        if record.entry.kind == "file", remote.update { result.insert(.allowsWriting) }
        if record.id != "root", record.id != "trash" {
            if remote.move { result.formUnion([.allowsRenaming, .allowsReparenting]) }
            if remote.trash { result.insert(.allowsTrashing) }
            // Delete Immediately moves a live item to fdrive's Trash; Empty Trash deletes a
            // whole Trash item for good (`WriteCoordinator.delete`).
            if remote.trash || (record.parentId == "trash" && remote.restore) { result.insert(.allowsDeleting) }
        }
        return result
    }
    var fileSystemFlags: NSFileProviderFileSystemFlags {
        var result: NSFileProviderFileSystemFlags = record.entry.kind == "dir" ? [.userReadable, .userExecutable] : [.userReadable]
        if record.stray == true { return result }
        if record.entry.capabilities?.create == true || record.entry.capabilities?.update == true { result.insert(.userWritable) }
        // POSIX rename into the system Trash needs a writable destination directory.
        // This permits recoverable moves without advertising new-item creation there.
        if record.id == "trash", record.entry.capabilities?.trash == true { result.insert(.userWritable) }
        if record.entry.kind == "dir", record.entry.capabilities?.restore == true { result.insert(.userWritable) }
        return result
    }
    var contentPolicy: NSFileProviderContentPolicy { record.entry.capabilities?.update == true ? .downloadLazily : .downloadLazilyAndEvictOnRemoteUpdate }
    var itemVersion: NSFileProviderItemVersion {
        .init(contentVersion: Data(record.contentVersion.utf8), metadataVersion: Data(record.metadataVersion.utf8))
    }
}
