import CryptoKit
import Foundation
import Security

/// A key or age file that does not open what it was given, or a file that is not a well-formed one.
public struct DecryptError: Error, LocalizedError, Sendable, Equatable {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
    public var errorDescription: String? { "This encrypted item could not be decrypted: \(reason)." }
}

/// Bech32 (BIP 173) without the 90-character limit, as age encodes its keys.
enum Bech32 {
    private static let charset = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l".utf8)
    private static func polymod(_ values: [UInt8]) -> UInt32 {
        let generator: [UInt32] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
        var checksum: UInt32 = 1
        for value in values {
            let top = checksum >> 25
            checksum = (checksum & 0x1ffffff) << 5 ^ UInt32(value)
            for index in 0..<5 where (top >> index) & 1 == 1 { checksum ^= generator[index] }
        }
        return checksum
    }
    private static func expand(_ hrp: [UInt8]) -> [UInt8] { hrp.map { $0 >> 5 } + [0] + hrp.map { $0 & 31 } }
    private static func regroup(_ data: [UInt8], from: Int, to: Int, pad: Bool) -> [UInt8]? {
        var accumulator: UInt32 = 0, bits = 0, out: [UInt8] = []
        let mask = UInt32(1 << to) - 1, limit = UInt32(1 << (from + to - 1)) - 1
        for value in data {
            guard Int(value) >> from == 0 else { return nil }
            accumulator = ((accumulator << UInt32(from)) | UInt32(value)) & limit
            bits += from
            while bits >= to { bits -= to; out.append(UInt8((accumulator >> UInt32(bits)) & mask)) }
        }
        if pad {
            if bits > 0 { out.append(UInt8((accumulator << UInt32(to - bits)) & mask)) }
        } else if bits >= from || (accumulator << UInt32(to - bits)) & mask != 0 {
            return nil
        }
        return out
    }
    /// Lowercase bech32 of `data` under `hrp`.
    static func encode(hrp: String, data: Data) -> String {
        let prefix = Array(hrp.utf8)
        let values = regroup(Array(data), from: 8, to: 5, pad: true) ?? []
        let checksum = polymod(expand(prefix) + values + [0, 0, 0, 0, 0, 0]) ^ 1
        let check = (0..<6).map { UInt8((checksum >> UInt32(5 * (5 - $0))) & 31) }
        return hrp + "1" + String(decoding: (values + check).map { charset[Int($0)] }, as: UTF8.self)
    }
    /// The lowercase prefix and the bytes, or nil for anything but one well-formed string in one case.
    static func decode(_ text: String) -> (hrp: String, data: Data)? {
        let bytes = Array(text.utf8)
        guard bytes.allSatisfy({ (33...126).contains($0) }) else { return nil }
        let lower = bytes.contains(where: { (97...122).contains($0) })
        let upper = bytes.contains(where: { (65...90).contains($0) })
        guard !(lower && upper) else { return nil }
        let folded = bytes.map { (65...90).contains($0) ? $0 + 32 : $0 }
        guard let separator = folded.lastIndex(of: UInt8(ascii: "1")), separator >= 1, separator + 7 <= folded.count else { return nil }
        let hrp = Array(folded[..<separator])
        var values: [UInt8] = []
        for byte in folded[(separator + 1)...] {
            guard let value = charset.firstIndex(of: byte) else { return nil }
            values.append(UInt8(value))
        }
        guard polymod(expand(hrp) + values) == 1,
              let data = regroup(Array(values.dropLast(6)), from: 5, to: 8, pad: false) else { return nil }
        return (String(decoding: hrp, as: UTF8.self), Data(data))
    }
}

/// An age X25519 recipient, `age1…`: the public half of an identity.
public struct AgeRecipient: Sendable, Hashable {
    public let key: Data
    public init(_ text: String) throws {
        guard let decoded = Bech32.decode(text), decoded.hrp == "age", decoded.data.count == 32 else {
            throw DecryptError("not an age recipient")
        }
        key = decoded.data
    }
    init(key: Data) { self.key = key }
    public var string: String { Bech32.encode(hrp: "age", data: key) }
}

