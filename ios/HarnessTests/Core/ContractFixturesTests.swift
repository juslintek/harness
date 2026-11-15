import XCTest
import CryptoKit
@testable import Harness

final class ContractFixturesTests: XCTestCase {
    private func loadFixtureData(named name: String) throws -> Data {
        let testBundle = Bundle(for: Self.self)
        if let url = testBundle.url(forResource: name, withExtension: "json") {
            return try Data(contentsOf: url)
        }
        let thisFile = URL(fileURLWithPath: #filePath)
        let fixturesDir = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("contract/mobile-fixtures")
        let fileURL = fixturesDir.appendingPathComponent("\(name).json")
        return try Data(contentsOf: fileURL)
    }

    func testDecodeMe() throws {
        let data = try loadFixtureData(named: "me")
        let me = try JSONDecoder().decode(MeResponse.self, from: data)
        XCTAssertEqual(me.user.id, "usr_019318894978701388bb69b7f5256001")
        XCTAssertEqual(me.user.name, "Alice Cooper")
        XCTAssertTrue(me.user.instanceAdmin)
        XCTAssertEqual(me.orgs.count, 1)
        XCTAssertEqual(me.orgs[0].role, "admin")
        XCTAssertEqual(me.devices.count, 1)
        XCTAssertTrue(me.devices[0].current)
    }

    func testDecodeApprovals() throws {
        let data = try loadFixtureData(named: "approvals")
        let approvals = try JSONDecoder().decode([Approval].self, from: data)
        XCTAssertEqual(approvals.count, 2)
        XCTAssertEqual(approvals[0].status, "pending")
        XCTAssertEqual(approvals[1].status, "approved")
        XCTAssertEqual(approvals[1].decidedBy, "usr_019318894978701388bb69b7f5256001")
    }

    func testDecodeRunDetail() throws {
        let data = try loadFixtureData(named: "run-detail")
        let detail = try JSONDecoder().decode(RunDetail.self, from: data)
        XCTAssertEqual(detail.run.id, "run_019318894978701388bb69b7f5256010")
        XCTAssertEqual(detail.run.agentId, "claude-code")
        XCTAssertEqual(detail.events.count, 3)
        XCTAssertEqual(detail.events[0].kind, "tool_call")
        XCTAssertEqual(detail.events[1].kind, "command")
        XCTAssertEqual(detail.events[2].kind, "guard")
        XCTAssertEqual(detail.events[2].guardVerdict, "denied")
    }

    func testDecodeBoardTasks() throws {
        let data = try loadFixtureData(named: "board-tasks")
        let board = try JSONDecoder().decode(BoardTasksResponse.self, from: data)
        XCTAssertEqual(board.tasks.count, 1)
        XCTAssertEqual(board.tasks[0].number, 1)
        XCTAssertEqual(board.deps.count, 1)
        XCTAssertEqual(board.detail?.comments.count, 1)
        XCTAssertEqual(board.detail?.comments[0].author?.handle, "alice")
    }

    func testDecodeMove409() throws {
        let data = try loadFixtureData(named: "move-409")
        let fixture = try JSONDecoder().decode(Move409Fixture.self, from: data)
        XCTAssertFalse(fixture.held.ok)
        XCTAssertEqual(fixture.held.reason, "held")
        XCTAssertEqual(fixture.depsOpen.open, [42, 43])
        XCTAssertEqual(fixture.childrenOpen.open, [44])
    }

    func testDecodeChatMessages() throws {
        let data = try loadFixtureData(named: "chat-messages")
        let chat = try JSONDecoder().decode(ChatMessagesResponse.self, from: data)
        XCTAssertEqual(chat.channels.count, 1)
        XCTAssertEqual(chat.members.count, 1)
        XCTAssertEqual(chat.messages.count, 1)
        XCTAssertEqual(chat.messages[0].tasks.count, 1)
        XCTAssertEqual(chat.messages[0].tasks[0].number, 1)
    }

    func testDecodeMemory() throws {
        let data = try loadFixtureData(named: "memory")
        let memory = try JSONDecoder().decode(MemoryFixtureResponse.self, from: data)
        XCTAssertEqual(memory.facets.scopes["org"], 5)
        XCTAssertEqual(memory.notes.count, 1)
        XCTAssertEqual(memory.note?.title, "Mobile Device Authentication")
        XCTAssertEqual(memory.conflict409?.error, "conflict")
        XCTAssertEqual(memory.writes.count, 1)
        XCTAssertEqual(memory.lessons.count, 1)
    }

    func testDecodeDashboard() throws {
        let data = try loadFixtureData(named: "dashboard")
        let dashboard = try JSONDecoder().decode(DashboardResponse.self, from: data)
        XCTAssertEqual(dashboard.members.count, 1)
        XCTAssertEqual(dashboard.members[0].handle, "alice")
        XCTAssertEqual(dashboard.quota.count, 1)
        XCTAssertEqual(dashboard.quota[0].provider, "anthropic")
        XCTAssertEqual(dashboard.tasks.count, 1)
    }

    func testDecodeWsFrames() throws {
        let data = try loadFixtureData(named: "ws-frames")
        let frames = try JSONDecoder().decode([WsMessage].self, from: data)
        XCTAssertEqual(frames.count, 7)

        switch frames[0] {
        case .event(let runId, let event):
            XCTAssertEqual(runId, "run_019318894978701388bb69b7f5256010")
            XCTAssertEqual(event.kind, "command")
        default:
            XCTFail("Frame 0 should be event")
        }

        switch frames[1] {
        case .run(let run):
            XCTAssertEqual(run.id, "run_019318894978701388bb69b7f5256010")
        default:
            XCTFail("Frame 1 should be run")
        }

        switch frames[2] {
        case .approval(let app):
            XCTAssertEqual(app.id, "app_019318894978701388bb69b7f5256011")
        default:
            XCTFail("Frame 2 should be approval")
        }

        switch frames[3] {
        case .task(let pId, let tId, let kind):
            XCTAssertEqual(pId, "prj_019318894978701388bb69b7f5256006")
            XCTAssertEqual(tId, "tsk_019318894978701388bb69b7f5256020")
            XCTAssertEqual(kind, "updated")
        default:
            XCTFail("Frame 3 should be task")
        }

        switch frames[4] {
        case .chat(let cId, let mId, _):
            XCTAssertEqual(cId, "chn_019318894978701388bb69b7f5256030")
            XCTAssertEqual(mId, "msg_019318894978701388bb69b7f5256031")
        default:
            XCTFail("Frame 4 should be chat")
        }

        switch frames[5] {
        case .dashboard:
            break
        default:
            XCTFail("Frame 5 should be dashboard")
        }

        switch frames[6] {
        case .memory(let orgId):
            XCTAssertEqual(orgId, "org_019318894978701388bb69b7f5256003")
        default:
            XCTFail("Frame 6 should be memory")
        }
    }

    func testCryptoP256Vector() throws {
        let data = try loadFixtureData(named: "crypto-p256-vector")
        let vector = try JSONDecoder().decode(CryptoP256Vector.self, from: data)

        // 1. Verify SPKI is 91 bytes ASN.1 DER base64url encoded
        guard let spkiData = Data(base64URL: vector.publicKeySpki) else {
            XCTFail("Failed to decode SPKI base64url")
            return
        }
        XCTAssertEqual(spkiData.count, 91, "SPKI must be 91 bytes")

        // 2. Verify signature is 64 bytes IEEE P1363 raw representation base64url encoded
        guard let sigData = Data(base64URL: vector.signature) else {
            XCTFail("Failed to decode signature base64url")
            return
        }
        XCTAssertEqual(sigData.count, 64, "P-256 signature must be 64 bytes raw (r || s)")

        // 3. Verify signature of canonical payload
        let valid = DeviceKeySigner.verify(
            publicKeySpkiBase64Url: vector.publicKeySpki,
            signatureBase64Url: vector.signature,
            canonicalAscii: vector.canonicalPayload
        )
        XCTAssertTrue(valid, "Golden P-256 vector signature must be valid")

        // 4. Test generation and signing with fresh DeviceKeySigner
        let testKey = P256.Signing.PrivateKey()
        let signer = DeviceKeySigner(softwareKey: testKey)
        let generatedSpki = signer.publicKeySpkiBase64Url
        let generatedSpkiData = Data(base64URL: generatedSpki)!
        XCTAssertEqual(generatedSpkiData.count, 91)

        let testPayload = "harness-mobile-stepup-v1|http://localhost:4100|session-1|challenge-1|nonce-1"
        let expectation = expectation(description: "Sign completed")
        Task {
            let signature = try await signer.sign(canonicalAscii: testPayload)
            let sigData = Data(base64URL: signature)!
            XCTAssertEqual(sigData.count, 64)
            let ok = DeviceKeySigner.verify(
                publicKeySpkiBase64Url: generatedSpki,
                signatureBase64Url: signature,
                canonicalAscii: testPayload
            )
            XCTAssertTrue(ok)
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 3.0)
    }
}
