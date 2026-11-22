import XCTest
import CryptoKit
@testable import Harness

private final class LoopbackAuthMockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var stepUpDone = false
    nonisolated(unsafe) static var registeredSpki: String?

    static func reset() {
        lock.lock()
        stepUpDone = false
        registeredSpki = nil
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        defer { Self.lock.unlock() }

        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        let path = url.path
        let method = request.httpMethod ?? "GET"

        if path.contains("/api/auth/mobile/pair/options") {
            respondWith(statusCode: 200, json: "{\"challengeId\":\"ch_pair_1\",\"nonce\":\"nonce_pair_1\",\"rpOrigin\":\"http://localhost:4100\"}")
        } else if path.contains("/api/auth/mobile/pair/verify") {
            if let bodyData = httpBody(),
               let verifyReq = try? JSONDecoder().decode(MobilePairVerifyRequest.self, from: bodyData) {
                Self.registeredSpki = verifyReq.publicKeySpki
                let canonical = "harness-mobile-pair-v1|http://localhost:4100|ch_pair_1|nonce_pair_1"
                let valid = DeviceKeySigner.verify(publicKeySpkiBase64Url: verifyReq.publicKeySpki, signatureBase64Url: verifyReq.signature, canonicalAscii: canonical)
                if valid {
                    respondWith(statusCode: 200, json: "{\"token\":\"hmob_test_token_123\",\"deviceId\":\"dev_pair_001\",\"user\":{\"id\":\"usr_alice_001\",\"email\":\"alice@example.com\",\"name\":\"Alice Cooper\",\"instanceAdmin\":true,\"createdAt\":1700000000000}}")
                    return
                }
            }
            respondWith(statusCode: 400, json: "{\"error\":\"invalid_signature\"}")
        } else if path.contains("/api/auth/mobile/enroll/") && path.contains("/options") {
            respondWith(statusCode: 200, json: "{\"challengeId\":\"ch_enroll_1\",\"nonce\":\"nonce_enroll_1\",\"userId\":\"usr_alice_001\",\"rpOrigin\":\"http://localhost:4100\"}")
        } else if path.contains("/api/auth/mobile/enroll/") && path.contains("/verify") {
            if let bodyData = httpBody(),
               let enrollReq = try? JSONDecoder().decode(MobileEnrollVerifyRequest.self, from: bodyData) {
                Self.registeredSpki = enrollReq.publicKeySpki
                let canonical = "harness-mobile-enroll-v1|http://localhost:4100|ch_enroll_1|nonce_enroll_1"
                let valid = DeviceKeySigner.verify(publicKeySpkiBase64Url: enrollReq.publicKeySpki, signatureBase64Url: enrollReq.signature, canonicalAscii: canonical)
                if valid {
                    respondWith(statusCode: 200, json: "{\"token\":\"hmob_enroll_token_123\",\"deviceId\":\"dev_enroll_001\",\"user\":{\"id\":\"usr_alice_001\",\"email\":\"alice@example.com\",\"name\":\"Alice Cooper\",\"instanceAdmin\":true,\"createdAt\":1700000000000},\"recoveryCodes\":[\"rec_1\",\"rec_2\"]}")
                    return
                }
            }
            respondWith(statusCode: 400, json: "{\"error\":\"invalid_signature\"}")
        } else if path.contains("/api/auth/me") {
            respondWith(statusCode: 200, json: "{\"user\":{\"id\":\"usr_alice_001\",\"email\":\"alice@example.com\",\"name\":\"Alice Cooper\",\"instanceAdmin\":true,\"createdAt\":1700000000000},\"session\":{\"id\":\"ses_alice_001\",\"method\":\"mobile\",\"stepUpAt\":1700000000000,\"stepUpFresh\":true},\"orgs\":[{\"id\":\"org_alice_001\",\"slug\":\"alice\",\"name\":\"Alice\",\"personal\":true,\"createdAt\":1700000000000,\"role\":\"admin\"}],\"devices\":[{\"id\":\"dev_pair_001\",\"name\":\"Alice iPhone\",\"platform\":\"ios\",\"createdAt\":1700000000000,\"lastUsedAt\":1700000000000,\"current\":true}]}")
        } else if path.contains("/api/auth/mobile/step-up/options") {
            respondWith(statusCode: 200, json: "{\"challengeId\":\"ch_stepup_1\",\"nonce\":\"nonce_stepup_1\",\"expiresAt\":1700001000}")
        } else if path.contains("/api/auth/mobile/step-up/verify") {
            if let bodyData = httpBody(),
               let stepUpReq = try? JSONDecoder().decode(MobileStepUpVerifyRequest.self, from: bodyData),
               let spki = Self.registeredSpki {
                let canonical = "harness-mobile-stepup-v1|http://localhost:4100|ses_alice_001|ch_stepup_1|nonce_stepup_1"
                let valid = DeviceKeySigner.verify(publicKeySpkiBase64Url: spki, signatureBase64Url: stepUpReq.signature, canonicalAscii: canonical)
                if valid {
                    Self.stepUpDone = true
                    respondWith(statusCode: 200, json: "{\"ok\":true,\"stepUpAt\":1700000000}")
                    return
                }
            }
            respondWith(statusCode: 400, json: "{\"error\":\"invalid_signature\"}")
        } else if path.contains("/api/halt") && method == "POST" {
            respondWith(statusCode: Self.stepUpDone ? 200 : 403, json: Self.stepUpDone ? "{\"halted\":true}" : "{\"error\":\"step_up_required\"}")
        } else {
            respondWith(statusCode: 404, json: "{}")
        }
    }

    private func httpBody() -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read > 0 { data.append(buffer, count: read) } else { break }
        }
        return data
    }

    private func respondWith(statusCode: Int, json: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: json.data(using: .utf8)!)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class LiveLoopbackAuthTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LoopbackAuthMockURLProtocol.reset()
    }

    func testPairingAndHaltStepUpFlow() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LoopbackAuthMockURLProtocol.self]
        let session = URLSession(configuration: config)

        let testUserDefaults = UserDefaults(suiteName: "LiveLoopbackAuthTests")!
        testUserDefaults.removePersistentDomain(forName: "LiveLoopbackAuthTests")
        let registry = InstanceRegistry(userDefaults: testUserDefaults)
        let keychain = KeychainTokenStore(service: "dev.harness.mobile.test.\(UUID().uuidString)")
        keychain.clearAll()

        let signer = DeviceKeySigner(softwareKey: P256.Signing.PrivateKey())
        let store = AppSessionStore(registry: registry, keychain: keychain, signer: signer)

        let origin = "http://localhost:4100"
        let client = HarnessAPIClient(origin: origin, tokenProvider: { keychain.getToken(for: store.activeInstanceId ?? "") }, sessionIdProvider: { "" }, signer: signer, session: session)

        let optRes = try await client.postPairOptions(MobilePairOptionsRequest(code: "pair_123456", deviceName: "iPhone 17 Pro"))
        let canonical = "harness-mobile-pair-v1|\(optRes.rpOrigin)|\(optRes.challengeId)|\(optRes.nonce)"
        let signature = try await signer.sign(canonicalAscii: canonical)

        let verifyReq = MobilePairVerifyRequest(challengeId: optRes.challengeId, code: "pair_123456", deviceName: "iPhone 17 Pro", publicKeySpki: signer.publicKeySpkiBase64Url, signature: signature)
        let verifyRes = try await client.postPairVerify(verifyReq)

        XCTAssertEqual(verifyRes.user.name, "Alice Cooper")
        XCTAssertEqual(verifyRes.token, "hmob_test_token_123")

        let instanceId = UUID().uuidString
        try keychain.saveToken(verifyRes.token, for: instanceId)

        let authedClient = HarnessAPIClient(origin: origin, tokenProvider: { verifyRes.token }, sessionIdProvider: { "" }, signer: signer, session: session)
        let me = try await authedClient.getMe()

        let record = InstanceRecord(id: instanceId, origin: origin, deviceId: verifyRes.deviceId, user: me.user, orgs: me.orgs, selectedOrgSlug: me.orgs.first?.slug ?? "alice")
        registry.addOrUpdateInstance(record)
        store.instances = registry.loadInstances()
        store.activeInstanceId = record.id

        XCTAssertEqual(store.instances.count, 1)
        XCTAssertEqual(store.activeInstance?.user.name, "Alice Cooper")
        XCTAssertTrue(store.isInstanceAdmin)

        let haltRes = try await authedClient.postHalt(HaltRequest(halted: true))
        XCTAssertTrue(haltRes.halted)
        XCTAssertTrue(LoopbackAuthMockURLProtocol.stepUpDone)
    }

    func testEnrollAndMeFlow() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LoopbackAuthMockURLProtocol.self]
        let session = URLSession(configuration: config)

        let signer = DeviceKeySigner(softwareKey: P256.Signing.PrivateKey())
        let client = HarnessAPIClient(origin: "http://localhost:4100", tokenProvider: { nil }, sessionIdProvider: { "" }, signer: signer, session: session)

        let optReq = MobileEnrollOptionsRequest(email: "alice@example.com", name: "Alice Cooper", deviceName: "iPhone 17 Pro")
        let optRes = try await client.postEnrollOptions(code: "enroll_code_1", optReq)

        let canonical = "harness-mobile-enroll-v1|\(optRes.rpOrigin)|\(optRes.challengeId)|\(optRes.nonce)"
        let signature = try await signer.sign(canonicalAscii: canonical)

        let verifyReq = MobileEnrollVerifyRequest(challengeId: optRes.challengeId, userId: optRes.userId, deviceName: "iPhone 17 Pro", publicKeySpki: signer.publicKeySpkiBase64Url, signature: signature)
        let verifyRes = try await client.postEnrollVerify(code: "enroll_code_1", verifyReq)

        XCTAssertEqual(verifyRes.token, "hmob_enroll_token_123")
        XCTAssertEqual(verifyRes.recoveryCodes.count, 2)

        let authedClient = HarnessAPIClient(origin: "http://localhost:4100", tokenProvider: { verifyRes.token }, sessionIdProvider: { "" }, signer: signer, session: session)
        let me = try await authedClient.getMe()
        XCTAssertEqual(me.user.email, "alice@example.com")
    }
}
