import Foundation
import Testing
@testable import FdriveKit

/// packages/crypto/vectors, from this file: apps/macos/Tests/FdriveKitTests → the repository root.
private let vectorsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../../../packages/crypto/vectors").standardizedFileURL

private struct Vectors: Decodable {
    struct AgeFiles: Decodable {
        struct File: Decodable { let length: Int; let ciphertext: String; let size: Int64 }
        let identity: String
        let recipient: String
        let files: [File]
    }
    struct Folder: Decodable {
        struct Name: Decodable { let name: String; let nonce: String; let stored: String }
        let accountIdentity: String
        let marker: EncryptedFolderMarker
        let identity: String
        let nameKey: String
        let names: [Name]
    }
    struct Device: Decodable {
        let identity: String
        let recipient: String
        let pairingNonce: String
        let pairingCode: String
        let accountRecipient: String
        let accountFingerprint: String
        let deviceKey: String
    }
    let age: AgeFiles
    let folder: Folder
    let device: Device
}

private func vectors() throws -> Vectors {
    try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: vectorsDirectory.appendingPathComponent("v1.json")))
}
/// The vectors' plaintext: byte i is i % 251.
func vectorPattern(_ length: Int) -> Data { Data((0..<length).map { UInt8($0 % 251) }) }
private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
private func fromHex(_ text: String) -> Data {
    Data(stride(from: 0, to: text.count, by: 2).map { UInt8(text.dropFirst($0).prefix(2), radix: 16)! })
}

@Suite struct EncryptionVectorTests {
    @Test func everyAgeFileDecryptsToItsPlaintextAtThePredictedSize() throws {
        let vectors = try vectors()
        let identity = try AgeIdentity(vectors.age.identity)
        #expect(identity.recipient.string == vectors.age.recipient)
        #expect(identity.string == vectors.age.identity)
        for file in vectors.age.files {
            let ciphertext = try #require(Data(base64Encoded: file.ciphertext))
            #expect(Int64(ciphertext.count) == file.size)
            #expect(Age.encryptedSize(Int64(file.length)) == file.size)
            #expect(Age.decryptedSize(file.size) == Int64(file.length))
            #expect(try Age.decrypt(ciphertext, identity: identity) == vectorPattern(file.length))
        }
    }

    @Test func theMarkerOpensWithTheAccountAndReproducesItsNameKeyAndNames() throws {
        let vectors = try vectors()
        let folder = try vectors.folder.marker.open(with: AgeIdentity(vectors.folder.accountIdentity))
        #expect(folder.identity.string == vectors.folder.identity)
        #expect(folder.id == vectors.folder.marker.id)
        #expect(hex(folder.nameKey) == vectors.folder.nameKey)
        for entry in vectors.folder.names {
            #expect(try EncryptedNames.encrypt(entry.name, key: folder, nonce: fromHex(entry.nonce)) == entry.stored)
            let clear = try #require(EncryptedNames.decrypt(entry.stored, key: folder))
            // Code units, not canonical equivalence: the stored name is the NFC one.
            #expect(Array(clear.unicodeScalars) == Array(entry.name.precomposedStringWithCanonicalMapping.unicodeScalars))
            #expect(EncryptedNames.isEncrypted(entry.stored))
        }
    }

    @Test func theDeviceKeyUnlocksTheAccountAndCodesMatch() throws {
        let device = try vectors().device
        let identity = try AgeIdentity(device.identity)
        #expect(identity.recipient.string == device.recipient)
        #expect(AccountKeys.pairingCode(device.recipient, nonce: device.pairingNonce) == device.pairingCode)
        #expect(AccountKeys.pairingCode(device.recipient, nonce: device.pairingNonce + "x") != device.pairingCode)
        #expect(AccountKeys.fingerprint(device.accountRecipient) == device.accountFingerprint)
        let account = try AccountKeys.unlock(deviceKey: device.deviceKey, device: identity, recipient: device.accountRecipient)
        #expect(account.string == (try vectors().folder.accountIdentity))
        #expect(throws: DecryptError.self) {
            try AccountKeys.unlock(deviceKey: device.deviceKey, device: identity, recipient: device.recipient)
        }
    }

    @Test func aMarkerSignedByAnotherAccountDoesNotOpen() throws {
        let vectors = try vectors()
        #expect(throws: DriveError.locked(EncryptionLock.foreign)) {
            try vectors.folder.marker.open(with: AgeIdentity.generate())
        }
        let account = try AgeIdentity(vectors.folder.accountIdentity)
        // The server can wrap a folder key of its own to the public account recipient, but cannot MAC it.
        let forged = try EncryptedFolderMarker.create(for: AgeIdentity.generate()).marker
        let swapped = EncryptedFolderMarker(v: 1, id: vectors.folder.marker.id, recipient: forged.recipient,
            members: [.init(recipient: account.recipient.string,
                            key: try Age.encrypt(Data(AgeIdentity.generate().string.utf8), to: account.recipient).base64EncodedString())],
            mac: vectors.folder.marker.mac)
        #expect(throws: DriveError.locked(EncryptionLock.foreign)) { try swapped.open(with: account) }
    }

    /// Writes what FdriveKit makes from the vectors' keys, for packages/crypto to open:
    /// `FDRIVE_WRITE_SWIFT_VECTORS=1 swift test --package-path apps/macos`.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["FDRIVE_WRITE_SWIFT_VECTORS"] == "1"))
    func writeSwiftVectors() throws {
        let vectors = try vectors()
        let account = try AgeIdentity(vectors.folder.accountIdentity)
        let folder = try vectors.folder.marker.open(with: account)
        let length = 70_000
        let ciphertext = try Age.encrypt(vectorPattern(length), to: AgeRecipient(vectors.age.recipient))
        let names = ["a", "Kvitton 2026.pdf", "Mo\u{308}te.txt", "日本語のファイル名.txt", "🙂 emoji.png",
                     String(repeating: "å", count: 64), ".hidden"]
            .map { $0.precomposedStringWithCanonicalMapping }
        let marker = try EncryptedFolderMarker.create(for: account).marker
        let deviceKey = try AccountKeys.deviceKey(for: account, to: AgeRecipient(vectors.device.recipient))
        struct Written: Encodable {
            struct Name: Encodable { let name: String; let stored: String }
            let ciphertext: String; let length: Int; let names: [Name]; let marker: EncryptedFolderMarker; let deviceKey: String
        }
        let written = Written(ciphertext: ciphertext.base64EncodedString(), length: length,
                              names: try names.map { Written.Name(name: $0, stored: try EncryptedNames.encrypt($0, key: folder)) },
                              marker: marker, deviceKey: deviceKey)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try (encoder.encode(written) + Data("\n".utf8)).write(to: vectorsDirectory.appendingPathComponent("v1-swift.json"))
    }
}
