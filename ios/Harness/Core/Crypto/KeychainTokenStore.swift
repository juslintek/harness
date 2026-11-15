import Foundation
import Security

public final class KeychainTokenStore: Sendable {
    public static let shared = KeychainTokenStore()

    private let service: String

    public init(service: String = "dev.harness.mobile.keychain") {
        self.service = service
    }

    public func saveToken(_ token: String, for instanceId: String) throws {
        guard let data = token.data(using: .utf8) else { return }
        try saveItem(data: data, account: "token_\(instanceId)")
    }

    public func getToken(for instanceId: String) -> String? {
        guard let data = readItem(account: "token_\(instanceId)") else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func deleteToken(for instanceId: String) {
        deleteItem(account: "token_\(instanceId)")
    }

    public func saveKeyData(_ data: Data, tag: String) throws {
        try saveItem(data: data, account: "key_\(tag)")
    }

    public func getKeyData(tag: String) -> Data? {
        readItem(account: "key_\(tag)")
    }

    public func deleteKeyData(tag: String) {
        deleteItem(account: "key_\(tag)")
    }

    public func clearAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func saveItem(data: Data, account: String) throws {
        deleteItem(account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    private func readItem(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return data
    }

    private func deleteItem(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
