import SwiftUI
import ServiceManagement
import FdriveKit
@preconcurrency import FileProvider

@main
struct FdriveApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        Window("FDrive", id: "locations") {
            LocationsView(model: model).frame(minWidth: 520, minHeight: 400)
                .background(WindowActivation())
        }.defaultSize(width: 600, height: 460)
            .defaultLaunchBehavior(.presented)
            .restorationBehavior(.disabled)
        MenuBarExtra("FDrive", image: "MenuBarIcon") {
            MenuContents(model: model)
        }
    }
}

// Observe only the locations window, without replacing SwiftUI's window delegate.
// Losing focus, opening the menu or minimizing is not the same as closing it.
private struct WindowActivation: NSViewRepresentable {
    func makeNSView(context: Context) -> ActivationView { ActivationView() }
    func updateNSView(_ nsView: ActivationView, context: Context) {}

    final class ActivationView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            NotificationCenter.default.removeObserver(self)
            guard let window else { return }
            NotificationCenter.default.addObserver(self, selector: #selector(windowOpened(_:)),
                name: NSWindow.didBecomeKeyNotification, object: window)
            NotificationCenter.default.addObserver(self, selector: #selector(windowClosed(_:)),
                name: NSWindow.willCloseNotification, object: window)
            windowOpened(nil)
        }

        @objc private func windowOpened(_ notification: Notification?) {
            if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
        }

        @objc private func windowClosed(_ notification: Notification) {
            NSApp.setActivationPolicy(.accessory)
        }

        deinit { NotificationCenter.default.removeObserver(self) }
    }
}

private struct MenuContents: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        if let summary = model.license.summary {
            Text(summary)
            if let url = NativeEnvironment.purchaseURL { Button("Buy FDrive…") { NSWorkspace.shared.open(url) } }
            Divider()
        }
        Button("Locations and Settings") { openWindow(id: "locations"); NSApp.activate() }
        ForEach(model.locations) { location in
            Button(location.title) { Task { await model.reveal(location) } }
        }
        Divider()
        Button("Refresh") { Task { await model.refresh() } }.disabled(model.refreshing)
        Button("Quit FDrive") { NSApp.terminate(nil) }
    }
}

private struct LocationsView: View {
    @ObservedObject var model: AppModel
    @State private var address = ""
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var trashLocation: SavedLocation?
    @State private var enteringLicense = false
    @State private var confirmingDeactivation = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Image(nsImage: NSImage(named: NSImage.applicationIconName) ?? NSImage())
                    .resizable().frame(width: 48, height: 48).accessibilityHidden(true)
                VStack(alignment: .leading) {
                    Text("FDrive").font(.title.bold())
                    Text("Your files in Finder, downloaded when needed.").foregroundStyle(.secondary)
                }
                Spacer()
                if model.refreshing { ProgressView().controlSize(.small) }
            }
            if model.license != .unrestricted, model.license != .licensed {
                LicenseBanner(model: model) { enteringLicense = true }
            }
            HStack {
                TextField("https://drive.example.com", text: $address)
                    .textFieldStyle(.roundedBorder).accessibilityLabel("Server address")
                Button(model.pairing ? "Connecting…" : "Connect") {
                    Task { await model.connect(address) }
                }.disabled(model.pairing || address.isEmpty)
            }
            if let code = model.pairCode {
                HStack {
                    Text("Approve this code in your browser: \(code)").textSelection(.enabled)
                    Spacer()
                    Button("Cancel") { model.cancelPairing() }
                }
            }
            if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if model.locations.isEmpty {
                ContentUnavailableView("Connect your storage", systemImage: "folder", description: Text("Choose your linked logins in the browser. Each gets its own Finder location."))
            } else {
                List(model.locations) { location in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(location.location.displayName).font(.headline)
                            Text(location.location.username).foregroundStyle(.secondary)
                            Text(model.status[location.id] ?? "Connected").font(.caption).foregroundStyle(.secondary)
                            if let guidance = model.health[location.id]?.guidance {
                                Text(guidance).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                                if model.health[location.id]?.needsSystemSettings == true {
                                    Button("Open System Settings") { model.openExtensionSettings() }.buttonStyle(.link).font(.caption)
                                }
                            }
                            if let warning = model.warnings[location.id] {
                                Text(warning).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                            }
                            if let expires = location.expiresAt { Text("Connection expires \(expires.prefix(10))").font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Button("Open") { Task { await model.reveal(location) } }.buttonStyle(.borderless).accessibilityLabel("Open in Finder")
                        Menu {
                            Button("Refresh") { Task { await model.refresh() } }
                            Button("Reconnect") { address = location.server.absoluteString; Task { await model.connect(address) } }
                            Button("Show recovery files") { Task { await model.revealRecovery(location) } }
                            if location.location.capabilities?.restore == true {
                                Button("Restore from Trash…") { trashLocation = location }
                            }
                            Button("Disconnect") { Task { await model.disconnect(location) } }
                        } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 24).disabled(model.pairing)
                    }.padding(.vertical, 6)
                }.listStyle(.inset)
                Text("If Finder asks, click Enable to activate the location.").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Toggle("Launch at login", isOn: $launchAtLogin).onChange(of: launchAtLogin) { _, value in
                    do { if value { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
                    catch { model.error = error.localizedDescription; launchAtLogin = SMAppService.mainApp.status == .enabled }
                }
                Spacer()
                if model.license == .licensed {
                    if model.licensing { ProgressView().controlSize(.mini) }
                    Text("Licensed").font(.caption).foregroundStyle(.secondary)
                    Button("Deactivate This Mac…") { confirmingDeactivation = true }.buttonStyle(.link).font(.caption).disabled(model.licensing)
                }
                Text("macOS 26+").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(24)
            .sheet(item: $trashLocation) { TrashRecoveryView(location: $0) }
            .sheet(isPresented: $enteringLicense) { LicenseEntryView(model: model) }
            .confirmationDialog("Deactivate FDrive on this Mac?", isPresented: $confirmingDeactivation) {
                Button("Deactivate") { Task { await model.deactivateLicense() } }
            } message: { Text("This frees the license for another Mac. Your locations and files are kept.") }
    }
}

