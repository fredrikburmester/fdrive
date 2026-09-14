import Foundation
import FdriveKit
@preconcurrency import FileProvider

enum NativeEnvironment {
    static func updateDomainName(_ saved: SavedLocation) async throws {
        guard let existing = try await NSFileProviderManager.domains().first(where: {
            $0.identifier.rawValue == saved.id
        }), !existing.isDisconnected else { throw DriveError.unavailable }
        let domain = NSFileProviderDomain(identifier: existing.identifier, displayName: saved.title)
        domain.isHidden = existing.isHidden
        domain.supportsSyncingTrash = existing.supportsSyncingTrash
        domain.supportsStringSearchRequest = existing.supportsStringSearchRequest
        // Apple's same-identifier add updates the display name in place. Never remove/re-add.
        try await NSFileProviderManager.add(domain)
    }
    static func store() throws -> ConnectionStore {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FdriveAppGroup") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw DriveError.server("The app's shared container is unavailable. Check the signing configuration.")
        }
        return try ConnectionStore(directory: directory.appendingPathComponent("Library/Application Support/fdrive"),
                                   keychainGroup: Bundle.main.object(forInfoDictionaryKey: "FdriveKeychainGroup") as? String)
    }
    static func id(_ id: NSFileProviderItemIdentifier) -> String { id == .rootContainer ? "root" : id == .trashContainer ? "trash" : id.rawValue }
    static func id(_ id: String) -> NSFileProviderItemIdentifier { id == "root" ? .rootContainer : id == "trash" ? .trashContainer : .init(id) }
    static func error(_ error: Error) -> NSError {
        if error is CancellationError || (error as? URLError)?.code == .cancelled {
            return NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)
        }
        let native = error as NSError
        if native.domain == NSCocoaErrorDomain || native.domain == NSFileProviderErrorDomain { return native }
        switch error as? DriveError {
        case .authentication: return NSFileProviderError(.notAuthenticated) as NSError
        case .missing: return NSFileProviderError(.noSuchItem) as NSError
        case .expiredSnapshot: return NSFileProviderError(.syncAnchorExpired) as NSError
        case .changedContent: return NSFileProviderError(.versionNoLongerAvailable) as NSError
        case .writeConflict, .writeUncertain, .permission, .quota:
            return NSError(domain: NSFileProviderErrorDomain, code: NSFileProviderError.cannotSynchronize.rawValue,
                           userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        case .unsupported: return NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)
        case .forbidden:
            return NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError,
                           userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        case .diskFull:
            return NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError,
                           userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        default:
            if let failure = error as? URLError, [.cannotCreateFile, .cannotOpenFile, .cannotWriteToFile, .cannotCloseFile,
                                                  .cannotMoveFile, .cannotRemoveFile].contains(failure.code) {
                // A local write failure is not a server outage; retrying cannot free space.
                return NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError,
                               userInfo: [NSLocalizedDescriptionKey: "Could not save the download on this Mac. Check free disk space."])
            }
            if error is URLError || (error as? DriveError) == .unavailable { return NSFileProviderError(.serverUnreachable) as NSError }
            return NSError(domain: NSCocoaErrorDomain, code: NSFileReadUnknownError,
                           userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        }
    }
}

/// The framework owns these escaping callbacks/observers. Transfer the reference to one
/// task, invoke it once, and never access it concurrently from multiple tasks.
final class Callback<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
