import Foundation
import Testing
@testable import Harness

private final class TestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]

    func set<T>(_ key: String, _ value: T) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }

    func get<T>(_ key: String) -> T? {
        lock.lock()
        defer { lock.unlock() }
        return values[key] as? T
    }
}

private final class WorkspaceMockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var requestHandler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    static func setHandler(_ handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)) {
        lock.lock()
        requestHandler = handler
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

private func extractBody(from request: URLRequest) -> Data? {
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

private func makeWorkspaceTestClient(
    handler: @escaping @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)
) -> HarnessAPIClient {
    WorkspaceMockURLProtocol.setHandler(handler)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [WorkspaceMockURLProtocol.self]
    let session = URLSession(configuration: config)
    return HarnessAPIClient(
        origin: "http://localhost:4100",
        tokenProvider: { "test_token" },
        session: session
    )
}

private func loadFixtureData(named name: String) throws -> Data {
    let thisFile = URL(fileURLWithPath: #filePath)
    let root = thisFile
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let url = root.appendingPathComponent("contract/mobile-fixtures/\(name).json")
    if FileManager.default.fileExists(atPath: url.path) {
        return try Data(contentsOf: url)
    }
    for bundle in Bundle.allBundles {
        if let bUrl = bundle.url(forResource: name, withExtension: "json") {
            return try Data(contentsOf: bUrl)
        }
    }
    throw NSError(domain: "FixtureNotFound", code: 404)
}

@Suite("WorkspaceStoreTests", .serialized)
struct WorkspaceStoreTests {

    // MARK: - Dashboard Tests

    @Test("Dashboard range query calculation for 24h, 7d, 30d")
    func testDashboardRangeCalculations() {
        let reference = Date(timeIntervalSince1970: 1_700_000_000)
        let refMs = Int64(1_700_000_000 * 1000)
        let dayMs: Int64 = 86_400_000

        #expect(DashboardRange.twentyFourHours.sinceEpochMs(from: reference) == refMs - dayMs)
        #expect(DashboardRange.sevenDays.sinceEpochMs(from: reference) == refMs - (7 * dayMs))
        #expect(DashboardRange.thirtyDays.sinceEpochMs(from: reference) == refMs - (30 * dayMs))
    }

    @Test("DashboardStore loads fixture data and verifies members, tasks, quota")
    @MainActor
    func testDashboardLoading() async throws {
        let fixtureData = try loadFixtureData(named: "dashboard")

        let client = makeWorkspaceTestClient { request in
            #expect(request.url?.path == "/api/orgs/acme/dashboard")
            #expect(request.url?.query?.contains("since=") == true)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, fixtureData)
        }

        let store = DashboardStore(apiClient: client, orgSlug: "acme", orgId: "org_1")
        await store.load(range: .sevenDays)

        #expect(store.data != nil)
        #expect(store.data?.members.count == 1)
        #expect(store.data?.members.first?.handle == "alice")
        #expect(store.data?.quota.count == 1)
        #expect(store.data?.quota.first?.provider == "anthropic")
        #expect(store.data?.tasks.count == 1)
        #expect(store.data?.tasks.first?.title == "Setup Mobile Fixtures")
    }

    @Test("DashboardBudgetItem near cap and progress calculation")
    func testDashboardBudgetNearCap() {
        let normal = DashboardBudgetItem(id: "b1", monthlyUsd: 100.0, spentUsd: 50.0, ratio: 0.5, state: "ok")
        #expect(!normal.isNearCap)
        #expect(normal.displayRatio == 0.5)

        let nearCap = DashboardBudgetItem(id: "b2", monthlyUsd: 100.0, spentUsd: 85.0, ratio: 0.85, state: "warn")
        #expect(nearCap.isNearCap)

        let paused = DashboardBudgetItem(id: "b3", monthlyUsd: 100.0, spentUsd: 100.0, ratio: 1.0, state: "paused")
        #expect(paused.isNearCap)
    }

    // MARK: - Memory Tests: 409 Conflict & Resolution

    @Test("MemoryStore loads fixture notes and facets")
    @MainActor
    func testMemoryLoading() async throws {
        let fixtureData = try loadFixtureData(named: "memory")
        let parsed = try JSONDecoder().decode(MemoryFixtureResponse.self, from: fixtureData)

        let client = makeWorkspaceTestClient { request in
            let path = request.url?.path ?? ""
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!

            if path.contains("/memory/facets") {
                let facetsData = try! JSONEncoder().encode(parsed.facets)
                return (response, facetsData)
            } else if path.contains("/memory/notes") {
                let notesData = try! JSONEncoder().encode(parsed.notes)
                return (response, notesData)
            }
            return (response, Data())
        }

        let store = MemoryStore(apiClient: client, orgSlug: "acme", orgId: "org_1")
        await store.loadFacets()
        await store.loadNotes()

        #expect(store.facets.scopes["org"] == 5)
        #expect(store.notes.count == 1)
        #expect(store.notes.first?.title == "Mobile Device Authentication")
    }

    @Test("Memory PUT 409 conflict preserves local draft and allows overwrite resolution")
    @MainActor
    func testMemory409ConflictPreservationAndOverwrite() async throws {
        let fixtureData = try loadFixtureData(named: "memory")
        let parsed = try JSONDecoder().decode(MemoryFixtureResponse.self, from: fixtureData)
        guard let initialNote = parsed.note else {
            Issue.record("Missing note in fixture")
            return
        }

        let conflictHash = "conflict_hash_remote_newer_999"
        let remoteUpdatedNote = MemoryNoteDetail(
            id: initialNote.id,
            path: initialNote.path,
            scope: initialNote.scope,
            type: initialNote.type,
            title: initialNote.title,
            tags: initialNote.tags,
            sourceAgent: initialNote.sourceAgent,
            confidence: 1.0,
            created: initialNote.created,
            updated: "2026-11-14T12:00:00Z",
            hash: conflictHash,
            body: "# Mobile Device Authentication\n\nRemote edits landed while you typed.",
            canWrite: true
        )

        let recorder = TestRecorder()
        recorder.set("putAttempts", 0)

        let client = makeWorkspaceTestClient { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"

            if method == "PUT" && path.contains("/memory/notes/\(initialNote.id)") {
                let attempts: Int = recorder.get("putAttempts") ?? 0
                let nextAttempts = attempts + 1
                recorder.set("putAttempts", nextAttempts)

                if let body = extractBody(from: request),
                   let updateReq = try? JSONDecoder().decode(MemoryUpdateNoteRequest.self, from: body) {
                    recorder.set("lastBaseHashSent", updateReq.baseHash)
                }

                if nextAttempts == 1 {
                    // 1st attempt: return 409 conflict
                    let conflictJson = "{\"error\":\"conflict\",\"hash\":\"\(conflictHash)\"}"
                    let res409 = HTTPURLResponse(
                        url: request.url!,
                        statusCode: 409,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"]
                    )!
                    return (res409, conflictJson.data(using: .utf8)!)
                } else {
                    // 2nd attempt after overwrite: return success with redacted=true
                    let successNote = MemoryNoteDetail(
                        id: initialNote.id,
                        path: initialNote.path,
                        scope: initialNote.scope,
                        type: initialNote.type,
                        title: initialNote.title,
                        tags: initialNote.tags,
                        sourceAgent: initialNote.sourceAgent,
                        confidence: 1.0,
                        created: initialNote.created,
                        updated: "2026-11-14T12:05:00Z",
                        hash: "final_hash_333",
                        body: "My local draft that MUST NOT be lost!",
                        canWrite: true
                    )
                    let writeResult = MemoryWriteResult(note: successNote, redacted: true)
                    let okRes = HTTPURLResponse(
                        url: request.url!,
                        statusCode: 200,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "application/json"]
                    )!
                    return (okRes, try! JSONEncoder().encode(writeResult))
                }
            } else if method == "GET" && path.contains("/memory/notes/\(initialNote.id)") {
                let okRes = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (okRes, try! JSONEncoder().encode(remoteUpdatedNote))
            } else if method == "GET" && path.contains("/memory/notes") {
                let okRes = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (okRes, try! JSONEncoder().encode(parsed.notes))
            }

            return (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }

        let store = MemoryStore(apiClient: client, orgSlug: "acme", orgId: "org_1")
        store.selectedNote = initialNote
        let myPreciousDraft = "My local draft that MUST NOT be lost!"

        // Attempt save with old baseHash -> triggers 409
        try? await store.saveNote(
            id: initialNote.id,
            body: myPreciousDraft,
            baseHash: initialNote.hash
        )

        // CRITICAL VERIFICATION: Local draft MUST be preserved intact!
        #expect(store.localDraft == myPreciousDraft)
        #expect(store.isConflictPresented == true)
        #expect(store.conflictState != nil)
        #expect(store.conflictState?.latestRemote.hash == conflictHash)

        // Now test resolution: "Keep My Draft & Overwrite Latest"
        try await store.resolveConflictWithDraftOverwrite(id: initialNote.id)

        let putAttempts: Int = recorder.get("putAttempts") ?? 0
        let lastBaseHashSent: String = recorder.get("lastBaseHashSent") ?? ""

        #expect(putAttempts == 2)
        #expect(lastBaseHashSent == conflictHash)
        #expect(store.localDraft == myPreciousDraft)
        #expect(store.isConflictPresented == false)
        #expect(store.conflictState == nil)
        #expect(store.wasLastSaveRedacted == true)
    }

    @Test("Memory conflict resolution via Reload Remote")
    @MainActor
    func testMemoryConflictReloadRemote() {
        let store = MemoryStore(orgSlug: "acme")
        let initialNote = MemoryNoteDetail(
            id: "n1", path: "p1", scope: "org", type: "fact",
            title: "T1", tags: [], sourceAgent: "human",
            created: "", updated: "", hash: "h1", body: "Initial body"
        )
        let remoteNote = MemoryNoteDetail(
            id: "n1", path: "p1", scope: "org", type: "fact",
            title: "T1", tags: [], sourceAgent: "human",
            created: "", updated: "", hash: "h2", body: "Remote changed body"
        )

        store.selectedNote = initialNote
        store.localDraft = "Unsaved draft"
        store.conflictState = MemoryConflictState(
            latestRemote: remoteNote,
            localDraft: store.localDraft,
            conflictHash: "h2"
        )
        store.isConflictPresented = true

        store.resolveConflictWithRemoteReload()

        #expect(store.localDraft == "Remote changed body")
        #expect(store.selectedNote?.hash == "h2")
        #expect(store.isConflictPresented == false)
        #expect(store.conflictState == nil)
    }

    @Test("Memory write revert and lesson decision")
    @MainActor
    func testWriteRevertAndLessonDecision() async throws {
        let recorder = TestRecorder()

        let client = makeWorkspaceTestClient { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!

            if method == "POST" && path.contains("/memory/writes/") && path.contains("/revert") {
                recorder.set("revertedId", path)
                let note = MemoryNoteDetail(
                    id: "n1", path: "p", scope: "org", type: "fact",
                    title: "T", tags: [], sourceAgent: "human",
                    created: "", updated: "", hash: "h_rev", body: "Reverted", canWrite: true
                )
                return (response, try! JSONEncoder().encode(MemoryWriteResult(note: note)))
            } else if method == "POST" && path.contains("/memory/lessons/") {
                recorder.set("decidedId", path)
                if let body = extractBody(from: request),
                   let req = try? JSONDecoder().decode(MemoryLessonDecisionRequest.self, from: body) {
                    recorder.set("decisionTaken", req.decision)
                }
                let lesson = MemoryLesson(
                    id: "lsn_1", body: "Rule", scope: "org",
                    type: "lesson", status: "accepted", createdAt: 1000
                )
                return (response, try! JSONEncoder().encode(lesson))
            } else if method == "GET" && path.contains("/memory/writes") {
                return (response, try! JSONEncoder().encode([MemoryWrite]()))
            } else if method == "GET" && path.contains("/memory/notes") {
                return (response, try! JSONEncoder().encode([MemoryNoteSummary]()))
            } else if method == "GET" && path.contains("/memory/lessons") {
                return (response, try! JSONEncoder().encode([MemoryLesson]()))
            }
            return (response, Data())
        }

        let store = MemoryStore(apiClient: client, orgSlug: "acme", isOrgAdmin: true)

        try await store.revertWrite(id: "wrt_401")
        let revertedId: String = recorder.get("revertedId") ?? ""
        #expect(revertedId.contains("wrt_401/revert"))

        try await store.decideLesson(id: "lsn_501", decision: "accept", reason: "Good rule")
        let decidedId: String = recorder.get("decidedId") ?? ""
        let decisionTaken: String = recorder.get("decisionTaken") ?? ""
        #expect(decidedId.contains("lsn_501"))
        #expect(decisionTaken == "accept")
    }

    @Test("Memory line diff engine computation")
    func testLineDiffEngine() {
        let before = "Line 1\nLine 2"
        let after = "Line 1\nLine 2 modified\nLine 3"

        let diff = MemoryDiffEngine.computeLineDiff(before: before, after: after)
        #expect(diff.contains(where: { $0.kind == .unchanged && $0.text == "Line 1" }))
        #expect(diff.contains(where: { $0.kind == .removed && $0.text == "Line 2" }))
        #expect(diff.contains(where: { $0.kind == .added && $0.text == "Line 2 modified" }))
        #expect(diff.contains(where: { $0.kind == .added && $0.text == "Line 3" }))
    }

    // MARK: - Account, 25-toggle Matrix & Devices Tests

    @Test("AccountStore loads and optimistically toggles 25-cell notification matrix")
    @MainActor
    func testNotificationMatrixToggleAndRollback() async throws {
        let recorder = TestRecorder()
        recorder.set("shouldFailPut", false)

        let initialPrefs = [
            NotificationPref(channel: .push, kind: .approvalRequested, enabled: false),
            NotificationPref(channel: .email, kind: .mention, enabled: true)
        ]

        let client = makeWorkspaceTestClient { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"

            if method == "GET" && path.contains("/notify/prefs") {
                let okRes = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (okRes, try! JSONEncoder().encode(initialPrefs))
            } else if method == "PUT" && path.contains("/notify/prefs") {
                let shouldFail: Bool = recorder.get("shouldFailPut") ?? false
                if shouldFail {
                    let failRes = HTTPURLResponse(
                        url: request.url!,
                        statusCode: 500,
                        httpVersion: nil,
                        headerFields: ["Content-Type": "text/plain"]
                    )!
                    return (failRes, "Server error".data(using: .utf8)!)
                }

                var lastChannel = ""
                var lastKind = ""
                var lastEnabled = false

                if let body = extractBody(from: request),
                   let req = try? JSONDecoder().decode(NotificationPref.self, from: body) {
                    lastChannel = req.channel.rawValue
                    lastKind = req.kind.rawValue
                    lastEnabled = req.enabled
                    recorder.set("lastPutChannel", lastChannel)
                    recorder.set("lastPutKind", lastKind)
                    recorder.set("lastPutEnabled", lastEnabled)
                }

                var updated = initialPrefs
                if let idx = updated.firstIndex(where: { $0.channel.rawValue == lastChannel && $0.kind.rawValue == lastKind }) {
                    updated[idx].enabled = lastEnabled
                } else if let ch = NotificationChannel(rawValue: lastChannel),
                          let kd = NotificationKind(rawValue: lastKind) {
                    updated.append(NotificationPref(channel: ch, kind: kd, enabled: lastEnabled))
                }

                let okRes = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (okRes, try! JSONEncoder().encode(updated))
            }

            return (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }

        let store = AccountStore(apiClient: client, orgSlug: "acme")
        await store.loadPrefs()

        #expect(!store.isEnabled(channel: .push, kind: .approvalRequested))
        #expect(store.isEnabled(channel: .email, kind: .mention))

        // Toggle Push + ApprovalRequested: false -> true
        await store.togglePref(channel: .push, kind: .approvalRequested)
        let lastPutChannel: String = recorder.get("lastPutChannel") ?? ""
        let lastPutKind: String = recorder.get("lastPutKind") ?? ""
        let lastPutEnabled: Bool = recorder.get("lastPutEnabled") ?? false

        #expect(lastPutChannel == "push")
        #expect(lastPutKind == "approval_requested")
        #expect(lastPutEnabled == true)
        #expect(store.isEnabled(channel: .push, kind: .approvalRequested))

        // Test failure rollback
        recorder.set("shouldFailPut", true)
        await store.togglePref(channel: .push, kind: .approvalRequested)
        // Should have rolled back to true
        #expect(store.isEnabled(channel: .push, kind: .approvalRequested))
        #expect(store.errorMessage != nil)
    }

    @Test("AccountStore device list and revocation")
    @MainActor
    func testDeviceListAndRevoke() async throws {
        let meData = try loadFixtureData(named: "me")
        let me = try JSONDecoder().decode(MeResponse.self, from: meData)
        let recorder = TestRecorder()

        let client = makeWorkspaceTestClient { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"

            if method == "GET" && path.contains("/auth/mobile/devices") {
                let okRes = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (okRes, try! JSONEncoder().encode(me.devices))
            } else if method == "DELETE" && path.contains("/auth/mobile/devices/") {
                recorder.set("revokedDeviceId", path)
                let okRes = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )!
                return (okRes, "{\"ok\":true}".data(using: .utf8)!)
            }

            return (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }

        let store = AccountStore(apiClient: client, orgSlug: "acme")
        await store.loadDevices()

        #expect(store.devices.count == 1)
        let device = store.devices[0]
        #expect(device.id == "dev_019318894978701388bb69b7f5256004")

        try await store.revokeDevice(id: device.id)
        let revokedDeviceId: String = recorder.get("revokedDeviceId") ?? ""
        #expect(revokedDeviceId.contains(device.id))
        #expect(store.devices.isEmpty)
    }
}