private extension LicenseState {
    /// nil when there is nothing to tell the user.
    var summary: String? {
        switch self {
        case .unrestricted, .licensed: nil
        case .trial(let daysLeft): daysLeft == 1 ? "Trial: 1 day left" : "Trial: \(daysLeft) days left"
        case .trialEnded: "Trial ended"
        case .validationOverdue: "License needs checking"
        }
    }
}

private struct LicenseBanner: View {
    @ObservedObject var model: AppModel
    let enterLicense: () -> Void
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(model.license.summary ?? "").font(.headline)
                Text(detail).font(.caption).foregroundStyle(model.license.allowsAccess ? Color.secondary : Color.orange)
                if let error = model.licenseError { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            }
            Spacer()
            if model.license == .validationOverdue {
                Button("Check Now") { Task { await model.checkLicense(force: true) } }.disabled(model.licensing)
            } else {
                if let url = NativeEnvironment.purchaseURL { Button("Buy FDrive") { NSWorkspace.shared.open(url) } }
                Button("Enter License…", action: enterLicense)
            }
        }.padding(12).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
    private var detail: String {
        switch model.license {
        case .trialEnded: "Finder locations are paused. Your files and pending changes are kept."
        case .validationOverdue: "FDrive could not confirm your license for 30 days. Connect to the internet and check again."
        default: "Everything works during the trial. Buy once to keep using FDrive."
        }
    }
}

private struct LicenseEntryView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Enter License").font(.title2.bold())
            Text("Paste the license key from your purchase email.").foregroundStyle(.secondary)
            TextField("License key", text: $key).textFieldStyle(.roundedBorder).onSubmit(activate)
            if let error = model.licenseError { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                if model.licensing { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(model.licensing)
                Button("Activate", action: activate).keyboardShortcut(.defaultAction)
                    .disabled(model.licensing || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 440)
            .interactiveDismissDisabled(model.licensing)
            .onAppear { model.licenseError = nil }
    }
    private func activate() {
        Task { if await model.activateLicense(key) { dismiss() } }
    }
}

