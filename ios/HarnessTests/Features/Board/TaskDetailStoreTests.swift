import Foundation
import Testing
@testable import Harness

private final class TaskDetailMockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    static func setHandler(_ handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) {
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

@MainActor
private func makeTestClient(
    handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
) -> HarnessAPIClient {
    TaskDetailMockURLProtocol.setHandler(handler)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [TaskDetailMockURLProtocol.self]
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

@Suite("TaskDetailStoreTests", .serialized)
struct TaskDetailStoreTests {

    @Test("TaskDetailStore edit, checkout, release, deps, comment, and wake")
    @MainActor
    func testTaskDetailOperations() async throws {
        let fixtureData = try loadFixtureData(named: "board-tasks")
        let parsed = try JSONDecoder().decode(BoardTasksResponse.self, from: fixtureData)
        let initialDetail = parsed.detail!
        let taskId = initialDetail.task.id

        var recordedRequests: [(method: String, path: String)] = []

        let client = makeTestClient { req in
            let method = req.httpMethod ?? "GET"
            let path = req.url?.path ?? ""
            recordedRequests.append((method: method, path: path))

            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!

            if path.contains("/deps") {
                return (res, "{\"ok\":true}".data(using: .utf8)!)
            }
            if path.contains("/wake") {
                return (res, "{\"ok\":true,\"id\":\"wke_1\"}".data(using: .utf8)!)
            }
            if path.contains("/comments") {
                let comment = TaskComment(id: "com_new", taskId: taskId, author: nil, body: "Great progress", createdAt: 2000)
                return (res, try! JSONEncoder().encode(comment))
            }
            if path.contains("/checkout") {
                let checkedOut = BoardTask(
                    id: taskId, orgId: "org_1", projectId: "prj_1",
                    number: 1, title: initialDetail.task.title, description: initialDetail.task.description,
                    status: initialDetail.task.status, rank: initialDetail.task.rank,
                    holderId: "mem_me", checkedOutAt: 1234567,
                    createdBy: "mem_1", createdAt: 1000, updatedAt: 1000
                )
                return (res, try! JSONEncoder().encode(checkedOut))
            }
            if path.contains("/release") {
                let released = BoardTask(
                    id: taskId, orgId: "org_1", projectId: "prj_1",
                    number: 1, title: initialDetail.task.title, description: initialDetail.task.description,
                    status: initialDetail.task.status, rank: initialDetail.task.rank,
                    holderId: nil, checkedOutAt: nil,
                    createdBy: "mem_1", createdAt: 1000, updatedAt: 1000
                )
                return (res, try! JSONEncoder().encode(released))
            }
            if method == "PATCH" {
                let updated = BoardTask(
                    id: taskId, orgId: "org_1", projectId: "prj_1",
                    number: 1, title: "Updated Title", description: "Updated Desc",
                    status: initialDetail.task.status, rank: initialDetail.task.rank,
                    createdBy: "mem_1", createdAt: 1000, updatedAt: 1000
                )
                return (res, try! JSONEncoder().encode(updated))
            }
            if method == "POST" && path.contains("/tasks") {
                let subtask = BoardTask(
                    id: "tsk_sub_1", orgId: "org_1", projectId: "prj_1",
                    number: 2, parentId: taskId, title: "New Subtask", description: "",
                    status: "todo", rank: 100, createdBy: "mem_1", createdAt: 1000, updatedAt: 1000
                )
                return (res, try! JSONEncoder().encode(subtask))
            }
            // GET /api/tasks/:id
            return (res, try! JSONEncoder().encode(initialDetail))
        }

        var updatedFromCallback: BoardTask?
        let detailStore = TaskDetailStore(
            taskId: taskId,
            apiClient: client,
            onTaskUpdated: { updated in
                updatedFromCallback = updated
            }
        )
        await detailStore.loadDetail()
        #expect(detailStore.task?.title == "Setup Mobile Fixtures")

        // Edit
        try await detailStore.update(title: "Updated Title", description: "Updated Desc")
        #expect(detailStore.task?.title == "Updated Title")
        #expect(updatedFromCallback?.title == "Updated Title")

        // Checkout
        try await detailStore.checkout()
        #expect(detailStore.task?.holderId == "mem_me")
        #expect(detailStore.task?.checkedOutAt == 1234567)

        // Release
        try await detailStore.release()
        #expect(detailStore.task?.holderId == nil)
        #expect(detailStore.task?.checkedOutAt == nil)

        // Dependency add & remove
        try await detailStore.addDependency(dependsOnTaskId: "tsk_dep_1")
        #expect(recordedRequests.contains(where: { $0.method == "POST" && $0.path.hasSuffix("/deps") }))

        try await detailStore.removeDependency(dependsOnTaskId: "tsk_dep_1")
        #expect(recordedRequests.contains(where: { $0.method == "DELETE" && $0.path.hasSuffix("/deps") }))

        // Subtask creation
        let sub = try await detailStore.createSubtask(title: "New Subtask")
        #expect(sub.title == "New Subtask")
        #expect(recordedRequests.contains(where: { $0.method == "POST" && $0.path.contains("/tasks") }))

        // Comment
        try await detailStore.addComment(body: "Great progress")
        #expect(detailStore.comments.count == 2)
        #expect(detailStore.comments.last?.body == "Great progress")

        // Wake agent
        try await detailStore.wakeAgent(assigneeId: "mem_agent_1")
        #expect(detailStore.wakeSuccess == true)
        #expect(recordedRequests.contains(where: { $0.method == "POST" && $0.path == "/api/members/mem_agent_1/wake" }))
    }
}
