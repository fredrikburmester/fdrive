import Foundation
import Testing
@testable import FdriveKit

private func writeBundle(_ bundle: URL, info: [String: Any]) throws {
    let contents = bundle.appending(path: "Contents")
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        .write(to: contents.appending(path: "Info.plist"))
}
private func info(_ version: String, _ build: String) -> [String: Any] {
    ["CFBundleShortVersionString": version, "CFBundleVersion": build, "CFBundleIdentifier": "se.burmester.fdrive.mac"]
}

@Test func installedBuildReadsTheBundleThatReplacedTheRunningOne() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let bundle = directory.appending(path: "FDrive.app")
    try writeBundle(bundle, info: info("0.4.2", "11"))
    #expect(AppBuild.installed(at: bundle) == AppBuild(version: "0.4.2", build: "11"))
    // Homebrew removes the old bundle and moves the new one to the same path.
    try FileManager.default.removeItem(at: bundle)
    #expect(AppBuild.installed(at: bundle) == nil)
    try writeBundle(bundle, info: info("0.4.3", "12"))
    #expect(AppBuild.installed(at: bundle) == AppBuild(version: "0.4.3", build: "12"))
}

@Test func installedBuildIgnoresUnreadableInfo() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let bundle = directory.appending(path: "FDrive.app")
    try writeBundle(bundle, info: ["CFBundleShortVersionString": "0.4.3"])
    #expect(AppBuild.installed(at: bundle) == nil)
    try Data("not a plist".utf8).write(to: bundle.appending(path: "Contents/Info.plist"))
    #expect(AppBuild.installed(at: bundle) == nil)
    #expect(AppBuild(info: ["CFBundleShortVersionString": 4, "CFBundleVersion": "12"]) == nil)
}

@Test func updateWatchRestartsOnlyAfterTheSameNewBuildIsSeenTwice() {
    let running = AppBuild(version: "0.4.2", build: "11")
    let next = AppBuild(version: "0.4.3", build: "12")
    var watch = UpdateWatch(running: running)
    #expect(watch.check(installed: running) == nil)
    #expect(watch.check(installed: next) == nil)
    #expect(watch.check(installed: next) == next)
    // A restart the app defers stays due on every later check.
    #expect(watch.check(installed: next) == next)
}

@Test func updateWatchStartsOverWhenTheInstalledCopyKeepsChanging() {
    let running = AppBuild(version: "0.4.2", build: "11")
    let next = AppBuild(version: "0.4.3", build: "12")
    let later = AppBuild(version: "0.4.4", build: "13")
    var watch = UpdateWatch(running: running)
    #expect(watch.check(installed: next) == nil)
    #expect(watch.check(installed: later) == nil)
    #expect(watch.check(installed: later) == later)
    // Mid-copy the bundle is missing; a missing or reverted copy is never a restart target.
    var copying = UpdateWatch(running: running)
    #expect(copying.check(installed: next) == nil)
    #expect(copying.check(installed: nil) == nil)
    #expect(copying.check(installed: next) == nil)
    #expect(copying.check(installed: running) == nil)
    #expect(copying.check(installed: running) == nil)
    // A downgrade replaces the running code too.
    var downgrade = UpdateWatch(running: next)
    #expect(downgrade.check(installed: running) == nil)
    #expect(downgrade.check(installed: running) == running)
}

@Test func relaunchMarkerKeepsTheWindowStateForOneRecentLaunch() {
    let suite = "fdrive-tests-\(UUID().uuidString)"
    defer { UserDefaults().removePersistentDomain(forName: suite) }
    let marker = RelaunchMarker(suite: suite)
    let now = Date()
    #expect(marker.takeShowsLocations(now: now))
    marker.save(showingLocations: false, now: now)
    #expect(!marker.takeShowsLocations(now: now.addingTimeInterval(5)))
    #expect(marker.takeShowsLocations(now: now.addingTimeInterval(6)))
    marker.save(showingLocations: true, now: now)
    #expect(marker.takeShowsLocations(now: now.addingTimeInterval(5)))
    // A restart that never happened must not hide the window at a later, ordinary launch.
    marker.save(showingLocations: false, now: now)
    #expect(marker.takeShowsLocations(now: now.addingTimeInterval(RelaunchMarker.lifetime + 1)))
    marker.save(showingLocations: false, now: now)
    marker.clear()
    #expect(marker.takeShowsLocations(now: now))
}
