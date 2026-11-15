import XCTest
@testable import Harness

private final class ApprovalsMockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    static func reset() {
        lock.lock()
        requestHandler = nil
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let handler = Self.requestHandler
        Self.lock.unlock()

        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@MainActor
final class ApprovalsStoreTests: XCTestCase {
    private var sessionStore: AppSessionStore!
    private var testSession: URLSession!
    private var apiClient: HarnessAPIClient!

    override func setUp() async throws {
        ApprovalsMockURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ApprovalsMockURLProtocol.self]
        testSession = URLSession(configuration: config)

        sessionStore = AppSessionStore()
        let instance = InstanceRecord(
            id: "inst_test_001",
            origin: "http://localhost:4100",
            deviceId: "dev_001",
            user: User(id: "usr_001", email: "admin@example.com", name: "Admin", instanceAdmin: true),
            orgs: [OrgMembership(id: "org_001", slug: "acme", name: "Acme", role: "owner")],
            selectedOrgSlug: "acme"
        )
        sessionStore.instances = [instance]
        sessionStore.activeInstanceId = instance.id

        apiClient = HarnessAPIClient(
            origin: "http://localhost:4100",
            tokenProvider: { "mock_token" },
            session: testSession
        )
    }

    func testPendingApprovalsLoadSuccessfully() async throws {
        let json = """
        [
          {
            "id": "app_01",
            "runId": "run_01",
            "command": "git push origin main",
            "reason": "Ship hotfix",
            "status": "pending",
            "createdAt": 1700000000000,
            "expiresAt": 1700000300000
          }
        ]
        """
        ApprovalsMockURLProtocol.requestHandler = { req in
            XCTAssertTrue(req.url?.path.contains("/api/approvals") == true)
            XCTAssertEqual(req.url?.query, "status=pending")
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, json.data(using: .utf8)!)
        }

        let store = ApprovalsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        await store.fetchPending()

