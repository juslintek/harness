import Foundation
import HarnessKit
import XCTest

private struct MissingBinary: Error, CustomStringConvertible {
    let description: String
}

@MainActor
final class HarnessKitTests: XCTestCase {
    private func binary() throws -> URL {
        let fromEnv = ProcessInfo.processInfo.environment["HARNESS_BIN"].flatMap { $0.isEmpty ? nil : $0 }
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let path = fromEnv ?? packageRoot.appendingPathComponent("../../zig/zig-out/bin/harness").standardized.path
        guard FileManager.default.isExecutableFile(atPath: path) else {
            let message = "harness binary not found at \(path). Build it with: cd zig && zig build -Doptimize=ReleaseSafe -Dembed-ui=false (or set HARNESS_BIN)"
            XCTFail(message)
            throw MissingBinary(description: message)
        }
        return URL(fileURLWithPath: path)
    }

    private func startBackend() async throws -> (backend: BackendProcess, client: APIClient, binary: URL) {
        let binary = try binary()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("harness-test-\(UUID().uuidString)")
        let backend = BackendProcess(home: home, binary: binary)
        addTeardownBlock { @MainActor in
            backend.stop()
            try? FileManager.default.removeItem(at: home)
        }
        await backend.start()
        guard case .running(let port) = backend.state else {
            XCTFail("backend not running: \(backend.state)\n\(backend.log.suffix(15).joined(separator: "\n"))")
            throw MissingBinary(description: "backend did not start")
        }
        return (backend, APIClient(port: port), binary)
    }

    private func enroll(_ email: String, backend: BackendProcess, client: APIClient, binary: URL) throws {
        let child = Process()
        child.executableURL = binary
        child.arguments = ["enroll", "--email", email, "--name", "Test User"]
        child.environment = [
            "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin",
            "HARNESS_HOME": backend.home.path,
            "HARNESS_ORIGIN": client.origin,
        ]
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        child.waitUntilExit()
        XCTAssertEqual(child.terminationStatus, 0, "harness enroll failed")
    }

    private func emailCode(for email: String, in backend: BackendProcess) async throws -> String {
        let marker = "email code for \(email): "
        for _ in 0..<100 {
            if let line = backend.log.last(where: { $0.contains(marker) }),
               let range = line.range(of: marker) {
                return String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("no '\(marker)' line in backend log: \(backend.log.suffix(10))")
        throw MissingBinary(description: "no code")
    }

    private func signIn(_ email: String, _ fixture: (backend: BackendProcess, client: APIClient, binary: URL)) async throws {
        try enroll(email, backend: fixture.backend, client: fixture.client, binary: fixture.binary)
        try await fixture.client.requestCode(email: email)
        let code = try await emailCode(for: email, in: fixture.backend)
        let user = try await fixture.client.verify(email: email, code: code)
        XCTAssertEqual(user.email, email)
    }

    private func processIsGone(_ pid: Int32) async throws -> Bool {
        for _ in 0..<100 {
            if kill(pid, 0) == -1, errno == ESRCH { return true }
            try await Task.sleep(for: .milliseconds(50))
        }
        return false
    }

    func testStartHealthStopLeavesNoChild() async throws {
        let (backend, client, _) = try await startBackend()
        let health = try await client.health()
        XCTAssertTrue(health.ok)
        XCTAssertFalse(health.instanceId.isEmpty)
        XCTAssertEqual(backend.health, health)

        let pid = try XCTUnwrap(backend.pid)
        backend.stop()
        XCTAssertEqual(backend.state, .stopped)
        let gone = try await processIsGone(pid)
        XCTAssertTrue(gone, "child \(pid) still alive after stop()")
    }

    func testEmailSignInFlow() async throws {
        let fixture = try await startBackend()
        let client = fixture.client
        let email = "flow@example.com"
        try await signIn(email, fixture)

        let me = try await client.me()
        XCTAssertEqual(me.user.email, email)
        XCTAssertEqual(me.session.method, "email")

        let sessions = try await client.sessions()
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions.first?.current, true)

        try await client.logout()
        do {
            _ = try await client.me()
            XCTFail("me() succeeded after logout")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
    }

    func testWrongCodeAndForbiddenRoute() async throws {
        let fixture = try await startBackend()
        let client = fixture.client
        let email = "errors@example.com"
        try enroll(email, backend: fixture.backend, client: client, binary: fixture.binary)
        try await client.requestCode(email: email)

        do {
            _ = try await client.verify(email: email, code: "000000")
            XCTFail("wrong code was accepted")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        let health = try await client.health()
        XCTAssertTrue(health.ok, "backend should survive a rejected code")

        let code = try await emailCode(for: email, in: fixture.backend)
        _ = try await client.verify(email: email, code: code)
        do {
            _ = try await client.get("/api/runs")
            XCTFail("non-admin could list runs")
        } catch {
            XCTAssertEqual(error as? APIError, .forbidden)
        }
    }

    func testKilledChildIsReportedAsUnexpectedExit() async throws {
        let (backend, _, _) = try await startBackend()
        let pid = try XCTUnwrap(backend.pid)
        kill(pid, SIGKILL)
        for _ in 0..<100 {
            if case .exited = backend.state { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard case .exited(let reason) = backend.state else {
            return XCTFail("state after SIGKILL: \(backend.state)")
        }
        XCTAssertTrue(reason.contains("signal 9"), reason)
        XCTAssertNil(backend.pid)
    }
}
