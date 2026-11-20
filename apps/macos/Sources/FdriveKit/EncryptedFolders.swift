import CryptoKit
import Foundation

/// RFC 4648 base32 in lowercase without padding: safe on disks that ignore case.
enum Base32 {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567".utf8)
    static func encode(_ data: Data) -> String {
        var out: [UInt8] = [], buffer: UInt32 = 0, bits = 0
        for byte in data {
            buffer = (buffer << 8) | UInt32(byte); bits += 8
            while bits >= 5 { bits -= 5; out.append(alphabet[Int((buffer >> UInt32(bits)) & 31)]) }
            buffer &= (1 << UInt32(bits)) - 1
        }
        if bits > 0 { out.append(alphabet[Int((buffer << UInt32(5 - bits)) & 31)]) }
        return String(decoding: out, as: UTF8.self)
    }
    /// Nil for any other character, or spare bits that are not zero.
    static func decode(_ text: String) -> Data? {
        var out = Data(), buffer: UInt32 = 0, bits = 0
        for byte in text.utf8 {
            guard let value = alphabet.firstIndex(of: byte) else { return nil }
            buffer = ((buffer << 5) | UInt32(value)) & 0xfff; bits += 5
            if bits >= 8 { bits -= 8; out.append(UInt8((buffer >> UInt32(bits)) & 0xff)) }
        }
        guard bits < 5, buffer & ((1 << UInt32(bits)) - 1) == 0 else { return nil }
        return out
    }
}

/// What opens one encrypted folder: its id, identity and recipient, and its name key.
public struct FolderKey: Sendable {
    public let id: String
    public let identity: AgeIdentity
    public let recipient: AgeRecipient
    /// AES-256-GCM key for names: HKDF-SHA-256 over the identity's scalar.
    public let nameKey: Data
    public init(id: String, identity: AgeIdentity) {
        self.id = id; self.identity = identity; recipient = identity.recipient
        nameKey = EncryptedNames.nameKey(identity)
    }
}

/// A name an encrypted folder cannot hold.
public enum NameError: Error, Sendable, Equatable { case invalid, tooLong }

/// Names inside encrypted folders: `fe1-` and lowercase base32 of a 12-byte nonce and the
/// AES-256-GCM sealed NFC name, bound to the folder's id.
public enum EncryptedNames {
    public static let prefix = "fe1-"
    /// The longest name, in UTF-8 bytes after NFC, whose encrypted form still fits a file name.
    public static let maxBytes = 128
    private static let minChars = Int((Double((12 + 16 + 1) * 8) / 5).rounded(.up))
    private static let maxChars = Int((Double((12 + 16 + maxBytes) * 8) / 5).rounded(.up))

    /// Whether a stored name has the shape of an encrypted name. It cannot tell whether it decrypts.
    public static func isEncrypted(_ name: String) -> Bool {
        guard name.hasPrefix(prefix) else { return false }
        let body = name.utf8.dropFirst(prefix.utf8.count)
        guard (minChars...maxChars).contains(body.count),
              body.allSatisfy({ (97...122).contains($0) || (50...55).contains($0) }) else { return false }
        return [0, 2, 4, 5, 7].contains(body.count % 8)
    }
    static func nameKey(_ identity: AgeIdentity) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: identity.scalar), salt: Data(),
                               info: Data("fdrive/name-key/v1".utf8), outputByteCount: 32)
            .withUnsafeBytes { Data($0) }
    }
    private static func associatedData(_ folderId: String) -> Data { Data("fdrive/name/v1:\(folderId)".utf8) }

    /// A name as an encrypted folder stores it: NFC, one path segment, at most 128 UTF-8 bytes.
    public static func check(_ name: String) throws -> String {
        let normalized = name.precomposedStringWithCanonicalMapping
        guard !["", ".", ".."].contains(normalized), !normalized.contains("/"), !normalized.contains("\0") else {
            throw NameError.invalid
        }
        guard normalized.utf8.count <= maxBytes else { throw NameError.tooLong }
        return normalized
    }
    /// `nonce` is for test vectors only.
    public static func encrypt(_ name: String, key: FolderKey, nonce: Data? = nil) throws -> String {
        let plaintext = Data(try check(name).utf8)
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key.nameKey),
                                      nonce: AES.GCM.Nonce(data: nonce ?? Age.random(12)),
                                      authenticating: associatedData(key.id))
        guard let combined = sealed.combined else { throw NameError.invalid }
        return prefix + Base32.encode(combined)
    }
    /// The clear name, or nil when `stored` is not a name this folder's key made.
    public static func decrypt(_ stored: String, key: FolderKey) -> String? {
        guard isEncrypted(stored), let bytes = Base32.decode(String(stored.dropFirst(prefix.count))),
              let box = try? AES.GCM.SealedBox(combined: bytes),
              let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: key.nameKey),
                                                authenticating: associatedData(key.id)) else { return nil }
        return String(validating: plaintext, as: UTF8.self)
    }
}

