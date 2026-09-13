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
        }.defaultSize(width: 600, height: 460)
            .defaultLaunchBehavior(.presented)
            .restorationBehavior(.disabled)
        MenuBarExtra("FDrive", systemImage: "externaldrive.badge.icloud") {
            MenuContents(model: model)
        }
    }
}

private struct MenuContents: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
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
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Image(systemName: "externaldrive.badge.icloud").font(.largeTitle).foregroundStyle(.secondary)
                VStack(alignment: .leading) {
                    Text("FDrive").font(.title.bold())
                    Text("Your files in Finder, downloaded when needed.").foregroundStyle(.secondary)
                }
                Spacer()
                if model.refreshing { ProgressView().controlSize(.small) }
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
                            Text(location.title).font(.headline)
                            Text(model.status[location.id] ?? "Connected").font(.caption).foregroundStyle(.secondary)
                            if let expires = location.expiresAt { Text("Connection expires \(expires.prefix(10))").font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Button("Open") { Task { await model.reveal(location) } }.buttonStyle(.borderless).accessibilityLabel("Open in Finder")
                        Menu {
                            Button("Refresh") { Task { await model.refresh() } }
                            Button("Reconnect") { address = location.server.absoluteString; Task { await model.connect(address) } }
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
                Text("Read-only · macOS 26+").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(24)
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
    private var pairingTask: Task<Void, Never>?
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
            while !Task.isCancelled {
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
    func connect(_ address: String) async {
        guard !pairing else { return }
        error = nil; pairing = true
        pairingTask = Task {
            defer { pairing = false; pairCode = nil }
            var pending: (APIClient, Pairing)?
            do {
                guard let url = URL(string: address) else { throw DriveError.invalidServer }
                let client = try APIClient(server: url)
                let request = try await client.pair(deviceName: Host.current().localizedName ?? "Mac")
                pending = (client, request)
                pairCode = request.code
                var approvalURL = URLComponents(url: client.server.appendingPathComponent("desktop/connect"), resolvingAgainstBaseURL: false)!
                approvalURL.queryItems = [.init(name: "request", value: request.id)]
                guard NSWorkspace.shared.open(approvalURL.url!) else { throw DriveError.server("Could not open the browser.") }
                for _ in 0..<150 {
                    try Task.checkCancellation()
                    let result = try await client.poll(request)
                    if let credentials = result.credentials, result.status == "connected" {
                        try Task.checkCancellation()
                        refreshOperation?.cancel(); await refreshOperation?.value
                        // Once installation starts, retain successful locations if a later one
                        // fails. Revoke only the failed credential, never the entire bundle.
                        pairCode = nil
                        pending = nil
                        for credential in credentials {
                            do { try await install(credential, server: client.server) }
                            catch {
                                self.error = error.localizedDescription
                                try? await APIClient(server: client.server, token: credential.token).disconnect()
                            }
                        }
                        await refresh(); return
                    }
                    try await Task.sleep(for: .seconds(2))
                }
                throw DriveError.server("The connection request expired. Connect again.")
            } catch is CancellationError {} catch { self.error = error.localizedDescription }
            if let (client, request) = pending {
                await Task.detached { try? await client.cancel(request) }.value
            }
        }
        await pairingTask?.value
    }
    func cancelPairing() { pairingTask?.cancel() }
    private func install(_ credential: Credential, server: URL) async throws {
        let store = try NativeEnvironment.store()
        guard credential.location.protocolVersion == 1, credential.location.readOnly else { throw DriveError.unsupported }
        let existing = locations.first { $0.server == server && $0.location.identityId == credential.location.identityId && $0.location.accountId == credential.location.accountId }
        let saved = SavedLocation(id: existing?.id ?? UUID().uuidString, server: server, location: credential.location, expiresAt: credential.expiresAt)
        let previous = existing.flatMap { try? store.client($0) }
        let previousToken = existing.flatMap { try? store.token($0.id) }
        let previousLocations = locations
        let domain = NSFileProviderDomain(identifier: .init(saved.id), displayName: saved.title)
        domain.supportsSyncingTrash = false
        domain.supportsStringSearchRequest = false
        try store.setToken(credential.token, id: saved.id)
        do {
            locations.removeAll { $0.id == saved.id }; locations.append(saved)
            try store.save(locations)
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
        if let previous { try? await previous.disconnect() }
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
    func refresh(automatic: Bool = false) async {
        guard !refreshing, !(automatic && pairing) else { return }
        refreshing = true
        let operation = Task { await refreshLocations(automatic: automatic) }
        refreshOperation = operation
        await operation.value
        refreshOperation = nil; refreshing = false
    }
    private func refreshLocations(automatic: Bool) async {
        for saved in locations where !saved.disconnecting {
            if Task.isCancelled { return }
            if automatic, let retry = retryAfter[saved.id], retry > Date() { continue }
            do {
                let store = try NativeEnvironment.store()
                let client = try store.client(saved)
                _ = try await client.location()
                let catalog = try store.catalog(saved)
                status[saved.id] = "Refreshing"
                try await refreshCatalog(catalog, client: client) {
                    let domain = NSFileProviderDomain(identifier: .init(saved.id), displayName: saved.title)
                    if let manager = NSFileProviderManager(for: domain) {
                        try await manager.signalEnumerator(for: .workingSet)
                        for folder in try await catalog.folders() {
                            let item = try await catalog.itemAt(folder)
                            try await manager.signalEnumerator(for: NativeEnvironment.id(item.id))
                        }
                    }
                }
                status[saved.id] = "Connected · Read-only"
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
            let client = try APIClient(server: location.server, token: store.token(location.id))
            // Keep enough state to retry cleanup after network or framework failures.
            if let index = locations.firstIndex(where: { $0.id == location.id }) { locations[index].disconnecting = true }
            try store.save(locations)
            do { try await client.disconnect() } catch DriveError.authentication {} catch DriveError.missing {}
            let domain = NSFileProviderDomain(identifier: .init(location.id), displayName: location.title)
            try await NSFileProviderManager.remove(domain)
            try store.removeToken(location.id); try store.removeMetadata(location.id)
            locations.removeAll { $0.id == location.id }; try store.save(locations)
            status.removeValue(forKey: location.id)
        } catch { self.error = error.localizedDescription; status[location.id] = "Disconnect incomplete — retry" }
    }
}
