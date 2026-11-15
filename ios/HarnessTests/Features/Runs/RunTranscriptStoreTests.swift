import XCTest
@testable import Harness

private final class TranscriptMockURLProtocol: URLProtocol, @unchecked Sendable {
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
final class RunTranscriptStoreTests: XCTestCase {
    private var sessionStore: AppSessionStore!
    private var testSession: URLSession!
    private var apiClient: HarnessAPIClient!

    override func setUp() async throws {
        TranscriptMockURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [TranscriptMockURLProtocol.self]
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

    func testIncrementalTranscriptAppendAndDeduplicationOnWSNudge() async throws {
        let transcriptStore = RunTranscriptStore(
            runId: "run_01",
            sessionStore: sessionStore,
            apiClientOverride: apiClient
        )

        // 1. Initial load returning events with rowid 1 and 2
        let initialJson = """
        {
          "run": {
            "id": "run_01",
            "agentId": "claude-code",
            "repo": "/Users/alice/projects/harness",
            "prompt": "Do task",
            "state": "running",
            "createdAt": 1000,
            "startedAt": 1001,
            "inputTokens": 10,
            "outputTokens": 5
          },
          "events": [
            {
              "rowid": 1,
              "ts": 1002,
              "kind": "tool_call",
              "toolName": "glob",
              "body": "Searching files"
            },
            {
              "rowid": 2,
              "ts": 1005,
              "kind": "command",
              "command": "npm test",
              "exitCode": 0,
              "body": "Tests passed"
            }
          ]
        }
        """

        TranscriptMockURLProtocol.requestHandler = { req in
            if req.url?.path == "/api/runs/run_01" && req.url?.query == "after=0" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, initialJson.data(using: .utf8)!)
            }
            if req.url?.path == "/api/approvals" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, "[]".data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        await transcriptStore.loadInitial()
        XCTAssertEqual(transcriptStore.run?.id, "run_01")
        XCTAssertEqual(transcriptStore.events.count, 2)
        XCTAssertEqual(transcriptStore.lastRowid, 2)

        // 2. Poll incremental with after=2 returning rowid 2 (duplicate) and 3 (new)
        let nudgeJson = """
        {
          "run": {
            "id": "run_01",
            "agentId": "claude-code",
            "repo": "/Users/alice/projects/harness",
            "prompt": "Do task",
            "state": "running",
            "createdAt": 1000,
            "startedAt": 1001,
            "inputTokens": 15,
            "outputTokens": 10
          },
          "events": [
            {
              "rowid": 2,
              "ts": 1005,
              "kind": "command",
              "command": "npm test",
              "exitCode": 0,
              "body": "Tests passed"
            },
            {
              "rowid": 3,
              "ts": 1010,
              "kind": "guard",
              "guardLayer": "safety",
              "guardVerdict": "approved",
              "guardRule": "no_delete",
              "body": "Verified safe"
            }
          ]
        }
        """

        TranscriptMockURLProtocol.requestHandler = { req in
            if req.url?.path == "/api/runs/run_01" && req.url?.query == "after=2" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, nudgeJson.data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        await transcriptStore.pollIncremental()
        XCTAssertEqual(transcriptStore.events.count, 3)
        XCTAssertEqual(transcriptStore.events.map(\.rowid), [1, 2, 3])
        XCTAssertEqual(transcriptStore.lastRowid, 3)
    }

    func testInlineApprovalInTranscript() async throws {
        let transcriptStore = RunTranscriptStore(
            runId: "run_01",
            sessionStore: sessionStore,
            apiClientOverride: apiClient
        )

        let approvalsJson = """
        [
          {
            "id": "app_inline_1",
            "runId": "run_01",
            "command": "rm -rf build",
            "reason": "Clean build",
            "status": "pending",
            "createdAt": 1000,
            "expiresAt": 3000
          },
          {
            "id": "app_other",
            "runId": "run_different",
            "command": "other",
            "reason": "other",
            "status": "pending",
            "createdAt": 1000,
            "expiresAt": 3000
          }
        ]
        """

        TranscriptMockURLProtocol.requestHandler = { req in
            if req.url?.path == "/api/approvals" && req.url?.query == "status=pending" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, approvalsJson.data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        await transcriptStore.fetchInlineApprovals()
        XCTAssertEqual(transcriptStore.inlineApprovals.count, 1)
        XCTAssertEqual(transcriptStore.inlineApprovals.first?.id, "app_inline_1")

        // Decide approval
        TranscriptMockURLProtocol.requestHandler = { req in
            if req.httpMethod == "POST" && req.url?.path.contains("/api/approvals/app_inline_1") == true {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, """
                {
                  "id": "app_inline_1",
                  "runId": "run_01",
                  "command": "rm -rf build",
                  "reason": "Clean build",
                  "status": "approved",
                  "createdAt": 1000,
                  "expiresAt": 3000,
                  "decidedAt": 2000
                }
                """.data(using: .utf8)!)
            }
            throw URLError(.badURL)
        }

        await transcriptStore.decideApproval(id: "app_inline_1", decision: "approve")
        XCTAssertTrue(transcriptStore.inlineApprovals.isEmpty)
        XCTAssertEqual(transcriptStore.bannerMessage, "Guard approval marked approved.")
    }
}
