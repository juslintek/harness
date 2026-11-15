import XCTest
@testable import Harness

private final class RunsMockURLProtocol: URLProtocol, @unchecked Sendable {
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
final class RunsStoreTests: XCTestCase {
    private var sessionStore: AppSessionStore!
    private var testSession: URLSession!
    private var apiClient: HarnessAPIClient!

    override func setUp() async throws {
        RunsMockURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RunsMockURLProtocol.self]
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

    func testInstanceAdminLoadsRuns() async throws {
        let json = """
        [
          {
            "id": "run_01",
            "agentId": "claude-code",
            "model": "claude-3-7-sonnet",
            "repo": "/Users/alice/projects/harness",
            "branch": "main",
            "prompt": "Fix auth",
            "state": "running",
            "createdAt": 1700000000000,
            "startedAt": 1700000001000,
            "inputTokens": 100,
            "outputTokens": 50
          },
          {
            "id": "run_02",
            "agentId": "codex",
            "repo": "/Users/alice/projects/harness",
            "prompt": "Done task",
            "state": "completed",
            "createdAt": 1700000000000,
            "startedAt": 1700000001000,
            "endedAt": 1700000050000,
            "inputTokens": 50,
            "outputTokens": 20
          }
        ]
        """
        RunsMockURLProtocol.requestHandler = { req in
            XCTAssertTrue(req.url?.path.contains("/api/runs") == true)
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, json.data(using: .utf8)!)
        }

        let store = RunsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        await store.fetchRuns()

        XCTAssertEqual(store.runs.count, 2)
        XCTAssertEqual(store.filteredRuns.count, 1) // only run_01 is active
        XCTAssertEqual(store.filteredRuns.first?.id, "run_01")

        store.selectedFilter = .all
        XCTAssertEqual(store.filteredRuns.count, 2)
    }

    func testNonInstanceAdminFallsBackToWakeups() async throws {
        let memberInstance = InstanceRecord(
            id: "inst_member",
            origin: "http://localhost:4100",
            deviceId: "dev_002",
            user: User(id: "usr_mem", email: "mem@example.com", name: "Member", instanceAdmin: false),
            orgs: [OrgMembership(id: "org_001", slug: "acme", name: "Acme", role: "admin")],
            selectedOrgSlug: "acme"
        )
        sessionStore.instances = [memberInstance]
        sessionStore.activeInstanceId = memberInstance.id

        let wakeupsJson = """
        [
          {
            "id": "wake_01",
            "memberId": "mem_01",
            "reason": "schedule",
            "status": "pending",
            "createdAt": 1700000000000
          },
          {
            "id": "wake_02",
            "memberId": "mem_02",
            "reason": "run_now",
            "status": "started",
            "createdAt": 1700000005000
          }
        ]
        """
        RunsMockURLProtocol.requestHandler = { req in
            XCTAssertTrue(req.url?.path.contains("/api/orgs/acme/wakeups") == true)
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, wakeupsJson.data(using: .utf8)!)
        }

        let store = RunsStore(sessionStore: sessionStore, apiClientOverride: apiClient)
        XCTAssertFalse(store.isInstanceAdmin)

        await store.fetchWakeups()
        XCTAssertEqual(store.wakeups.count, 2)
        XCTAssertEqual(store.wakeups.first?.id, "wake_01")
        XCTAssertEqual(store.wakeups.first?.reason, "schedule")
    }

    func testStartRunSuccessAndHalted409() async throws {
        let store = RunsStore(sessionStore: sessionStore, apiClientOverride: apiClient)

        // 1. Success case
        RunsMockURLProtocol.requestHandler = { req in
            if req.httpMethod == "POST" && req.url?.path == "/api/runs" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!
                return (res, "{\"id\":\"run_new_123\"}".data(using: .utf8)!)
            }
            if req.httpMethod == "GET" && req.url?.path == "/api/runs" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, "[]".data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        let newId = try await store.startRun(agentId: "claude-code", repo: "/Users/test", prompt: "Hello")
        XCTAssertEqual(newId, "run_new_123")
        XCTAssertEqual(store.bannerMessage, "Run started: run_new_123")
        XCTAssertFalse(store.bannerIsError)

        // 2. Halted 409 error
        RunsMockURLProtocol.requestHandler = { req in
            if req.httpMethod == "POST" && req.url?.path == "/api/runs" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!
                return (res, "{\"error\":\"instance halted\"}".data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        do {
            _ = try await store.startRun(agentId: "claude-code", repo: "/Users/test", prompt: "Hello")
            XCTFail("Should have thrown 409")
        } catch {
            XCTAssertEqual(store.bannerMessage, "Instance is halted: run execution refused.")
            XCTAssertTrue(store.bannerIsError)
        }
    }

    func testKillRun() async throws {
        let store = RunsStore(sessionStore: sessionStore, apiClientOverride: apiClient)

        RunsMockURLProtocol.requestHandler = { req in
            if req.httpMethod == "POST" && req.url?.path.contains("/kill") == true {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, "{\"ok\":true}".data(using: .utf8)!)
            }
            if req.httpMethod == "GET" && req.url?.path == "/api/runs" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, "[]".data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        await store.killRun(id: "run_01")
        XCTAssertEqual(store.bannerMessage, "Run kill signal sent.")
        XCTAssertFalse(store.bannerIsError)
    }

    func testWakeAgentAsOrgAdmin() async throws {
        let store = RunsStore(sessionStore: sessionStore, apiClientOverride: apiClient)

        RunsMockURLProtocol.requestHandler = { req in
            if req.httpMethod == "POST" && req.url?.path.contains("/api/members/mem_01/wake") == true {
                let res = HTTPURLResponse(url: req.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!
                return (res, "{\"id\":\"wake_rec_001\"}".data(using: .utf8)!)
            }
            if req.httpMethod == "GET" && req.url?.path.contains("/wakeups") == true {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, "[]".data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        await store.wakeMember(memberId: "mem_01")
        XCTAssertEqual(store.bannerMessage, "Agent wake scheduled (wake_rec_001).")
        XCTAssertFalse(store.bannerIsError)
    }
}
