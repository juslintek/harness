import XCTest
import CryptoKit
@testable import Harness

private actor MockSigner: DeviceKeySigning {
    nonisolated let publicKeySpkiBase64Url: String = "mock_spki"
    var signCount: Int = 0

    func sign(canonicalAscii: String) async throws -> String {
        signCount += 1
        try await Task.sleep(nanoseconds: 50_000_000)
        return "mock_signature_64_bytes_base64url_string_representation_for_testing_purposes"
    }
}

private actor TestCounter {
    var optionsCallCount: Int = 0
    var verifyCallCount: Int = 0

    func incOptions() {
        optionsCallCount += 1
    }

    func incVerify() {
        verifyCallCount += 1
    }
}

private final class StepUpMockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var stepUpDone = false
    nonisolated(unsafe) static var optionsCount = 0
    nonisolated(unsafe) static var verifyCount = 0
    nonisolated(unsafe) static var sensitiveRequestCount = 0

    static func reset() {
        lock.lock()
        stepUpDone = false
        optionsCount = 0
        verifyCount = 0
        sensitiveRequestCount = 0
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool {
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        Self.lock.lock()
        defer { Self.lock.unlock() }

        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }

        let path = url.path

        if path.contains("/api/auth/mobile/step-up/options") {
            Self.optionsCount += 1
            let json = """
            {"challengeId":"ch_mock","nonce":"nonce_mock","expiresAt":1700000000}
            """
            respondWith(statusCode: 200, json: json)
        } else if path.contains("/api/auth/mobile/step-up/verify") {
            Self.verifyCount += 1
            Self.stepUpDone = true
            let json = """
            {"ok":true,"stepUpAt":1700000000}
            """
            respondWith(statusCode: 200, json: json)
        } else if path.contains("/api/halt") || path.contains("/api/test/sensitive") {
            Self.sensitiveRequestCount += 1
            if !Self.stepUpDone {
                let json = """
                {"error":"step_up_required"}
                """
                respondWith(statusCode: 403, json: json)
            } else {
                let json = """
                {"halted":true}
                """
                respondWith(statusCode: 200, json: json)
            }
        } else {
            respondWith(statusCode: 404, json: "{}")
        }
    }

    private func respondWith(statusCode: Int, json: String) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let data = json.data(using: .utf8)!
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class SingleFlightStepUpTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StepUpMockURLProtocol.reset()
    }

    func testThreeConcurrentStepUpsExecuteOnce() async throws {
        let singleFlight = SingleFlightStepUp()
        let signer = MockSigner()
        let counter = TestCounter()

        async let task1: Void = singleFlight.execute(
            origin: "http://localhost:4100",
            sessionId: "ses_1",
            signer: signer,
            fetchOptions: {
                await counter.incOptions()
                try await Task.sleep(nanoseconds: 30_000_000)
                return MobileStepUpOptionsResponse(challengeId: "ch_1", nonce: "n_1", expiresAt: 170000)
            },
            verifyStepUp: { _ in
                await counter.incVerify()
                try await Task.sleep(nanoseconds: 30_000_000)
            }
        )

        async let task2: Void = singleFlight.execute(
            origin: "http://localhost:4100",
            sessionId: "ses_1",
            signer: signer,
            fetchOptions: {
                await counter.incOptions()
                return MobileStepUpOptionsResponse(challengeId: "ch_1", nonce: "n_1", expiresAt: 170000)
            },
            verifyStepUp: { _ in
                await counter.incVerify()
            }
        )

        async let task3: Void = singleFlight.execute(
            origin: "http://localhost:4100",
            sessionId: "ses_1",
            signer: signer,
            fetchOptions: {
                await counter.incOptions()
                return MobileStepUpOptionsResponse(challengeId: "ch_1", nonce: "n_1", expiresAt: 170000)
            },
            verifyStepUp: { _ in
                await counter.incVerify()
            }
        )

        _ = try await (task1, task2, task3)

        let optionsCount = await counter.optionsCallCount
        let verifyCount = await counter.verifyCallCount
        let signCount = await signer.signCount

        XCTAssertEqual(optionsCount, 1, "fetchOptions should be executed exactly once for concurrent requests")
        XCTAssertEqual(verifyCount, 1, "verifyStepUp should be executed exactly once for concurrent requests")
        XCTAssertEqual(signCount, 1, "signer.sign should be executed exactly once for concurrent requests")
    }

    func testThreeConcurrentRequestsWith403StepUpOnceAndReplayTo200() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StepUpMockURLProtocol.self]
        let session = URLSession(configuration: config)

        let signer = MockSigner()
        let client = HarnessAPIClient(
            origin: "http://localhost:4100",
            tokenProvider: { "mock_bearer_token" },
            sessionIdProvider: { "ses_test" },
            signer: signer,
            session: session,
            stepUpCoordinator: SingleFlightStepUp()
        )

        // Launch 3 concurrent requests that initially hit 403 step_up_required
        async let r1: HaltResponse = client.postHalt(HaltRequest(halted: true))
        async let r2: HaltResponse = client.postHalt(HaltRequest(halted: true))
        async let r3: HaltResponse = client.postHalt(HaltRequest(halted: true))

        let (res1, res2, res3) = try await (r1, r2, r3)

        XCTAssertTrue(res1.halted)
        XCTAssertTrue(res2.halted)
        XCTAssertTrue(res3.halted)

        XCTAssertEqual(StepUpMockURLProtocol.optionsCount, 1, "Should request step-up options only once")
        XCTAssertEqual(StepUpMockURLProtocol.verifyCount, 1, "Should verify step-up only once")
        let signCount = await signer.signCount
        XCTAssertEqual(signCount, 1, "Signer should be invoked only once")
        XCTAssertEqual(StepUpMockURLProtocol.sensitiveRequestCount, 6, "3 initial calls (403) + 3 replayed calls (200)")
    }
}
