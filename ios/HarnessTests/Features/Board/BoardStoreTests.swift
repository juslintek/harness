import Foundation
import Testing
@testable import Harness

private final class BoardMockURLProtocol: URLProtocol, @unchecked Sendable {
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
    BoardMockURLProtocol.setHandler(handler)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [BoardMockURLProtocol.self]
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

@Suite("BoardStoreTests", .serialized)
struct BoardStoreTests {

    @Test("Column grouping and rank sorting from board-tasks fixture")
    @MainActor
    func testColumnGroupingAndRankSorting() throws {
        let boardData = try loadFixtureData(named: "board-tasks")
        let parsed = try JSONDecoder().decode(BoardTasksResponse.self, from: boardData)
        #expect(parsed.tasks.count == 1)

        let task1 = parsed.tasks[0]
        let task2 = BoardTask(
            id: "tsk_2", orgId: task1.orgId, projectId: task1.projectId,
            number: 2, title: "Second Task", description: "Desc",
            status: "in_progress", rank: 500, assigneeId: "mem_other",
            createdBy: task1.createdBy, createdAt: 1000, updatedAt: 1000
        )
        let task3 = BoardTask(
            id: "tsk_3", orgId: task1.orgId, projectId: task1.projectId,
            number: 3, title: "Third Task", description: "Desc",
            status: "todo", rank: 1500, assigneeId: task1.assigneeId,
            createdBy: task1.createdBy, createdAt: 1000, updatedAt: 1000
        )

        let store = BoardStore(currentMemberId: task1.assigneeId)
        store.tasks = [task1, task2, task3]
        store.dependencies = parsed.deps

        // Grouping & sorting
        let inProgress = store.tasks(for: .inProgress)
        #expect(inProgress.count == 2)
        #expect(inProgress[0].id == "tsk_2") // rank 500 comes before 1000
        #expect(inProgress[1].id == task1.id) // rank 1000

        let todo = store.tasks(for: .todo)
        #expect(todo.count == 1)
        #expect(todo[0].id == "tsk_3")

        let backlog = store.tasks(for: .backlog)
        #expect(backlog.isEmpty)

        // Assignee filtering
        store.assigneeFilter = .mine
        #expect(store.filteredTasks.count == 2)
        #expect(store.tasks(for: .inProgress).count == 1)
        #expect(store.tasks(for: .inProgress).first?.id == task1.id)

        store.assigneeFilter = .member(id: "mem_other", handle: "other")
        #expect(store.filteredTasks.count == 1)
        #expect(store.filteredTasks.first?.id == "tsk_2")

        store.assigneeFilter = .all
        #expect(store.filteredTasks.count == 3)
        #expect(store.dependencyCount(for: task1.id) == 1)
    }

    @Test("Optimistic move success updates column and task")
    @MainActor
    func testOptimisticMoveSuccess() async throws {
        let task = BoardTask(
            id: "tsk_move_1", orgId: "org_1", projectId: "prj_1",
            number: 10, title: "Move Me", description: "Desc",
            status: "todo", rank: 1000, createdBy: "mem_1",
            createdAt: 1000, updatedAt: 1000
        )

        let client = makeTestClient { req in
            #expect(req.httpMethod == "POST")
            #expect(req.url?.path == "/api/tasks/tsk_move_1/move")
            let movedTask = BoardTask(
                id: "tsk_move_1", orgId: "org_1", projectId: "prj_1",
                number: 10, title: "Move Me", description: "Desc",
                status: "in_progress", rank: 1000, createdBy: "mem_1",
                createdAt: 1000, updatedAt: 1000
            )
            let data = try! JSONEncoder().encode(movedTask)
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, data)
        }

        let store = BoardStore(apiClient: client)
        store.tasks = [task]

        try await store.moveTask(id: task.id, to: .inProgress)
        #expect(store.tasks(for: .inProgress).count == 1)
        #expect(store.tasks(for: .todo).isEmpty)
        #expect(store.bannerMessage == nil)
    }

