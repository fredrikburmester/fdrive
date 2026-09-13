import Foundation
import FdriveKit
@preconcurrency import FileProvider
import UniformTypeIdentifiers

final class ProviderItem: NSObject, NSFileProviderItem {
    let record: CatalogItem
    init(_ record: CatalogItem) { self.record = record }
    var itemIdentifier: NSFileProviderItemIdentifier { NativeEnvironment.id(record.id) }
    var parentItemIdentifier: NSFileProviderItemIdentifier { NativeEnvironment.id(record.parentId) }
    var filename: String { record.entry.name }
    var contentType: UTType {
        record.entry.kind == "dir" ? .folder : UTType(filenameExtension: (filename as NSString).pathExtension) ?? .data
    }
    var documentSize: NSNumber? { record.entry.kind == "file" ? NSNumber(value: record.entry.size) : nil }
    var contentModificationDate: Date? { record.entry.date }
    var capabilities: NSFileProviderItemCapabilities { record.entry.readable ? [.allowsReading] : [] }
    var fileSystemFlags: NSFileProviderFileSystemFlags {
        record.entry.kind == "dir" ? [.userReadable, .userExecutable] : [.userReadable]
    }
    var contentPolicy: NSFileProviderContentPolicy { .downloadLazilyAndEvictOnRemoteUpdate }
    var itemVersion: NSFileProviderItemVersion {
        .init(contentVersion: Data(record.contentVersion.utf8), metadataVersion: Data(record.metadataVersion.utf8))
    }
}
