import Foundation
import Security

/// Trial and purchase state. The app writes it; the extension only reads it (and starts the
/// trial if it runs first). It lives in the shared Keychain so reinstalling keeps the clock.
public struct LicenseRecord: Codable, Sendable, Equatable {
    public var trialStarted: Date
    public var key: String?
    public var activationId: String?
    /// Last time the seller confirmed this activation.
    public var validatedAt: Date?
    public init(trialStarted: Date, key: String? = nil, activationId: String? = nil, validatedAt: Date? = nil) {
        self.trialStarted = trialStarted; self.key = key; self.activationId = activationId; self.validatedAt = validatedAt
    }
}

public struct LicensePolicy: Sendable, Equatable {
    public var trial: TimeInterval
    public var revalidateAfter: TimeInterval
    /// A paid Mac keeps working this long without reaching the seller.
    public var offlineGrace: TimeInterval
    public init(trial: TimeInterval = 7 * 86_400, revalidateAfter: TimeInterval = 7 * 86_400, offlineGrace: TimeInterval = 30 * 86_400) {
        self.trial = trial; self.revalidateAfter = revalidateAfter; self.offlineGrace = offlineGrace
    }
    public static let standard = LicensePolicy()
}

public enum LicenseState: Sendable, Equatable {
    /// A build without a configured seller, such as one compiled from source.
    case unrestricted
    case trial(daysLeft: Int)
    case licensed
    case trialEnded
    /// Paid, but the seller has been unreachable for longer than the offline grace.
    case validationOverdue
    public var allowsAccess: Bool {
        switch self {
        case .unrestricted, .trial, .licensed: true
        case .trialEnded, .validationOverdue: false
        }
    }
}

extension LicenseRecord {
    public func state(now: Date, policy: LicensePolicy = .standard) -> LicenseState {
        if key != nil, activationId != nil, let validatedAt {
            return now.timeIntervalSince(validatedAt) <= policy.offlineGrace ? .licensed : .validationOverdue
        }
        let remaining = policy.trial - now.timeIntervalSince(trialStarted)
        guard remaining > 0 else { return .trialEnded }
        // A clock set before the trial began never extends it beyond its full length.
        return .trial(daysLeft: Int((min(remaining, policy.trial) / 86_400).rounded(.up)))
    }
    public func needsValidation(now: Date, policy: LicensePolicy = .standard) -> Bool {
        guard key != nil, activationId != nil else { return false }
        guard let validatedAt else { return true }
        return now.timeIntervalSince(validatedAt) >= policy.revalidateAfter
    }
}

public enum LicenseError: Error, LocalizedError, Sendable, Equatable {
    case invalidKey, activationLimit, revoked, unavailable, storage
    public var errorDescription: String? {
        switch self {
        case .invalidKey: "This license key was not recognized. Check it and try again."
        case .activationLimit: "This license is active on its maximum number of Macs. Deactivate one first."
        case .revoked: "This license is no longer valid."
        case .unavailable: "The license server could not be reached. Check your connection and try again."
        case .storage: "The license could not be saved on this Mac. Check the signing configuration."
        }
    }
}

public protocol LicenseStorage: Sendable {
    func read() throws -> Data?
    /// Returns false when a record already exists, so two processes cannot both start a trial.
    func add(_ data: Data) throws -> Bool
    func write(_ data: Data) throws
}

public struct KeychainLicenseStorage: LicenseStorage {
    public let keychainGroup: String?
    public init(keychainGroup: String?) { self.keychainGroup = keychainGroup }
    private var query: [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrService as String: "fdrive.license", kSecAttrAccount as String: "record"]
        if let keychainGroup { query[kSecAttrAccessGroup as String] = keychainGroup }
        return query
    }
    public func read() throws -> Data? {
        var query = query; query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw LicenseError.storage }
        return data
    }
    public func add(_ data: Data) throws -> Bool {
        var entry = query
        entry[kSecValueData as String] = data
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(entry as CFDictionary, nil)
        if status == errSecDuplicateItem { return false }
        guard status == errSecSuccess else { throw LicenseError.storage }
        return true
    }
    public func write(_ data: Data) throws {
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound { _ = try add(data); return }
        guard status == errSecSuccess else { throw LicenseError.storage }
    }
}

public struct LicenseStore: Sendable {
    private let storage: any LicenseStorage
    public init(storage: any LicenseStorage) { self.storage = storage }
    /// The first read on a Mac starts the trial.
    public func load(now: Date) throws -> LicenseRecord {
        if let data = try storage.read() { return try decode(data) }
        let record = LicenseRecord(trialStarted: now)
        if try storage.add(JSONEncoder().encode(record)) { return record }
        guard let data = try storage.read() else { throw LicenseError.storage }
        return try decode(data)
    }
    public func save(_ record: LicenseRecord) throws { try storage.write(JSONEncoder().encode(record)) }
    private func decode(_ data: Data) throws -> LicenseRecord {
        do { return try JSONDecoder().decode(LicenseRecord.self, from: data) } catch { throw LicenseError.storage }
    }
}