    @Test("Move 409 held rolls back and sets banner")
    @MainActor
    func testMove409HeldRollback() async throws {
        let task = BoardTask(
            id: "tsk_held", orgId: "org_1", projectId: "prj_1",
            number: 10, title: "Held Task", description: "Desc",
            status: "todo", rank: 1000, createdBy: "mem_1",
            createdAt: 1000, updatedAt: 1000
        )

        let move409Data = try loadFixtureData(named: "move-409")
        let fixture = try JSONDecoder().decode(Move409Fixture.self, from: move409Data)
        let heldJson = try JSONEncoder().encode(fixture.held)

        let client = makeTestClient { req in
            let res = HTTPURLResponse(url: req.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!
            return (res, heldJson)
        }

        let store = BoardStore(apiClient: client)
        store.tasks = [task]

        await #expect(throws: MoveTaskException.self) {
            try await store.moveTask(id: task.id, to: .inProgress)
        }

        // Exact rollback
        #expect(store.tasks(for: .todo).count == 1)
        #expect(store.tasks(for: .todo).first?.rank == 1000)
        #expect(store.tasks(for: .inProgress).isEmpty)

        // Banner contains holder
        #expect(store.bannerMessage?.contains("held by") == true)
        #expect(store.bannerMessage?.contains(fixture.held.holderId) == true)
    }

    @Test("Move 409 deps_open rolls back and sets banner")
    @MainActor
    func testMove409DepsOpenRollback() async throws {
        let task = BoardTask(
            id: "tsk_deps", orgId: "org_1", projectId: "prj_1",
            number: 10, title: "Blocked Task", description: "Desc",
            status: "todo", rank: 1000, createdBy: "mem_1",
            createdAt: 1000, updatedAt: 1000
        )

        let move409Data = try loadFixtureData(named: "move-409")
        let fixture = try JSONDecoder().decode(Move409Fixture.self, from: move409Data)
        let depsJson = try JSONEncoder().encode(fixture.depsOpen)

        let client = makeTestClient { req in
            let res = HTTPURLResponse(url: req.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!
            return (res, depsJson)
        }

        let store = BoardStore(apiClient: client)
        store.tasks = [task]

        await #expect(throws: MoveTaskException.self) {
            try await store.moveTask(id: task.id, to: .done)
        }

        // Exact rollback
        #expect(store.tasks(for: .todo).count == 1)
        #expect(store.tasks(for: .done).isEmpty)

        // Banner contains #42 and #43
        #expect(store.bannerMessage?.contains("#42") == true)
        #expect(store.bannerMessage?.contains("#43") == true)
    }

    @Test("Move 409 children_open rolls back and sets banner")
    @MainActor
    func testMove409ChildrenOpenRollback() async throws {
        let task = BoardTask(
            id: "tsk_children", orgId: "org_1", projectId: "prj_1",
            number: 10, title: "Parent Task", description: "Desc",
            status: "todo", rank: 1000, createdBy: "mem_1",
            createdAt: 1000, updatedAt: 1000
        )

        let move409Data = try loadFixtureData(named: "move-409")
        let fixture = try JSONDecoder().decode(Move409Fixture.self, from: move409Data)
        let childrenJson = try JSONEncoder().encode(fixture.childrenOpen)

        let client = makeTestClient { req in
            let res = HTTPURLResponse(url: req.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!
            return (res, childrenJson)
        }

        let store = BoardStore(apiClient: client)
        store.tasks = [task]

        await #expect(throws: MoveTaskException.self) {
            try await store.moveTask(id: task.id, to: .done)
        }

        // Exact rollback
        #expect(store.tasks(for: .todo).count == 1)
        #expect(store.tasks(for: .done).isEmpty)

        // Banner contains #44
        #expect(store.bannerMessage?.contains("#44") == true)
    }

    @Test("CreateTask posts and appends task")
    @MainActor
    func testCreateTask() async throws {
        let created = BoardTask(
            id: "tsk_new_1", orgId: "org_1", projectId: "prj_1",
            number: 99, title: "New created task", description: "Desc",
            status: "todo", rank: 5000, createdBy: "mem_1",
            createdAt: 1000, updatedAt: 1000
        )

        let client = makeTestClient { req in
            #expect(req.httpMethod == "POST")
            #expect(req.url?.path == "/api/projects/prj_1/tasks")
            let data = try! JSONEncoder().encode(created)
            let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (res, data)
        }

        let store = BoardStore(apiClient: client)
        store.selectedProject = OrgProject(id: "prj_1", orgId: "org_1", key: "HAR", name: "Harness")
        store.tasks = []

        let result = try await store.createTask(title: "New created task", description: "Desc", status: .todo)
        #expect(result.id == "tsk_new_1")
        #expect(store.tasks.count == 1)
        #expect(store.tasks.first?.id == "tsk_new_1")
    }
}