/// The contents of `.fdrive-encrypted`, the file at the top of an encrypted folder that holds its keys.
public struct EncryptedFolderMarker: Codable, Sendable, Equatable {
    public struct Member: Codable, Sendable, Equatable {
        /// The member's account recipient.
        public let recipient: String
        /// The folder identity as an age file to `recipient`, base64.
        public let key: String
        public init(recipient: String, key: String) { self.recipient = recipient; self.key = key }
    }
    public let v: Int
    public let id: String
    /// The folder's recipient: every file inside is an age file to it.
    public let recipient: String
    public let members: [Member]
    /// HMAC-SHA-256 over the fields above, keyed from the owner's account identity, base64.
    public let mac: String

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }
    private static let recipientPattern = "^age1[02-9ac-hj-np-z]{58}$"
    /// The shape the contract allows; none of the values then need JSON escaping.
    public func validate() throws {
        guard v == 1, members.count == 1,
              Self.matches(id, "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
              Self.matches(recipient, Self.recipientPattern), Self.matches(mac, "^[A-Za-z0-9+/]{43}=$"),
              members.allSatisfy({ member in
                  Self.matches(member.recipient, Self.recipientPattern) && member.key.utf8.count <= 16_384
                      && Self.matches(member.key, "^[A-Za-z0-9+/]+={0,2}$")
              }) else { throw DecryptError("the folder's marker is not one FDrive reads") }
    }
    /// What the MAC covers: `[v, id, recipient, [[recipient, key], …]]` as compact JSON.
    static func macInput(v: Int, id: String, recipient: String, members: [Member]) -> Data {
        let list = members.map { "[\"\($0.recipient)\",\"\($0.key)\"]" }.joined(separator: ",")
        return Data("[\(v),\"\(id)\",\"\(recipient)\",[\(list)]]".utf8)
    }
    private static func macKey(_ account: AgeIdentity) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: account.scalar), salt: Data(),
                               info: Data("fdrive/marker-mac/v1".utf8), outputByteCount: 32)
    }
    /// A marker with the MAC `account` authenticates it with.
    public static func signed(id: String, recipient: String, members: [Member], account: AgeIdentity) -> Self {
        let mac = HMAC<SHA256>.authenticationCode(for: macInput(v: 1, id: id, recipient: recipient, members: members),
                                                  using: macKey(account))
        return Self(v: 1, id: id, recipient: recipient, members: members, mac: Data(mac).base64EncodedString())
    }
    /// A new encrypted folder's marker and key for `account`.
    public static func create(for account: AgeIdentity) throws -> (marker: Self, folder: FolderKey) {
        let identity = AgeIdentity.generate()
        let id = UUID().uuidString.lowercased()
        let sealed = try Age.encrypt(Data(identity.string.utf8), to: account.recipient).base64EncodedString()
        let marker = signed(id: id, recipient: identity.recipient.string,
                            members: [Member(recipient: account.recipient.string, key: sealed)], account: account)
        return (marker, FolderKey(id: id, identity: identity))
    }
    /// Opens the folder with its owner's account identity. The MAC is checked first, so a
    /// marker the server made, even one wrapped to the owner's public recipient, does not open.
    public func open(with account: AgeIdentity) throws -> FolderKey {
        try validate()
        guard let code = Data(base64Encoded: mac),
              HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Self.macInput(v: v, id: id, recipient: recipient, members: members),
                                                     using: Self.macKey(account)) else {
            throw DriveError.locked(EncryptionLock.foreign)
        }
        let own = account.recipient.string
        guard let member = members.first(where: { $0.recipient == own }), let sealed = Data(base64Encoded: member.key) else {
            throw DriveError.locked(EncryptionLock.foreign)
        }
        let identity = try AgeIdentity(String(decoding: try Age.decrypt(sealed, identity: account), as: UTF8.self))
        guard identity.recipient.string == recipient else { throw DecryptError("the folder's key does not match its recipient") }
        return FolderKey(id: id, identity: identity)
    }
}

/// The encrypted folder a listing is, or is inside: its path on the server and its marker.
public struct EncryptedFolderInfo: Codable, Sendable, Equatable {
    public let path: String
    public let marker: EncryptedFolderMarker
    public init(path: String, marker: EncryptedFolderMarker) { self.path = path; self.marker = marker }
}

/// `GET /api/v2/desktop/encryption`: this Mac's copy of the account key.
public struct DesktopEncryptionKey: Codable, Sendable, Equatable {
    public let recipient: String
    /// The account identity as an age file to this Mac's device recipient, base64.
    public let deviceKey: String
}

/// Why an encrypted folder does not open on this Mac.
public enum EncryptionLock {
    public static let noKey = "Encrypted folders are locked on this Mac. Turn on encryption in fdrive under Settings › Encryption, then choose Reconnect in FDrive."
    public static let unseen = "FDrive has not read this encrypted folder's key yet. Open the folder in Finder, then try again."
    public static let foreign = "This encrypted folder was not made with your key, so FDrive does not open it."
    public static let unlisted = "The server did not say this folder is encrypted, so FDrive does not list it. Choose Refresh, or update fdrive."
}

