import XCTest
@testable import Harness

final class HarnessWSClientTests: XCTestCase {
    func testWsMessageDecodingAcrossAllTypes() throws {
        let jsonEvent = """
        {"type":"event","runId":"run_1","event":{"kind":"command","ts":1700000000}}
        """.data(using: .utf8)!
        let msgEvent = try JSONDecoder().decode(WsMessage.self, from: jsonEvent)
        guard case .event(let runId, let event) = msgEvent else {
            XCTFail("Expected event message")
            return
        }
        XCTAssertEqual(runId, "run_1")
        XCTAssertEqual(event.kind, "command")

        let jsonTask = """
        {"type":"task","projectId":"p_1","taskId":"t_1","kind":"updated"}
        """.data(using: .utf8)!
        let msgTask = try JSONDecoder().decode(WsMessage.self, from: jsonTask)
        guard case .task(let pId, let tId, let kind) = msgTask else {
            XCTFail("Expected task message")
            return
        }
        XCTAssertEqual(pId, "p_1")
        XCTAssertEqual(tId, "t_1")
        XCTAssertEqual(kind, "updated")

        let jsonChat = """
        {"type":"chat","channelId":"c_1","messageId":"m_1","threadRootId":null}
        """.data(using: .utf8)!
        let msgChat = try JSONDecoder().decode(WsMessage.self, from: jsonChat)
        guard case .chat(let cId, let mId, let root) = msgChat else {
            XCTFail("Expected chat message")
            return
        }
        XCTAssertEqual(cId, "c_1")
        XCTAssertEqual(mId, "m_1")
        XCTAssertNil(root)

        let jsonDashboard = """
        {"type":"dashboard"}
        """.data(using: .utf8)!
        let msgDashboard = try JSONDecoder().decode(WsMessage.self, from: jsonDashboard)
        XCTAssertEqual(msgDashboard, .dashboard)

        let jsonMemory = """
        {"type":"memory","orgId":"org_42"}
        """.data(using: .utf8)!
        let msgMemory = try JSONDecoder().decode(WsMessage.self, from: jsonMemory)
        guard case .memory(let orgId) = msgMemory else {
            XCTFail("Expected memory message")
            return
        }
        XCTAssertEqual(orgId, "org_42")
    }

    func test4401CloseCodeTransitionsToRevoked() async {
        let client = HarnessWSClient(
            origin: "http://localhost:4100",
            topic: "runs",
            tokenProvider: { "token" }
        )
        let initialState = await client.state
        XCTAssertEqual(initialState, .disconnected)

        let handled = await client.handleCloseCode(4401)
        XCTAssertTrue(handled)
        let finalState = await client.state
        XCTAssertEqual(finalState, .revoked, "Close code 4401 must transition state to .revoked immediately")
    }

    func testExponentialBackoffCalculation() {
        let b0 = HarnessWSClient.calculateBackoff(attempt: 0, jitterOffset: 0.0)
        let b1 = HarnessWSClient.calculateBackoff(attempt: 1, jitterOffset: 0.0)
        let b2 = HarnessWSClient.calculateBackoff(attempt: 2, jitterOffset: 0.0)
        let b3 = HarnessWSClient.calculateBackoff(attempt: 3, jitterOffset: 0.0)
        let b4 = HarnessWSClient.calculateBackoff(attempt: 4, jitterOffset: 0.0)
        let b5 = HarnessWSClient.calculateBackoff(attempt: 5, jitterOffset: 0.0)

        XCTAssertEqual(b0, 1.0, accuracy: 0.01)
        XCTAssertEqual(b1, 2.0, accuracy: 0.01)
        XCTAssertEqual(b2, 4.0, accuracy: 0.01)
        XCTAssertEqual(b3, 8.0, accuracy: 0.01)
        XCTAssertEqual(b4, 16.0, accuracy: 0.01)
        XCTAssertEqual(b5, 30.0, accuracy: 0.01, "Should be capped at 30 seconds")

        for attempt in 0...10 {
            let backoff = HarnessWSClient.calculateBackoff(attempt: attempt)
            XCTAssertGreaterThanOrEqual(backoff, 0.1)
            XCTAssertLessThanOrEqual(backoff, 30.0)
        }
    }
}