private struct TrashRecoveryView: View {
    let location: SavedLocation
    @Environment(\.dismiss) private var dismiss
    @State private var items: [CatalogItem] = []
    @State private var busy = true
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Restore from Trash").font(.title2.bold())
            Text("Items return to the top level of \(location.title). Existing files are preserved.")
                .foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if busy { ProgressView().controlSize(.small) }
            List(items) { item in
                HStack {
                    Image(systemName: item.entry.kind == "dir" ? "folder" : "doc")
                    Text(item.entry.name).lineLimit(2)
                    Spacer()
                    Button("Restore") { Task { await restore(item) } }.disabled(busy)
                }.padding(.vertical, 4)
            }.overlay {
                if items.isEmpty && !busy && error == nil { Text("Trash is empty").foregroundStyle(.secondary) }
            }
            HStack {
                Button("Refresh") { Task { await load() } }.disabled(busy)
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
            }
        }.padding(24).frame(width: 560, height: 380)
            .interactiveDismissDisabled(busy)
            .task { await load() }
    }
    private func load() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let store = try NativeEnvironment.store(), catalog = try store.catalog(location)
            let listing = try await catalog.beginListing(RemoteEntry.trashPath)
            let entries = try await store.client(location).list(RemoteEntry.trashPath)
            try await catalog.reconcile(entries, folder: RemoteEntry.trashPath, listing: listing)
            items = try await catalog.children("trash").sorted { $0.entry.name.localizedStandardCompare($1.entry.name) == .orderedAscending }
        } catch { self.error = error.localizedDescription }
    }
    private func restore(_ item: CatalogItem) async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let store = try NativeEnvironment.store(), catalog = try store.catalog(location)
            _ = try await WriteCoordinator(catalog: catalog, client: store.client(location)).perform(
                route: "moves", localId: item.id, templateKey: item.id, parentId: "root", name: item.entry.name,
                base: WriteVersion(content: item.contentVersion, metadata: item.metadataVersion),
                contents: nil, progress: Progress(totalUnitCount: -1))
            let domain = NSFileProviderDomain(identifier: .init(location.id), displayName: location.title)
            if let manager = NSFileProviderManager(for: domain) {
                for id: NSFileProviderItemIdentifier in [.workingSet, .trashContainer, .rootContainer] {
                    try await manager.signalEnumerator(for: id)
                }
            }
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var locations: [SavedLocation] = []
    @Published var status: [String: String] = [:]
    @Published var error: String?
    @Published var pairing = false
    @Published var pairCode: String?
    @Published var refreshing = false
    /// Framework-side state of each location's domain, refreshed with the location.
    @Published var health: [String: LocationHealth] = [:]
    /// Finder stopped answering signalled enumerators; the server itself is reachable.
    @Published var warnings: [String: String] = [:]
    @Published var license: LicenseState = NativeEnvironment.licenseState()
    @Published var licenseError: String?
    @Published var licensing = false
    private var signalledAt: [String: Date] = [:]
    private var pairingTask: Task<Void, Never>?
    private var licenseWork: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var refreshOperation: Task<Void, Never>?
    private var wakeTask: Task<Void, Never>?
    private var disconnecting = Set<String>()
    private var retryAfter: [String: Date] = [:]
    private var failures: [String: Int] = [:]
    init() {
        do { locations = try NativeEnvironment.store().load() } catch { self.error = error.localizedDescription }
        for location in locations where location.disconnecting { status[location.id] = "Disconnect incomplete — retry" }
        refreshTask = Task { [weak self] in
            await self?.resumePairing()
            while !Task.isCancelled {
                await self?.checkLicense()
                await self?.refresh(automatic: true)
                try? await Task.sleep(for: .seconds(60))
            }
        }
        wakeTask = Task { [weak self] in
            for await _ in NSWorkspace.shared.notificationCenter.notifications(named: NSWorkspace.didWakeNotification) {
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }
    /// Revalidates a purchase when due and notices the trial ending while the app runs.
    func checkLicense(force: Bool = false) async {
        guard let manager = NativeEnvironment.licenseManager(), !(force && licensing) else { return }
        if force { licensing = true; licenseError = nil }
        defer { if force { licensing = false } }
        await serializedLicenseWork {
            // A due check that cannot reach the seller leaves the state as it was.
            let state = (try? await manager.revalidateIfDue(now: Date())) ?? NativeEnvironment.licenseState()
            if force, !state.allowsAccess { self.licenseError = LicenseError.unavailable.localizedDescription }
            await self.applyLicense(state)
        }
    }
    func activateLicense(_ key: String) async -> Bool {
        guard !licensing, let manager = NativeEnvironment.licenseManager() else { return false }
        licensing = true; licenseError = nil
        defer { licensing = false }
        var activated = false
        await serializedLicenseWork {
            do {
                await self.applyLicense(try await manager.activate(key: key, label: Host.current().localizedName ?? "Mac", now: Date()))
                activated = true
            } catch { self.licenseError = error.localizedDescription }
        }
        return activated
    }
    func deactivateLicense() async {
        guard !licensing, let manager = NativeEnvironment.licenseManager() else { return }
        licensing = true; licenseError = nil
        defer { licensing = false }
        await serializedLicenseWork {
            do { await self.applyLicense(try await manager.deactivate(now: Date())) }
            catch { self.error = error.localizedDescription }
        }
    }
    /// The periodic check and the user's own action each read, await the seller and write the
    /// record. Run them one after another so a slow check cannot restore a deactivated key.
    private func serializedLicenseWork(_ work: @escaping @MainActor () async -> Void) async {
        let previous = licenseWork
        let task = Task { await previous?.value; await work() }
        licenseWork = task
        await task.value
    }
    private func applyLicense(_ state: LicenseState) async {
        let changed = license.allowsAccess != state.allowsAccess
        license = state
        guard changed else { return }
        guard state.allowsAccess else {
            // A refresh already under way must not report "Connected" over a paused location.
            refreshOperation?.cancel()
            pauseLocations()
            return
        }
        // macOS held reads and pending edits behind notAuthenticated; let it retry them.
        for location in locations {
            let domain = NSFileProviderDomain(identifier: .init(location.id), displayName: location.title)
            try? await NSFileProviderManager(for: domain)?.signalErrorResolved(NSFileProviderError(.notAuthenticated))
        }
        // Never hold the license sheet open for a full server refresh.
        Task { await refresh() }
    }
    private func pauseLocations() {
        for saved in locations where !saved.disconnecting { status[saved.id] = "Paused · \(license.summary ?? "License required")" }
    }
    func connect(_ address: String) async {
        guard !pairing else { return }
        error = nil; pairing = true
        pairingTask = Task {
            defer { pairing = false; pairCode = nil }
            var pending: (APIClient, Pairing)?
            do {
                guard let url = URL(string: address) else { throw DriveError.invalidServer }
                var client = try APIClient(server: url, protocolVersion: 2)
                let request: Pairing
                do { request = try await client.pair(deviceName: Host.current().localizedName ?? "Mac") }
                catch DriveError.missing {
                    client = try APIClient(server: url)
                    request = try await client.pair(deviceName: Host.current().localizedName ?? "Mac")
                }
                pending = (client, request)
                // Persist before the first poll: a crash after redemption can be resumed.
                try NativeEnvironment.store().savePendingPairing(PendingPairing(server: client.server, pairing: request))
                pairCode = request.code
                var approvalURL = URLComponents(url: client.server.appendingPathComponent("desktop/connect"), resolvingAgainstBaseURL: false)!
                approvalURL.queryItems = [.init(name: "request", value: request.id)]
                guard NSWorkspace.shared.open(approvalURL.url!) else { throw DriveError.server("Could not open the browser.") }
                if try await redeem(client: client, request: request) { pending = nil; await refresh(); return }
                throw DriveError.server("The connection request expired. Connect again.")
            } catch is CancellationError {} catch { self.error = error.localizedDescription }
            if let (client, request) = pending {
                try? NativeEnvironment.store().clearPendingPairing()
                await Task.detached { try? await client.cancel(request) }.value
            }
        }
        await pairingTask?.value
    }
    func cancelPairing() { pairingTask?.cancel() }
    /// Poll until approved, install every credential, then confirm. Returns false on expiry.
    private func redeem(client: APIClient, request: Pairing) async throws -> Bool {
        for _ in 0..<150 {
            try Task.checkCancellation()
            let result = try await client.poll(request)
            if let credentials = result.credentials, result.status == "connected" {
                try Task.checkCancellation()
                refreshOperation?.cancel(); await refreshOperation?.value
                // Once installation starts, retain successful locations if a later one
                // fails. Revoke only the failed credential, never the entire bundle.
                pairCode = nil
                for credential in credentials {
                    do { try await install(credential, server: client.server) }
                    catch {
                        self.error = error.localizedDescription
                        try? await APIClient(server: client.server, token: credential.token, protocolVersion: credential.location.protocolVersion).disconnect()
                    }
                }
                // Confirmation after the Keychain write; an unconfirmed bundle is revoked
                // by the server at expiry, and launch retries this while the record exists.
                do { try await client.confirm(request); try NativeEnvironment.store().clearPendingPairing() }
                catch DriveError.missing { try? NativeEnvironment.store().clearPendingPairing() }
                catch { self.error = "Connected, but the server could not confirm it yet. The app retries at next launch." }
                return true
            }
            try await Task.sleep(for: .seconds(2))
        }
        return false
    }
    /// A crash between redemption and Keychain storage leaves a pending record; finish it.
    private func resumePairing() async {
        guard !pairing, let store = try? NativeEnvironment.store(), let pending = try? store.pendingPairing() else { return }
        if pending.isExpired() { try? store.clearPendingPairing(); return }
        pairing = true
        defer { pairing = false; pairCode = nil }
        do {
            let client = try APIClient(server: pending.server, protocolVersion: 2)
            pairCode = pending.pairing.code
            if try await redeem(client: client, request: pending.pairing) { await refresh() }
            else { try store.clearPendingPairing() }
        } catch DriveError.missing { try? store.clearPendingPairing() }
        catch { self.error = error.localizedDescription }
    }
    func openExtensionSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!)
    }
    private func install(_ credential: Credential, server: URL) async throws {
        let store = try NativeEnvironment.store()
        guard (credential.location.protocolVersion == 1 && credential.location.readOnly) || credential.location.protocolVersion == 2 else { throw DriveError.unsupported }
        let existing = locations.first { $0.server == server && $0.location.identityId == credential.location.identityId && $0.location.accountId == credential.location.accountId }
        if let existing { _ = try existing.updatingMetadata(from: credential.location) }
        let saved = SavedLocation(id: existing?.id ?? UUID().uuidString, server: server, location: credential.location, expiresAt: credential.expiresAt)
        let previous = existing.flatMap { try? store.client($0) }
        let previousToken = existing.flatMap { try? store.token($0.id) }
        let previousLocations = locations
        let domain = NSFileProviderDomain(identifier: .init(saved.id), displayName: saved.title)
        domain.supportsSyncingTrash = credential.location.capabilities?.trash == true
        domain.supportsStringSearchRequest = false
        try store.setToken(credential.token, id: saved.id)
        do {
            locations.removeAll { $0.id == saved.id }; locations.append(saved)
            try store.save(locations)
            try await store.catalog(saved).configure(credential.location.capabilities ?? .none)
            try await NSFileProviderManager.add(domain)
        } catch {
            if existing != nil {
                if let previousToken { try store.setToken(previousToken, id: saved.id) }
                locations = previousLocations
                try store.save(locations)
            } else {
                // Registration may have partially succeeded. Keep a retryable cleanup record.
                if let index = locations.firstIndex(where: { $0.id == saved.id }) { locations[index].disconnecting = true }
                try store.save(locations)
                status[saved.id] = "Connection incomplete — disconnect and retry"
            }
            throw error
        }
        // A resumed pairing re-installs the same bundle; never revoke the token just stored.
        if let previous, previousToken != credential.token { try? await previous.disconnect() }
        status[saved.id] = "Connected"
    }
    func reveal(_ location: SavedLocation) async {
        do {
            let domain = NSFileProviderDomain(identifier: .init(location.id), displayName: location.title)
            guard let manager = NSFileProviderManager(for: domain) else { throw DriveError.unavailable }
            let url = try await manager.getUserVisibleURL(for: .rootContainer)
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            _ = try await NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration())
        } catch { self.error = error.localizedDescription }
    }
    func revealRecovery(_ location: SavedLocation) async {
        do {
            let catalog = try NativeEnvironment.store().catalog(location)
            let pending = try await catalog.pendingWrites().filter { $0.result == nil }
            try FileManager.default.createDirectory(at: catalog.recoveryDirectory, withIntermediateDirectories: true)
            // Human-readable names and errors, never credentials. Payloads remain
            // untouched so opening Recovery cannot discard a pending save.
            let details = pending.map { "\($0.id): \($0.request.name)\n\($0.error ?? "Waiting to upload")\n" }.joined(separator: "\n")
            try details.write(to: catalog.recoveryDirectory.appendingPathComponent("Pending saves.txt"), atomically: true, encoding: .utf8)
            NSWorkspace.shared.open(catalog.recoveryDirectory)
        } catch { self.error = error.localizedDescription }
    }
    func refresh(automatic: Bool = false) async {
        guard !refreshing, !(automatic && pairing) else { return }
        refreshing = true
        let operation = Task { await refreshLocations(automatic: automatic) }
        refreshOperation = operation
        await operation.value
        refreshOperation = nil; refreshing = false
    }
    private func refreshLocations(automatic: Bool) async {
        guard license.allowsAccess else { pauseLocations(); return }
        for saved in locations where !saved.disconnecting {
            if Task.isCancelled { return }
            if automatic, let retry = retryAfter[saved.id], retry > Date() { continue }
            do {
                let store = try NativeEnvironment.store()
                let domainHealth = locationHealth(try await NativeEnvironment.domainState(saved.id))
                health[saved.id] = domainHealth
                guard domainHealth.canRefresh else { status[saved.id] = "Not available in Finder"; continue }
                let client = try store.client(saved)
                let updated = try await refreshLocationMetadata(saved, client: client) {
                    try await NativeEnvironment.updateDomainName($0)
                }
                let current = updated.location
                let catalog = try store.catalog(updated)
                try await catalog.updateRootName(updated.title)
                try await catalog.configure(current.capabilities ?? .none)
                if updated != saved {
                    guard let index = locations.firstIndex(where: { $0.id == saved.id }) else { continue }
                    var next = locations
                    next[index] = updated
                    try store.save(next)
                    locations = next
                }
                // Also upgrade domains registered by older read-only app builds.
                if let domain = try await NSFileProviderManager.domains().first(where: { $0.identifier.rawValue == saved.id }),
                   domain.supportsSyncingTrash != (current.capabilities?.trash == true) {
                    domain.supportsSyncingTrash = current.capabilities?.trash == true
                    try await NSFileProviderManager.add(domain)
                }
                status[saved.id] = "Refreshing"
                // Judge the previous signal now: a healthy daemon answered it long ago.
                let callback = try await catalog.lastCallback()
                if domainHealth == .ready,
                   enumerationStale(lastCallback: callback.at, signalled: signalledAt[saved.id], now: Date()) {
                    warnings[saved.id] = "Finder has not responded to this location's updates. See Troubleshooting in the macOS guide."
                } else { warnings.removeValue(forKey: saved.id) }
                try await refreshCatalog(catalog, client: client) {
                    let domain = NSFileProviderDomain(identifier: .init(updated.id), displayName: updated.title)
                    if let manager = NSFileProviderManager(for: domain) {
                        try await manager.signalEnumerator(for: .workingSet)
                        for folder in try await catalog.folders() {
                            let item = try await catalog.itemAt(folder)
                            try await manager.signalEnumerator(for: NativeEnvironment.id(item.id))
                        }
                    }
                }
                signalledAt[saved.id] = Date()
                let pending = try await catalog.pendingWrites().filter { $0.result == nil }
                status[saved.id] = pending.isEmpty ? (current.readOnly ? current.writeUnavailableReason ?? "Connected · Read-only" : "Connected · Read and write") : "\(pending.count) pending · \(pending.first?.error ?? "Waiting to upload")"
                retryAfter[saved.id] = nil; failures[saved.id] = nil
            } catch {
                if Task.isCancelled { return }
                status[saved.id] = error.localizedDescription
                let count = min((failures[saved.id] ?? 0) + 1, 5)
                failures[saved.id] = count
                retryAfter[saved.id] = Date().addingTimeInterval(min(60 * pow(2, Double(count)), 900))
            }
        }
    }
    func disconnect(_ location: SavedLocation) async {
        guard !pairing, disconnecting.insert(location.id).inserted else { return }
        defer { disconnecting.remove(location.id) }
        refreshOperation?.cancel(); await refreshOperation?.value
        do {
            let store = try NativeEnvironment.store()
            let catalog = try store.catalog(location)
            guard try await catalog.pendingWrites().allSatisfy({ $0.result != nil }) else {
                throw DriveError.server("This location has pending changes. Recover or finish them before disconnecting.")
            }
            let client = try APIClient(server: location.server, token: store.token(location.id), protocolVersion: location.location.protocolVersion)
            // Keep enough state to retry cleanup after network or framework failures.
            if let index = locations.firstIndex(where: { $0.id == location.id }) { locations[index].disconnecting = true }
            try store.save(locations)
            do { try await client.disconnect() } catch DriveError.authentication {} catch DriveError.missing {}
            let domain = NSFileProviderDomain(identifier: .init(location.id), displayName: location.title)
            let preserved = try await NSFileProviderManager.remove(domain, mode: .preserveDirtyUserData)
            if let preserved { NSWorkspace.shared.open(preserved) }
            try store.removeToken(location.id); try store.removeMetadata(location.id)
            locations.removeAll { $0.id == location.id }; try store.save(locations)
            status.removeValue(forKey: location.id)
        } catch { self.error = error.localizedDescription; status[location.id] = "Disconnect incomplete — retry" }
    }
}