/// Pairing codes, key fingerprints and this Mac's copy of the account key.
public enum AccountKeys {
    /// 64 bits of a recipient's SHA-256 in uppercase hex, in four groups of four.
    static func keyCode(_ recipient: String) -> String {
        let hex = SHA256.hash(data: Data(recipient.utf8)).prefix(8).map { String(format: "%02X", $0) }.joined()
        return stride(from: 0, to: 16, by: 4).map { start in
            String(hex.dropFirst(start).prefix(4))
        }.joined(separator: "-")
    }
    /// The code a person compares when pairing this Mac: from its device recipient and the
    /// random nonce the server picked for this pairing. The approving browser computes it from
    /// the recipient it encrypts the account key to, so a recipient swapped in shows another code.
    public static func pairingCode(_ deviceRecipient: String, nonce: String) -> String { keyCode(deviceRecipient + "\n" + nonce) }
    /// The fingerprint Settings › Encryption shows for the account key.
    public static func fingerprint(_ accountRecipient: String) -> String { keyCode(accountRecipient) }
    /// The account identity as an age file to a device recipient, base64.
    public static func deviceKey(for account: AgeIdentity, to device: AgeRecipient) throws -> String {
        try Age.encrypt(Data(account.string.utf8), to: device).base64EncodedString()
    }
    /// The account identity from this Mac's device identity, checked against the account's recipient.
    public static func unlock(deviceKey: String, device: AgeIdentity, recipient: String) throws -> AgeIdentity {
        guard let sealed = Data(base64Encoded: deviceKey) else { throw DecryptError("the device key is not base64") }
        let account = try AgeIdentity(String(decoding: try Age.decrypt(sealed, identity: device), as: UTF8.self))
        guard account.recipient.string == recipient else { throw DecryptError("the key does not belong to this account") }
        return account
    }
}

/// The account identity a location's encrypted folders open with, read on first use, and the
/// folder keys opened with it. One per catalog; the extension makes a new one per callback.
public final class EncryptionKeyring: @unchecked Sendable {
    private let load: @Sendable () throws -> AgeIdentity?
    private let lock = NSLock()
    private var loaded = false
    private var account: AgeIdentity?
    private var folders: [String: FolderKey] = [:]
    public init(account load: @escaping @Sendable () throws -> AgeIdentity?) { self.load = load }
    public convenience init(account: AgeIdentity?) { self.init { account } }
    /// This Mac's copy of the account identity, or `DriveError.locked`.
    public func accountIdentity() throws -> AgeIdentity {
        try lock.withLock {
            if !loaded {
                do { account = try load() } catch { throw DriveError.locked(EncryptionLock.noKey) }
                loaded = true
            }
            guard let account else { throw DriveError.locked(EncryptionLock.noKey) }
            return account
        }
    }
    /// The key of the folder `marker` describes, once its MAC proves it is the account's own.
    public func open(_ marker: EncryptedFolderMarker) throws -> FolderKey {
        let cacheKey = marker.id + ":" + marker.mac
        if let known = lock.withLock({ folders[cacheKey] }) { return known }
        let folder = try marker.open(with: accountIdentity())
        lock.withLock { folders[cacheKey] = folder }
        return folder
    }
}

/// The name Finder shows for an item in Trash, as the server names it: unique by its handle,
/// with its extension kept.
func trashDisplayName(_ name: String, handle: String) -> String {
    let dot = name.lastIndex(of: ".").flatMap { $0 == name.startIndex ? nil : $0 }
    var suffixExtension = dot.map { String(name[$0...]) } ?? ""
    while suffixExtension.utf8.count > 64 { suffixExtension.removeLast() }
    let suffix = " (deleted \(handle.prefix(8)))" + suffixExtension
    var stem = dot.map { String(name[..<$0]) } ?? name
    while (stem + suffix).utf8.count > 255 { stem.removeLast() }
    return stem + suffix
}

/// A Finder name with a numbered suffix before its extension, for the `n`th entry of that name.
func numberedName(_ name: String, _ number: Int) -> String {
    let base = name as NSString
    let ext = base.pathExtension
    let stem = ext.isEmpty || base.deletingPathExtension.isEmpty ? name : base.deletingPathExtension
    return stem + " (\(number))" + (stem == name ? "" : "." + ext)
}

/// Eight hex digits of a name's SHA-256: a stable, distinct placeholder for a name that does not decrypt.
func shortHash(_ name: String) -> String {
    SHA256.hash(data: Data(name.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
}

/// Whether Finder can show a decrypted name as it is.
func finderCanShow(_ name: String) -> Bool {
    !name.isEmpty && name.utf8.count <= 255 && ![".", ".."].contains(name) && !name.contains("/") && !name.contains(":")
        && !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}