/// An age X25519 identity, `AGE-SECRET-KEY-1…`.
public struct AgeIdentity: Sendable, Equatable {
    /// The 32 random bytes the identity encodes, as age stores them (unclamped).
    public let scalar: Data
    public init(_ text: String) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let decoded = Bech32.decode(trimmed), decoded.hrp == "age-secret-key-", decoded.data.count == 32 else {
            throw DecryptError("not an age identity")
        }
        scalar = decoded.data
    }
    public init(scalar: Data) throws {
        guard scalar.count == 32 else { throw DecryptError("not an age identity") }
        self.scalar = scalar
    }
    public static func generate() -> AgeIdentity {
        try! AgeIdentity(scalar: Curve25519.KeyAgreement.PrivateKey().rawRepresentation)
    }
    public var string: String { Bech32.encode(hrp: "age-secret-key-", data: scalar).uppercased() }
    var privateKey: Curve25519.KeyAgreement.PrivateKey {
        // Any 32 bytes are a valid X25519 scalar; CryptoKit clamps it as age does.
        try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: scalar)
    }
    public var recipient: AgeRecipient { AgeRecipient(key: privateKey.publicKey.rawRepresentation) }
}

/// SHA-256 and length of a stream of bytes.
public struct ContentDigest: Sendable, Equatable {
    public let sha256: String
    public let size: Int64
}

/// Hashes bytes as they pass.
struct DigestCounter {
    private var hash = SHA256()
    private(set) var size: Int64 = 0
    mutating func update(_ data: Data) { hash.update(data: data); size += Int64(data.count) }
    func finalize() -> ContentDigest {
        ContentDigest(sha256: hash.finalize().map { String(format: "%02x", $0) }.joined(), size: size)
    }
}

/// Bytes read on demand from a stream, with the look-ahead the age header and payload need.
private struct ByteSource {
    let read: (Int) throws -> Data
    var buffer = Data()
    var ended = false
    var consumed = 0
    /// Up to `count` bytes; fewer only at the end of the stream.
    mutating func take(_ count: Int) throws -> Data {
        while buffer.count < count && !ended {
            let more = try read(count - buffer.count)
            if more.isEmpty { ended = true } else { buffer.append(more) }
        }
        let taken = Data(buffer.prefix(count))
        buffer = Data(buffer.dropFirst(taken.count))
        consumed += taken.count
        return taken
    }
    /// One header line without its newline; nil at the end of the stream.
    mutating func line(limit: Int) throws -> Data? {
        var line = Data()
        while true {
            if let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                line.append(buffer[buffer.startIndex..<newline])
                let length = newline - buffer.startIndex + 1
                buffer = Data(buffer.dropFirst(length))
                consumed += length
                guard line.count <= limit else { throw DecryptError("the header is too long") }
                return line
            }
            line.append(buffer)
            consumed += buffer.count
            buffer = Data()
            guard line.count <= limit else { throw DecryptError("the header is too long") }
            guard !ended else { return nil }
            let more = try read(4096)
            if more.isEmpty { ended = true } else { buffer = more }
        }
    }
}

/// The subset of age v1 (age-encryption.org/v1) fdrive uses: X25519 recipients and the STREAM payload.
/// Files written here have exactly one X25519 stanza; any age file to the identity opens.
public enum Age {
    public static let chunkSize = 64 * 1024
    static let tagSize = 16
    /// The header of a file with one X25519 recipient, plus the 16-byte payload nonce.
    static let x25519Overhead: Int64 = 168 + 16
    static let headerLine = Data("age-encryption.org/v1".utf8)
    private static let x25519Info = Data("age-encryption.org/v1/X25519".utf8)
    private static let headerLimit = 256 * 1024

