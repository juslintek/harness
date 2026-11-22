import Foundation
import CryptoKit
import LocalAuthentication

public protocol DeviceKeySigning: Sendable {
    var publicKeySpkiBase64Url: String { get }
    func sign(canonicalAscii: String) async throws -> String
}

public enum DeviceKeySignerError: Error, LocalizedError {
    case invalidAsciiPayload
    case keyGenerationFailed
    case keyNotFound

    public var errorDescription: String? {
        switch self {
        case .invalidAsciiPayload:
            return "Payload contains non-ASCII characters."
        case .keyGenerationFailed:
            return "Failed to generate or load device signing key."
        case .keyNotFound:
            return "Signing key was not found in secure storage."
        }
    }
}

public final class DeviceKeySigner: DeviceKeySigning, @unchecked Sendable {
    private enum Storage {
        case software(P256.Signing.PrivateKey)
        case secureEnclave(SecureEnclave.P256.Signing.PrivateKey)
    }

    private let storage: Storage
    public let publicKeySpkiBase64Url: String

    public init(softwareKey: P256.Signing.PrivateKey) {
        self.storage = .software(softwareKey)
        self.publicKeySpkiBase64Url = softwareKey.publicKey.derRepresentation.base64URLEncodedString()
    }

    public init(secureEnclaveKey: SecureEnclave.P256.Signing.PrivateKey) {
        self.storage = .secureEnclave(secureEnclaveKey)
        self.publicKeySpkiBase64Url = secureEnclaveKey.publicKey.derRepresentation.base64URLEncodedString()
    }

    public static func makeDefault(
        keychain: KeychainTokenStore = .shared,
        tag: String = "primary_device_key",
        forceSoftware: Bool = false
    ) throws -> DeviceKeySigner {
        let preferSoftware = forceSoftware
            || ProcessInfo.processInfo.environment["HARNESS_TEST_SIGNER"] == "1"
            || !SecureEnclave.isAvailable

        if preferSoftware {
            if let savedData = keychain.getKeyData(tag: tag),
               let key = try? P256.Signing.PrivateKey(rawRepresentation: savedData) {
                return DeviceKeySigner(softwareKey: key)
            }
            let newKey = P256.Signing.PrivateKey()
            try keychain.saveKeyData(newKey.rawRepresentation, tag: tag)
            return DeviceKeySigner(softwareKey: newKey)
        } else {
            if let savedData = keychain.getKeyData(tag: tag),
               let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: savedData) {
                return DeviceKeySigner(secureEnclaveKey: key)
            }
            let newKey: SecureEnclave.P256.Signing.PrivateKey
            if let accessControl = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                [.privateKeyUsage, .userPresence],
                nil
            ) {
                newKey = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl)
            } else {
                newKey = try SecureEnclave.P256.Signing.PrivateKey()
            }
            try keychain.saveKeyData(newKey.dataRepresentation, tag: tag)
            return DeviceKeySigner(secureEnclaveKey: newKey)
        }
    }

    public func sign(canonicalAscii: String) async throws -> String {
        guard let asciiData = canonicalAscii.data(using: .ascii) else {
            throw DeviceKeySignerError.invalidAsciiPayload
        }
        let digest = SHA256.hash(data: asciiData)
        let rawSignature: Data
        switch storage {
        case .software(let key):
            let signature = try key.signature(for: digest)
            rawSignature = signature.rawRepresentation
        case .secureEnclave(let key):
            let context = LAContext()
            _ = try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Authorize Step-Up with Harness")
            let signature = try key.signature(for: digest)
            rawSignature = signature.rawRepresentation
        }
        return rawSignature.base64URLEncodedString()
    }

    public static func verify(
        publicKeySpkiBase64Url: String,
        signatureBase64Url: String,
        canonicalAscii: String
    ) -> Bool {
        guard let spkiData = Data(base64URL: publicKeySpkiBase64Url),
              let sigData = Data(base64URL: signatureBase64Url),
              let asciiData = canonicalAscii.data(using: .ascii),
              let pubKey = try? P256.Signing.PublicKey(derRepresentation: spkiData),
              let ecdsaSig = try? P256.Signing.ECDSASignature(rawRepresentation: sigData) else {
            return false
        }
        let digest = SHA256.hash(data: asciiData)
        return pubKey.isValidSignature(ecdsaSig, for: digest)
    }
}

extension Data {
    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public init?(base64URL: String) {
        var base64 = base64URL
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 {
            base64.append("=")
        }
        self.init(base64Encoded: base64)
    }
}
