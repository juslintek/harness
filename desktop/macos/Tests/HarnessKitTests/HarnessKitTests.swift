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
        let backend = BackendProcess(home: home, launch: .zig(binary: binary))
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

private actor Events {
    private(set) var items: [String?] = []
    func add(_ item: String?) { items.append(item) }
}

/// Runs against the real TypeScript server. Users and sessions are written into harness.db by
/// Tests/support/seed.ts before the server starts, since the server has no CLI enroll.
@MainActor
final class TSServerTests: XCTestCase {
    private struct Seed: Decodable {
        let userId: String
        let cookie: String
    }

    private func fail(_ message: String) -> Error {
        XCTFail(message)
        return MissingBinary(description: message)
    }

    private func startServer() async throws -> (backend: BackendProcess, client: APIClient, seed: Seed) {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let serverDir = packageRoot.appendingPathComponent("../../code").standardized
        let launch: BackendLaunch
        do {
            launch = try .bun(serverDir: serverDir)
        } catch {
            // The message says what to provision: bun on PATH, and `bun install` in code/.
            throw fail("TS server not runnable: \(error)")
        }
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("harness-ts-test-\(UUID().uuidString)")
        let script = packageRoot.appendingPathComponent("Tests/support/seed.ts").path
        let seeder = Process()
        seeder.executableURL = launch.executable
        seeder.arguments = [script, home.path]
        seeder.currentDirectoryURL = serverDir
        let out = Pipe()
        seeder.standardOutput = out
        try seeder.run()
        let output = out.fileHandleForReading.readDataToEndOfFile()
        seeder.waitUntilExit()
        guard seeder.terminationStatus == 0, let seed = try? JSONDecoder().decode(Seed.self, from: output) else {
            throw fail("seed.ts failed with status \(seeder.terminationStatus): \(String(decoding: output, as: UTF8.self))")
        }
        let backend = BackendProcess(home: home, launch: launch)
        addTeardownBlock { @MainActor in
            backend.stop()
            try? FileManager.default.removeItem(at: home)
        }
        await backend.start()
        guard case .running(let port) = backend.state else {
            throw fail("TS server not running: \(backend.state)\n\(backend.log.suffix(15).joined(separator: "\n"))")
        }
        let client = APIClient(port: port)
        client.installSessionCookie(seed.cookie)
        return (backend, client, seed)
    }

    func testServerStartsAndIsHealthy() async throws {
        let (backend, client, _) = try await startServer()
        let health = try await client.health()
        XCTAssertTrue(health.ok)
        XCTAssertEqual(backend.health, health)
        let me = try await client.me()
        XCTAssertTrue(me.orgs.isEmpty)
    }

    func testOrgProjectTasksAndMove() async throws {
        let (_, client, seed) = try await startServer()
        let me = try await client.me()
        XCTAssertEqual(me.user.id, seed.userId)

        let org = try await client.createOrg(name: "Acme", slug: "acme")
        let listed = try await client.orgs()
        XCTAssertEqual(listed.map(\.slug), ["acme"])
        let project = try await client.createProject(orgSlug: org.slug, key: "WEB", name: "Web")
        let projects = try await client.projects(orgSlug: org.slug)
        XCTAssertEqual(projects, [project])

        let first = try await client.createTask(projectId: project.id, title: "First", description: "details")
        let second = try await client.createTask(projectId: project.id, title: "Second", status: .todo)
        let tasks = try await client.tasks(projectId: project.id)
        XCTAssertEqual(Set(tasks.map(\.id)), [first.id, second.id])
        XCTAssertEqual(first.status, .backlog)

        let moved = try await client.moveTask(id: first.id, to: .inProgress)
        XCTAssertEqual(moved.status, .inProgress)
        let after = try await client.tasks(projectId: project.id)
        XCTAssertEqual(after.first { $0.id == first.id }?.status, .inProgress)
        XCTAssertEqual(after.first { $0.id == second.id }?.status, .todo)

        _ = try await client.addComment(taskId: first.id, body: "hello")
        let detail = try await client.task(id: first.id)
        XCTAssertEqual(detail.task.status, .inProgress)
        XCTAssertEqual(detail.comments.map(\.body), ["hello"])
        let refreshed = try await client.me()
        XCTAssertEqual(refreshed.orgs.map(\.slug), ["acme"])
    }

