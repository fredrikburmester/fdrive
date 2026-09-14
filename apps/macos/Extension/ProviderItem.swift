import Foundation
import FdriveKit
@preconcurrency import FileProvider
import UniformTypeIdentifiers

final class ProviderItem: NSObject, NSFileProviderItem {
    let record: CatalogItem
    init(_ record: CatalogItem) { self.record = record }
    var itemIdentifier: NSFileProviderItemIdentifier { NativeEnvironment.id(record.id) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { NativeEnvironment.id(record.parentId) }
    var filename: String { record.id == "trash" ? ".Trash" : record.entry.name }
    var contentType: UTType {
        record.entry.kind == "dir" ? .folder : UTType(filenameExtension: (filename as NSString).pathExtension) ?? .data
    }
    var documentSize: NSNumber? { record.entry.kind == "file" ? NSNumber(value: record.entry.size) : nil }
    var contentModificationDate: Date? { record.localModificationDate ?? record.entry.date }
    var capabilities: NSFileProviderItemCapabilities {
        guard record.entry.readable else { return [] }
        let remote = record.entry.capabilities ?? .none
        var result: NSFileProviderItemCapabilities = [.allowsReading]
        if record.entry.kind == "dir", remote.create { result.insert(.allowsAddingSubItems) }
        if record.entry.kind == "file", remote.update { result.insert(.allowsWriting) }
        if record.id != "root", record.id != "trash" {
            if remote.move { result.formUnion([.allowsRenaming, .allowsReparenting]) }
            if remote.trash { result.insert(.allowsTrashing) }
        }
        return result
    }
    var fileSystemFlags: NSFileProviderFileSystemFlags {
        var result: NSFileProviderFileSystemFlags = record.entry.kind == "dir" ? [.userReadable, .userExecutable] : [.userReadable]
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