        XCTAssertEqual(store.pendingApprovals.count, 1)
        XCTAssertEqual(store.pendingApprovals.first?.id, "app_01")
        XCTAssertEqual(store.pendingApprovals.first?.status, "pending")
        XCTAssertNil(store.errorMessage)
    }

    func testApproveDecisionUpdatesState() async throws {
        let store = ApprovalsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        store.pendingApprovals = [
            Approval(id: "app_01", runId: "run_01", command: "cmd", reason: "reason", status: "pending", createdAt: 1000, expiresAt: 2000)
        ]

        let responseJson = """
        {
          "id": "app_01",
          "runId": "run_01",
          "command": "cmd",
          "reason": "reason",
          "status": "approved",
          "decidedBy": "usr_001",
          "createdAt": 1000,
          "expiresAt": 2000,
          "decidedAt": 1500
        }
        """
        ApprovalsMockURLProtocol.requestHandler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertTrue(req.url?.path.contains("/api/approvals/app_01") == true)
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, responseJson.data(using: .utf8)!)
        }

        await store.decide(id: "app_01", decision: "approve")

        XCTAssertTrue(store.pendingApprovals.isEmpty)
        XCTAssertEqual(store.resolvedApprovals.count, 1)
        XCTAssertEqual(store.resolvedApprovals.first?.status, "approved")
        XCTAssertEqual(store.bannerMessage, "Approval marked approved.")
        XCTAssertFalse(store.bannerIsError)
    }

    func testDenyDecisionUpdatesState() async throws {
        let store = ApprovalsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        store.pendingApprovals = [
            Approval(id: "app_02", runId: "run_01", command: "rm -rf", reason: "danger", status: "pending", createdAt: 1000, expiresAt: 2000)
        ]

        let responseJson = """
        {
          "id": "app_02",
          "runId": "run_01",
          "command": "rm -rf",
          "reason": "danger",
          "status": "denied",
          "decidedBy": "usr_001",
          "createdAt": 1000,
          "expiresAt": 2000,
          "decidedAt": 1600
        }
        """
        ApprovalsMockURLProtocol.requestHandler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, responseJson.data(using: .utf8)!)
        }

        await store.decide(id: "app_02", decision: "deny")

        XCTAssertTrue(store.pendingApprovals.isEmpty)
        XCTAssertEqual(store.resolvedApprovals.count, 1)
        XCTAssertEqual(store.resolvedApprovals.first?.status, "denied")
        XCTAssertEqual(store.bannerMessage, "Approval marked denied.")
    }

    func test409AlreadyDecidedHandling() async throws {
        let store = ApprovalsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        store.pendingApprovals = [
            Approval(id: "app_late", runId: "run_01", command: "cmd", reason: "r", status: "pending", createdAt: 1000, expiresAt: 2000)
        ]

        ApprovalsMockURLProtocol.requestHandler = { req in
            let res = HTTPURLResponse(url: req.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!
            return (res, "{\"error\":\"not pending\"}".data(using: .utf8)!)
        }

        await store.decide(id: "app_late", decision: "approve")

        XCTAssertTrue(store.pendingApprovals.isEmpty)
        XCTAssertEqual(store.bannerMessage, "Approval is no longer pending.")
        XCTAssertTrue(store.bannerIsError)
    }

    func testNonAdminRoleGating() async throws {
        // Given an instance where user is not instance admin and org role is plain member
        let memberInstance = InstanceRecord(
            id: "inst_member",
            origin: "http://localhost:4100",
            deviceId: "dev_002",
            user: User(id: "usr_mem", email: "mem@example.com", name: "Member", instanceAdmin: false),
            orgs: [OrgMembership(id: "org_001", slug: "acme", name: "Acme", role: "member")],
            selectedOrgSlug: "acme"
        )
        sessionStore.instances = [memberInstance]
        sessionStore.activeInstanceId = memberInstance.id

        let store = ApprovalsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        XCTAssertFalse(store.canManageApprovals)

        // Calling fetchPending should not trigger any HTTP request
        ApprovalsMockURLProtocol.requestHandler = { _ in
            XCTFail("Should not send network request when user cannot manage approvals")
            throw URLError(.badURL)
        }

        await store.fetchPending()
        XCTAssertTrue(store.pendingApprovals.isEmpty)
        XCTAssertNil(store.errorMessage)
    }

    func testCountdownExpiryCalculation() {
        let now = Date(timeIntervalSince1970: 1000)
        let futureExpiresAt: Int64 = 1015 * 1000 // 15 seconds ahead
        let pastExpiresAt: Int64 = 995 * 1000 // 5 seconds in past
        let safeExpiresAt: Int64 = 1045 * 1000 // 45 seconds ahead

        XCTAssertEqual(ApprovalsStore.remainingSeconds(expiresAt: futureExpiresAt, now: now), 15)
        XCTAssertFalse(ApprovalsStore.isExpired(expiresAt: futureExpiresAt, now: now))
        XCTAssertTrue(ApprovalsStore.isDanger(expiresAt: futureExpiresAt, now: now))

        XCTAssertEqual(ApprovalsStore.remainingSeconds(expiresAt: pastExpiresAt, now: now), 0)
        XCTAssertTrue(ApprovalsStore.isExpired(expiresAt: pastExpiresAt, now: now))
        XCTAssertFalse(ApprovalsStore.isDanger(expiresAt: pastExpiresAt, now: now))

        XCTAssertEqual(ApprovalsStore.remainingSeconds(expiresAt: safeExpiresAt, now: now), 45)
        XCTAssertFalse(ApprovalsStore.isDanger(expiresAt: safeExpiresAt, now: now))
    }

    func testDeepLinkFocus() async throws {
        let approvalJson = """
        {
          "id": "app_deep_1",
          "runId": "run_01",
          "command": "terraform apply",
          "reason": "Infrastructure roll",
          "status": "pending",
          "createdAt": 1000,
          "expiresAt": 5000
        }
        """
        ApprovalsMockURLProtocol.requestHandler = { req in
            XCTAssertTrue(req.url?.path.contains("/api/approvals/app_deep_1") == true)
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, approvalJson.data(using: .utf8)!)
        }

        let store = ApprovalsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        let url = URL(string: "harness://approvals/app_deep_1")!
        await store.handleDeepLink(url: url)

        XCTAssertEqual(store.focusedApprovalId, "app_deep_1")
        XCTAssertEqual(store.focusedApproval?.command, "terraform apply")
    }

    func testRealtimeApprovalUpdate() {
        let store = ApprovalsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        let app = Approval(id: "app_rt_1", runId: "run_01", command: "ls", reason: "r", status: "pending", createdAt: 1000, expiresAt: 2000)

        // Incoming pending approval
        store.handleRealtimeApproval(app)
        XCTAssertEqual(store.pendingApprovals.count, 1)

        // Incoming approved status for same approval
        let approved = Approval(id: "app_rt_1", runId: "run_01", command: "ls", reason: "r", status: "approved", decidedBy: "usr_admin", createdAt: 1000, expiresAt: 2000, decidedAt: 1500)
        store.handleRealtimeApproval(approved)

        XCTAssertTrue(store.pendingApprovals.isEmpty)
        XCTAssertEqual(store.resolvedApprovals.count, 1)
        XCTAssertEqual(store.resolvedApprovals.first?.status, "approved")
    }
}
