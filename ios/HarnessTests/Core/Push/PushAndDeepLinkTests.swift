import XCTest
import UserNotifications
@testable import Harness

private final class PushMockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var lastRequestPath: String?
    nonisolated(unsafe) static var lastRequestMethod: String?
    nonisolated(unsafe) static var lastRequestBody: Data?

    static func reset() {
        lock.lock()
        lastRequestPath = nil
        lastRequestMethod = nil
        lastRequestBody = nil
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.lastRequestPath = request.url?.path
        Self.lastRequestMethod = request.httpMethod
        Self.lastRequestBody = readBody(from: request)
        Self.lock.unlock()

        let json = "{\"id\":\"pt_1\",\"orgId\":\"org_1\",\"userId\":\"usr_1\",\"channel\":\"mobile_push\",\"label\":\"iOS\",\"enabled\":true,\"createdAt\":1700000000000}"
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: json.data(using: .utf8)!)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count > 0 { data.append(buffer, count: count) } else { break }
        }
        return data
    }
}

final class PushAndDeepLinkTests: XCTestCase {
    override func setUp() {
        super.setUp()
        PushMockURLProtocol.reset()
    }

    func testDeepLinkRouterParsesAllRoutes() throws {
        let pairUrl = try XCTUnwrap(URL(string: "harness://pair?origin=http://localhost:4100&code=998877"))
        XCTAssertEqual(
            DeepLinkRouter.parse(pairUrl)?.target,
            .pair(origin: "http://localhost:4100", code: "998877")
        )

        let approvalUrl = try XCTUnwrap(URL(string: "harness://approvals/app_42"))
        XCTAssertEqual(DeepLinkRouter.parse(approvalUrl)?.target, .approval(id: "app_42"))

        let runUrl = try XCTUnwrap(URL(string: "harness://runs/run_77"))
        XCTAssertEqual(DeepLinkRouter.parse(runUrl)?.target, .run(id: "run_77"))

        let chatUrl = try XCTUnwrap(URL(string: "harness://chat/acme/chan_99"))
        XCTAssertEqual(DeepLinkRouter.parse(chatUrl)?.target, .chat(slug: "acme", channelId: "chan_99"))

        let openApproval = try XCTUnwrap(URL(string: "harness://open?path=/approvals/app_123"))
        XCTAssertEqual(DeepLinkRouter.parse(openApproval)?.target, .approval(id: "app_123"))

        let openRun = try XCTUnwrap(URL(string: "harness://open?path=/runs/run_123"))
        XCTAssertEqual(DeepLinkRouter.parse(openRun)?.target, .run(id: "run_123"))

        let openChat = try XCTUnwrap(URL(string: "harness://open?path=/chat/beta/chan_5"))
        XCTAssertEqual(DeepLinkRouter.parse(openChat)?.target, .chat(slug: "beta", channelId: "chan_5"))

        let openBoard = try XCTUnwrap(URL(string: "harness://open?path=/board"))
        XCTAssertEqual(DeepLinkRouter.parse(openBoard)?.target, .board)

        let nonHarness = try XCTUnwrap(URL(string: "https://example.com/approvals/1"))
        XCTAssertNil(DeepLinkRouter.parse(nonHarness))
    }

    @MainActor
    func testAppSessionStoreSwitchesInstanceAndTabOnDeepLink() throws {
        let suite = UserDefaults(suiteName: "PushAndDeepLinkTests")!
        suite.removePersistentDomain(forName: "PushAndDeepLinkTests")
        let registry = InstanceRegistry(userDefaults: suite)
        let user = User(id: "usr_1", email: "a@b.com", name: "Alice", instanceAdmin: true, createdAt: 0)
        let inst1 = InstanceRecord(
            id: "inst_1",
            origin: "https://one.harness.test",
            deviceId: "dev_1",
            user: user,
            orgs: [OrgMembership(id: "org_1", slug: "personal", name: "Personal", personal: true, createdAt: 0, role: "owner")],
            selectedOrgSlug: "personal"
        )
        let inst2 = InstanceRecord(
            id: "inst_2",
            origin: "https://two.harness.test",
            deviceId: "dev_2",
            user: user,
            orgs: [
                OrgMembership(id: "org_p", slug: "personal", name: "Personal", personal: true, createdAt: 0, role: "owner"),
                OrgMembership(id: "org_a", slug: "acme", name: "Acme", personal: false, createdAt: 0, role: "admin")
            ],
            selectedOrgSlug: "personal"
        )
        registry.saveInstances([inst1, inst2])

        let store = AppSessionStore(registry: registry)
        XCTAssertEqual(store.activeInstanceId, "inst_1")

        let pushPayload = try XCTUnwrap(PushRegistrationManager.parsePushUserInfo([
            "deepLink": "harness://chat/acme/chan_42",
            "instanceOrigin": "https://two.harness.test/",
            "kind": "chat_mention"
        ]))
        XCTAssertTrue(store.handlePushPayload(pushPayload))
        XCTAssertEqual(store.activeInstanceId, "inst_2")
        XCTAssertEqual(store.selectedTab, .chat)
        XCTAssertEqual(store.activeInstance?.selectedOrgSlug, "acme")

        let runUrl = try XCTUnwrap(URL(string: "harness://runs/run_88"))
        XCTAssertTrue(store.handleDeepLink(url: runUrl))
        XCTAssertEqual(store.selectedTab, .runs)
    }

    func testPushRegistrationManagerCategoryAndMobilePushSubscribe() async throws {
        let manager = PushRegistrationManager()
        manager.registerNotificationCategories()

        let categories = await UNUserNotificationCenter.current().notificationCategories()
        let guardCat = categories.first(where: { $0.identifier == PushRegistrationManager.guardApprovalCategoryId })
        XCTAssertNotNil(guardCat)
        let actionIds = Set(guardCat?.actions.map(\.identifier) ?? [])
        XCTAssertTrue(actionIds.contains(PushRegistrationManager.approveGuardActionId))
        XCTAssertTrue(actionIds.contains(PushRegistrationManager.denyGuardActionId))
        XCTAssertTrue(guardCat?.actions.allSatisfy { $0.options.contains(.foreground) } ?? false)

        let tokenBytes = Data([0xde, 0xad, 0xbe, 0xef, 0x01, 0x23])
        manager.didRegisterForRemoteNotifications(deviceToken: tokenBytes)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(manager.deviceTokenHex, "deadbeef0123")

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PushMockURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = HarnessAPIClient(
            origin: "http://127.0.0.1:4100",
            tokenProvider: { "hmob_test" },
            signer: DeviceKeySigner(softwareKey: .init()),
            session: session
        )

        let created = try await manager.registerMobilePush(
            relayUrl: "https://relay.harness.test",
            pushTokenHex: "deadbeef0123",
            appId: "dev.harness.mobile",
            using: client
        )
        XCTAssertEqual(created.id, "pt_1")
        XCTAssertEqual(PushMockURLProtocol.lastRequestPath, "/api/notify/push/mobile")
        XCTAssertEqual(PushMockURLProtocol.lastRequestMethod, "POST")
        let bodyData = try XCTUnwrap(PushMockURLProtocol.lastRequestBody)
        let decoded = try JSONDecoder().decode(MobilePushSubscribeRequest.self, from: bodyData)
        XCTAssertEqual(decoded.relayUrl, "https://relay.harness.test")
        XCTAssertEqual(decoded.platform, "ios")
        XCTAssertEqual(decoded.pushToken, "deadbeef0123")
        XCTAssertEqual(decoded.appId, "dev.harness.mobile")
    }
}