    /// The size of a file of `plaintext` bytes encrypted to one X25519 recipient.
    public static func encryptedSize(_ plaintext: Int64) -> Int64 {
        let chunks = plaintext == 0 ? 1 : (plaintext + Int64(chunkSize) - 1) / Int64(chunkSize)
        return x25519Overhead + plaintext + chunks * Int64(tagSize)
    }
    /// The plaintext size of a file encrypted to one X25519 recipient; nil when it cannot be one.
    public static func decryptedSize(_ ciphertext: Int64) -> Int64? {
        let payload = ciphertext - x25519Overhead
        guard payload >= Int64(tagSize) else { return nil }
        let full = Int64(chunkSize + tagSize)
        let chunks = (payload + full - 1) / full
        let size = payload - chunks * Int64(tagSize)
        guard size >= 0, encryptedSize(size) == ciphertext else { return nil }
        return size
    }

    static func random(_ count: Int) -> Data {
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        precondition(status == errSecSuccess, "The system random number generator failed.")
        return data
    }
    static func hkdf(_ secret: Data, salt: Data, info: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: salt, info: Data(info.utf8), outputByteCount: 32)
    }
    static func base64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "=", with: "") }
    /// Canonical unpadded standard base64, as age requires: no padding, no stray bits, nothing else.
    static func unbase64(_ text: Data) -> Data? {
        guard text.allSatisfy({ byte in
            (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || byte == 43 || byte == 47
        }), text.count % 4 != 1 else { return nil }
        let string = String(decoding: text, as: UTF8.self)
        let padded = string + String(repeating: "=", count: (4 - string.count % 4) % 4)
        guard let data = Data(base64Encoded: padded), base64(data) == string else { return nil }
        return data
    }
    private static let zeroNonce = try! ChaChaPoly.Nonce(data: Data(count: 12))
    private static func chunkNonce(_ counter: UInt64, last: Bool) -> ChaChaPoly.Nonce {
        var bytes = Data(count: 3)
        withUnsafeBytes(of: counter.bigEndian) { bytes.append(contentsOf: $0) }
        bytes.append(last ? 1 : 0)
        return try! ChaChaPoly.Nonce(data: bytes)
    }
    private static func agreement(_ key: Curve25519.KeyAgreement.PrivateKey, _ share: Data) throws -> SharedSecret {
        guard let point = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: share),
              let secret = try? key.sharedSecretFromKeyAgreement(with: point),
              !secret.withUnsafeBytes({ $0.allSatisfy { $0 == 0 } }) else {
            throw DecryptError("the file's key share is invalid")
        }
        return secret
    }

    /// The header for a new file key: one X25519 stanza to `recipient`, and the header MAC.
    static func header(fileKey: Data, recipient: AgeRecipient) throws -> Data {
        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        let share = ephemeral.publicKey.rawRepresentation
        let secret = try agreement(ephemeral, recipient.key)
        let wrapKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: share + recipient.key,
                                                     sharedInfo: x25519Info, outputByteCount: 32)
        let sealed = try ChaChaPoly.seal(fileKey, using: wrapKey, nonce: zeroNonce)
        let body = base64(sealed.ciphertext + sealed.tag)
        var text = "age-encryption.org/v1\n-> X25519 \(base64(share))\n"
        var lines = stride(from: 0, to: body.count, by: 64).map { start in
            String(body.dropFirst(start).prefix(64))
        }
        if body.count % 64 == 0 { lines.append("") }
        text += lines.map { $0 + "\n" }.joined() + "---"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: hkdf(fileKey, salt: Data(), info: "header"))
        return Data((text + " " + base64(Data(mac)) + "\n").utf8)
    }

    private struct Stanza { let arguments: [String]; let body: Data }

    /// Reads and checks the header, and returns the file key it wraps for `identity`.
    private static func openHeader(_ source: inout ByteSource, identity: AgeIdentity) throws -> Data {
        guard (try? source.line(limit: 64)) == headerLine else { throw DecryptError("it is not an age file") }
        var authenticated = headerLine + Data("\n".utf8)
        var stanzas: [Stanza] = []
        let mac: Data
        while true {
            guard source.consumed <= headerLimit else { throw DecryptError("the header is too long") }
            guard let line = try source.line(limit: 64 * 1024) else { throw DecryptError("the file ends in its header") }
            guard line.allSatisfy({ (32...126).contains($0) }) else { throw DecryptError("the header is malformed") }
            if line.starts(with: Data("---".utf8)) {
                guard line.count == 47, line.starts(with: Data("--- ".utf8)),
                      let value = unbase64(line.suffix(43)), value.count == 32 else { throw DecryptError("the header is malformed") }
                authenticated += Data("---".utf8)
                mac = value
                break
            }
            guard line.starts(with: Data("-> ".utf8)) else { throw DecryptError("the header is malformed") }
            let arguments = line.dropFirst(3).split(separator: UInt8(ascii: " "), omittingEmptySubsequences: false)
                .map { String(decoding: $0, as: UTF8.self) }
            guard !arguments.isEmpty, arguments.allSatisfy({ !$0.isEmpty }) else { throw DecryptError("the header is malformed") }
            authenticated += line + Data("\n".utf8)
            var text = Data()
            while true {
                guard let bodyLine = try source.line(limit: 64) else { throw DecryptError("the file ends in its header") }
                authenticated += bodyLine + Data("\n".utf8)
                text += bodyLine
                if bodyLine.count < 64 { break }
            }
            guard let body = unbase64(text) else { throw DecryptError("the header is malformed") }
            stanzas.append(Stanza(arguments: arguments, body: body))
        }
        var fileKey: Data?
        let key = identity.privateKey, own = identity.recipient.key
        for stanza in stanzas where stanza.arguments[0] == "X25519" {
            guard stanza.arguments.count == 2, let share = unbase64(Data(stanza.arguments[1].utf8)), share.count == 32,
                  stanza.body.count == 32 else { throw DecryptError("the header is malformed") }
            let secret = try agreement(key, share)
            let wrapKey = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: share + own,
                                                         sharedInfo: x25519Info, outputByteCount: 32)
            guard let box = try? ChaChaPoly.SealedBox(nonce: zeroNonce, ciphertext: stanza.body.prefix(16), tag: stanza.body.suffix(16)),
                  let opened = try? ChaChaPoly.open(box, using: wrapKey) else { continue }
            fileKey = opened
            break
        }
        guard let fileKey else { throw DecryptError("it is not encrypted to this key") }
        guard HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: authenticated,
                                                     using: hkdf(fileKey, salt: Data(), info: "header")) else {
            throw DecryptError("its header was changed")
        }
        return fileKey
    }

    /// Encrypts a stream to `recipient`. `read(n)` returns up to `n` bytes, fewer only at the
    /// end; memory stays at two chunks whatever the size.
    public static func encrypt(read: (Int) throws -> Data, write: (Data) throws -> Void, to recipient: AgeRecipient) throws {
        let fileKey = random(16)
        try write(header(fileKey: fileKey, recipient: recipient))
        let nonce = random(16)
        try write(nonce)
        let key = hkdf(fileKey, salt: nonce, info: "payload")
        var counter: UInt64 = 0
        var current = try read(chunkSize)
        var done = false
        while !done {
            try Task.checkCancellation()
            try autoreleasepool {
                var next = Data()
                var last = current.count < chunkSize
                if !last { next = try read(chunkSize); last = next.isEmpty }
                let sealed = try ChaChaPoly.seal(current, using: key, nonce: chunkNonce(counter, last: last))
                try write(sealed.ciphertext + sealed.tag)
                if last { done = true } else { current = next; counter += 1 }
            }
        }
    }

    /// Decrypts a stream with `identity`, refusing a malformed header, a changed or reordered
    /// chunk and a file cut short. Bytes are written as each chunk is authenticated.
    public static func decrypt(read: @escaping (Int) throws -> Data, write: (Data) throws -> Void, identity: AgeIdentity) throws {
        var source = ByteSource(read: read)
        let fileKey = try openHeader(&source, identity: identity)
        let nonce = try source.take(16)
        guard nonce.count == 16 else { throw DecryptError("the file is cut short") }
        let key = hkdf(fileKey, salt: nonce, info: "payload")
        let full = chunkSize + tagSize
        var counter: UInt64 = 0
        var chunk = try source.take(full)
        var done = false
        while !done {
            try Task.checkCancellation()
            try autoreleasepool {
                guard chunk.count >= tagSize else { throw DecryptError("the file is cut short") }
                var next = Data()
                var last = chunk.count < full
                if !last { next = try source.take(full); last = next.isEmpty }
                guard let box = try? ChaChaPoly.SealedBox(nonce: chunkNonce(counter, last: last),
                                                          ciphertext: chunk.dropLast(tagSize), tag: chunk.suffix(tagSize)),
                      let plaintext = try? ChaChaPoly.open(box, using: key) else {
                    throw DecryptError(last ? "the file is damaged or cut short" : "the file is damaged")
                }
                guard !(last && plaintext.isEmpty && counter > 0) else { throw DecryptError("the file ends in an empty chunk") }
                try write(plaintext)
                if last { done = true } else { chunk = next; counter += 1 }
            }
        }
    }

    public static func encrypt(_ plaintext: Data, to recipient: AgeRecipient) throws -> Data {
        var output = Data(), offset = 0
        try encrypt(read: { count in
            let slice = plaintext.dropFirst(offset).prefix(count); offset += slice.count; return Data(slice)
        }, write: { output.append($0) }, to: recipient)
        return output
    }
    public static func decrypt(_ file: Data, identity: AgeIdentity) throws -> Data {
        let reader = DataReader(file)
        var output = Data()
        try decrypt(read: reader.read, write: { output.append($0) }, identity: identity)
        return output
    }

    /// Encrypts `source` into a new file at `destination`, hashing both sides as it goes.
    public static func encryptFile(_ source: URL, to destination: URL, recipient: AgeRecipient)
        throws -> (plaintext: ContentDigest, ciphertext: ContentDigest) {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: destination.path])
        }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        var plain = DigestCounter(), cipher = DigestCounter()
        try encrypt(read: { count in
            let data = try readFully(input, count)
            plain.update(data)
            return data
        }, write: { data in
            cipher.update(data)
            try output.write(contentsOf: data)
        }, to: recipient)
        try output.synchronize()
        return (plain.finalize(), cipher.finalize())
    }

    /// Decrypts `source` into a new file at `destination`, or only hashes the plaintext when
    /// `destination` is nil. Returns the plaintext's digest.
    public static func decryptFile(_ source: URL, to destination: URL?, identity: AgeIdentity) throws -> ContentDigest {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        var output: FileHandle?
        if let destination {
            guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: destination.path])
            }
            output = try FileHandle(forWritingTo: destination)
        }
        defer { try? output?.close() }
        var plain = DigestCounter()
        try decrypt(read: { try readFully(input, $0) }, write: { data in
            plain.update(data)
            try output?.write(contentsOf: data)
        }, identity: identity)
        return plain.finalize()
    }

    private static func readFully(_ handle: FileHandle, _ count: Int) throws -> Data {
        var data = Data()
        while data.count < count {
            guard let more = try handle.read(upToCount: count - data.count), !more.isEmpty else { break }
            data.append(more)
        }
        return data
    }
}

private final class DataReader: @unchecked Sendable {
    let data: Data
    var offset = 0
    init(_ data: Data) { self.data = data }
    func read(_ count: Int) -> Data {
        let slice = data.dropFirst(offset).prefix(count)
        offset += slice.count
        return Data(slice)
    }
}