public protocol LicenseProvider: Sendable {
    /// Returns the activation identifier for this Mac.
    func activate(key: String, label: String) async throws -> String
    func validate(key: String, activationId: String) async throws
    func deactivate(key: String, activationId: String) async throws
}

/// Polar's customer-portal license endpoints take no credential, so none ships in the app.
public struct PolarLicenseProvider: LicenseProvider {
    private let organizationId: String
    private let host: String
    private let session: URLSession
    private let now: @Sendable () -> Date
    /// Polar's sandbox is a separate server with its own organizations and test payments.
    public init(organizationId: String, sandbox: Bool = false, session: URLSession? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.organizationId = organizationId; self.now = now
        host = sandbox ? "sandbox-api.polar.sh" : "api.polar.sh"
        if let session { self.session = session } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: configuration)
        }
    }
    private struct Activation: Decodable { let id: String }
    private struct Validation: Decodable {
        struct Activation: Decodable { let id: String }
        let status: String
        let expires_at: String?
        let activation: Activation?
    }
    private func send(_ route: String, _ fields: [String: String]) async throws -> (Data, Int) {
        var request = URLRequest(url: URL(string: "https://\(host)/v1/customer-portal/license-keys/\(route)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(fields.merging(["organization_id": organizationId]) { value, _ in value })
        do {
            let (data, response) = try await session.data(for: request)
            guard let status = (response as? HTTPURLResponse)?.statusCode else { throw LicenseError.unavailable }
            return (data, status)
        } catch is CancellationError { throw CancellationError() } catch let error as LicenseError { throw error } catch { throw LicenseError.unavailable }
    }
    public func activate(key: String, label: String) async throws -> String {
        let (data, status) = try await send("activate", ["key": key, "label": label])
        switch status {
        case 200:
            guard let activation = try? JSONDecoder().decode(Activation.self, from: data) else { throw LicenseError.unavailable }
            return activation.id
        case 403: throw LicenseError.activationLimit
        case 404, 422: throw LicenseError.invalidKey
        default: throw LicenseError.unavailable
        }
    }
    public func validate(key: String, activationId: String) async throws {
        let (data, status) = try await send("validate", ["key": key, "activation_id": activationId])
        switch status {
        case 200:
            guard let result = try? JSONDecoder().decode(Validation.self, from: data) else { throw LicenseError.unavailable }
            guard result.status == "granted", result.activation?.id.lowercased() == activationId.lowercased() else { throw LicenseError.revoked }
            if let expiry = result.expires_at.flatMap(Self.date), expiry <= now() { throw LicenseError.revoked }
        case 404, 422: throw LicenseError.invalidKey
        default: throw LicenseError.unavailable
        }
    }
    public func deactivate(key: String, activationId: String) async throws {
        let (_, status) = try await send("deactivate", ["key": key, "activation_id": activationId])
        switch status {
        case 200, 204: return
        case 404, 422: throw LicenseError.invalidKey
        default: throw LicenseError.unavailable
        }
    }
    private static func date(_ value: String) -> Date? {
        for options: ISO8601DateFormatter.Options in [[.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime]] {
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = options
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }
}

public struct LicenseManager: Sendable {
    public let store: LicenseStore
    public let provider: any LicenseProvider
    public let policy: LicensePolicy
    public init(store: LicenseStore, provider: any LicenseProvider, policy: LicensePolicy = .standard) {
        self.store = store; self.provider = provider; self.policy = policy
    }
    public func state(now: Date) throws -> LicenseState { try store.load(now: now).state(now: now, policy: policy) }
    public func activate(key: String, label: String, now: Date) async throws -> LicenseState {
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw LicenseError.invalidKey }
        var record = try store.load(now: now)
        let activationId = try await provider.activate(key: key, label: label)
        record.key = key; record.activationId = activationId; record.validatedAt = now
        do { try store.save(record) } catch {
            // Never leave a seat consumed by an activation this Mac cannot remember.
            try? await provider.deactivate(key: key, activationId: activationId)
            throw error
        }
        return record.state(now: now, policy: policy)
    }
    /// Only a definitive answer from the seller removes a license; an outage never does.
    public func revalidateIfDue(now: Date) async throws -> LicenseState {
        var record = try store.load(now: now)
        guard record.needsValidation(now: now, policy: policy), let key = record.key, let activationId = record.activationId else {
            return record.state(now: now, policy: policy)
        }
        do {
            try await provider.validate(key: key, activationId: activationId)
            record.validatedAt = now
        } catch LicenseError.revoked, LicenseError.invalidKey {
            record.key = nil; record.activationId = nil; record.validatedAt = nil
        } catch LicenseError.unavailable {
            return record.state(now: now, policy: policy)
        }
        try store.save(record)
        return record.state(now: now, policy: policy)
    }
    /// Frees this Mac's seat. A key the seller no longer knows is simply forgotten.
    public func deactivate(now: Date) async throws -> LicenseState {
        var record = try store.load(now: now)
        if let key = record.key, let activationId = record.activationId {
            do { try await provider.deactivate(key: key, activationId: activationId) } catch LicenseError.invalidKey {}
        }
        record.key = nil; record.activationId = nil; record.validatedAt = nil
        try store.save(record)
        return record.state(now: now, policy: policy)
    }
}
