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
    /// nil when no domain with this identifier is registered.
    static func domainState(_ id: String) async throws -> DomainState? {
        guard let domain = try await NSFileProviderManager.domains().first(where: { $0.identifier.rawValue == id }) else { return nil }
        return DomainState(userEnabled: domain.userEnabled, disconnected: domain.isDisconnected)
    }
    static func store() throws -> ConnectionStore {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FdriveAppGroup") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw DriveError.server("The app's shared container is unavailable. Check the signing configuration.")
        }
        return try ConnectionStore(directory: directory.appendingPathComponent("Library/Application Support/fdrive"),
                                   keychainGroup: Bundle.main.object(forInfoDictionaryKey: "FdriveKeychainGroup") as? String)
    }
    /// nil when the build names no seller, such as one compiled from source: nothing is gated.
    static func licenseManager() -> LicenseManager? {
        guard let organization = Bundle.main.object(forInfoDictionaryKey: "FdriveLicenseOrganization") as? String,
              UUID(uuidString: organization) != nil else { return nil }
        let group = Bundle.main.object(forInfoDictionaryKey: "FdriveKeychainGroup") as? String
        var policy = LicensePolicy.standard
        #if DEBUG
        // Rehearsals only: Release builds never compile this, so no shipped app can shorten or stretch a trial.
        if let seconds = (Bundle.main.object(forInfoDictionaryKey: "FdriveLicenseTrialSeconds") as? String).flatMap(TimeInterval.init) { policy.trial = seconds }
        #endif
        return LicenseManager(store: LicenseStore(storage: KeychainLicenseStorage(keychainGroup: group)),
                              provider: PolarLicenseProvider(organizationId: organization,
                                  sandbox: Bundle.main.object(forInfoDictionaryKey: "FdriveLicenseSandbox") as? String == "YES"),
                              policy: policy)
    }
    /// An unreadable Keychain never locks out a paying customer.
    static func licenseState() -> LicenseState {
        guard let manager = licenseManager() else { return .unrestricted }
        return (try? manager.state(now: Date())) ?? .unrestricted
    }
    static var purchaseURL: URL? {
        (Bundle.main.object(forInfoDictionaryKey: "FdrivePurchaseURL") as? String).flatMap { URL(string: $0) }.flatMap { $0.scheme == "https" ? $0 : nil }
    }
    /// What the framework says about this copy of FDrive, or nil when the error is about a location.
    static func installationProblem(_ error: Error) -> String? {
        let native = error as NSError
        guard native.domain == NSFileProviderErrorDomain else { return nil }
        switch NSFileProviderError.Code(rawValue: native.code) {
        case .newerExtensionVersionFound: return "A newer FDrive is installed on this Mac. Finder uses that copy; open it instead of this one."
        case .olderExtensionVersionRunning: return "An older copy of FDrive is still running. Quit it, then open this one again."
        case .providerTranslocated: return "Move FDrive to the Applications folder, then open it again."
        case .providerNotFound, .applicationExtensionNotFound: return "FDrive's Finder extension is missing. Reinstall FDrive."
        default: return nil
        }
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
        // Resolvable: macOS keeps pending edits and retries after signalErrorResolved.
        case .authentication, .unlicensed: return NSFileProviderError(.notAuthenticated) as NSError
        case .missing: return NSFileProviderError(.noSuchItem) as NSError
        case .expiredSnapshot: return NSFileProviderError(.syncAnchorExpired) as NSError
        case .changedContent: return NSFileProviderError(.versionNoLongerAvailable) as NSError
        case .writeConflict, .nameCollision, .writeUncertain, .permission, .quota:
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