    func testWebSocketFrameAfterTaskCreate() async throws {
        let (_, client, _) = try await startServer()
        let org = try await client.createOrg(name: "Live", slug: "live")
        let project = try await client.createProject(orgSlug: org.slug, key: "LV", name: "Live")

        let events = Events()
        let watcher = Task { await client.watch(topic: "org:\(org.id)") { await events.add($0) } }
        defer { watcher.cancel() }
        func waitFor(_ count: Int) async throws -> Bool {
            for _ in 0..<100 {
                if await events.items.count >= count { return true }
                try await Task.sleep(for: .milliseconds(50))
            }
            return false
        }
        let opened = try await waitFor(1)
        XCTAssertTrue(opened, "WebSocket did not open within 5 s")
        let settled = await events.items.count

        _ = try await client.createTask(projectId: project.id, title: "Ping")
        let framed = try await waitFor(settled + 1)
        XCTAssertTrue(framed, "no frame within 5 s after creating a task")
        let frames = await events.items.compactMap { $0 }
        XCTAssertFalse(frames.isEmpty, "only the open event arrived, no frame")
    }

    func testPathValuesStayInsideTheirSegment() async throws {
        let (_, client, seed) = try await startServer()
        do {
            try await client.revokeSession(id: "a/../../auth/me?x=1#y")
            XCTFail("revoking a bogus session id succeeded")
        } catch {
            guard case .server(let status, _) = error as? APIError else { return XCTFail("unexpected error \(error)") }
            XCTAssertEqual(status, 404)
        }
        let me = try await client.me()
        XCTAssertEqual(me.user.id, seed.userId)
    }

    func testUnauthenticatedClientIsRejected() async throws {
        let (backend, _, _) = try await startServer()
        guard case .running(let port) = backend.state else { return XCTFail("not running") }
        let stranger = APIClient(port: port)
        do {
            _ = try await stranger.tasks(projectId: "does-not-matter")
            XCTFail("unauthenticated tasks list succeeded")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
    }

    func testChatChannelMessagesAndMarkRead() async throws {
        let (_, client, _) = try await startServer()
        let org = try await client.createOrg(name: "Talk", slug: "talk")
        let channel = try await client.createGroup(orgSlug: org.slug, name: "random")
        let listed = try await client.channels(orgSlug: org.slug)
        XCTAssertTrue(listed.contains(channel))

        let first = try await client.postMessage(channelId: channel.id, body: "one")
        let second = try await client.postMessage(channelId: channel.id, body: "two")
        let messages = try await client.messages(channelId: channel.id)
        XCTAssertEqual(messages.map(\.body), ["one", "two"])
        XCTAssertEqual(messages.map(\.id), [first.id, second.id])

        let older = try await client.messages(channelId: channel.id, before: second.cursor)
        XCTAssertEqual(older.map(\.id), [first.id])

        let reply = try await client.postMessage(channelId: channel.id, body: "in thread", threadRootId: first.id)
        let thread = try await client.messages(channelId: channel.id, thread: first.id)
        XCTAssertEqual(thread.map(\.id), [reply.id])
        let topLevel = try await client.messages(channelId: channel.id)
        XCTAssertEqual(topLevel.first { $0.id == first.id }?.replyCount, 1)

        try await client.markRead(channelId: channel.id)
        let after = try await client.channels(orgSlug: org.slug)
        XCTAssertEqual(after.first { $0.id == channel.id }?.unread, 0)
    }

    func testWebSocketFrameAfterMessagePost() async throws {
        let (_, client, _) = try await startServer()
        let org = try await client.createOrg(name: "Live Talk", slug: "live-talk")
        let channel = try await client.createGroup(orgSlug: org.slug, name: "general")

        let events = Events()
        let watcher = Task { await client.watch(topic: "org:\(org.id)") { await events.add($0) } }
        defer { watcher.cancel() }
        func waitFor(_ count: Int) async throws -> Bool {
            for _ in 0..<100 {
                if await events.items.count >= count { return true }
                try await Task.sleep(for: .milliseconds(50))
            }
            return false
        }
        let opened = try await waitFor(1)
        XCTAssertTrue(opened, "WebSocket did not open within 5 s")
        let settled = await events.items.count

        _ = try await client.postMessage(channelId: channel.id, body: "ping")
        let framed = try await waitFor(settled + 1)
        XCTAssertTrue(framed, "no frame within 5 s after posting a message")
        let frames = await events.items.compactMap { $0 }
        XCTAssertFalse(frames.isEmpty, "only the open event arrived, no frame")
    }

    func testUnauthenticatedMessageListIsRejected() async throws {
        let (backend, _, _) = try await startServer()
        guard case .running(let port) = backend.state else { return XCTFail("not running") }
        do {
            _ = try await APIClient(port: port).messages(channelId: "does-not-matter")
            XCTFail("unauthenticated message list succeeded")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
    }
}
