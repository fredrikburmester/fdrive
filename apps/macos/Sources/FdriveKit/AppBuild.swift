import Foundation

/// The version a copy of FDrive declares. `brew upgrade` or a drag from the disk image replaces
/// the bundle under a running app, which keeps executing the old code until it restarts.
public struct AppBuild: Equatable, Sendable {
    public let version: String
    public let build: String
    public init(version: String, build: String) { self.version = version; self.build = build }
    public init?(info: [String: Any]) {
        guard let version = info["CFBundleShortVersionString"] as? String,
              let build = info["CFBundleVersion"] as? String else { return nil }
        self.init(version: version, build: build)
    }
    /// Reads the bundle on disk now. `Bundle` keeps the Info.plist it loaded at launch.
    public static func installed(at bundle: URL) -> AppBuild? {
        guard let data = try? Data(contentsOf: bundle.appending(path: "Contents/Info.plist")),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return AppBuild(info: info)
    }
}

/// Decides when a running copy should restart into the one installed over it. A different build
/// must be seen twice in a row, so a copy still being written is never launched half finished.
public struct UpdateWatch: Sendable {
    public let running: AppBuild
    private var candidate: AppBuild?
    public init(running: AppBuild) { self.running = running }
    /// The installed build to restart into, or nil to keep running. A missing bundle is nil too.
    public mutating func check(installed: AppBuild?) -> AppBuild? {
        guard let installed, installed != running else { candidate = nil; return nil }
        defer { candidate = installed }
        return candidate == installed ? installed : nil
    }
}

/// Carries whether the locations window was open across a restart after an update, so the new
/// copy neither pops a closed window open nor hides one the user had in front of them.
public struct RelaunchMarker: Sendable {
    static let key = "relaunchShowsLocations"
    static let savedAt = "relaunchSavedAt"
    /// Older than this, the restart it described did not happen; launch as usual.
    static let lifetime: TimeInterval = 120
    private let suite: String?
    public init(suite: String? = nil) { self.suite = suite }
    private var defaults: UserDefaults { suite.flatMap(UserDefaults.init(suiteName:)) ?? .standard }
    public func save(showingLocations: Bool, now: Date = Date()) {
        defaults.set(showingLocations, forKey: Self.key)
        defaults.set(now.timeIntervalSince1970, forKey: Self.savedAt)
    }
    public func clear() {
        defaults.removeObject(forKey: Self.key); defaults.removeObject(forKey: Self.savedAt)
    }
    /// Whether to show the window at this launch. Read once: a later launch opens it as usual.
    public func takeShowsLocations(now: Date = Date()) -> Bool {
        defer { clear() }
        guard let saved = defaults.object(forKey: Self.savedAt) as? Double,
              abs(now.timeIntervalSince1970 - saved) < Self.lifetime else { return true }
        return defaults.bool(forKey: Self.key)
    }
}
