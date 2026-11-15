import Foundation
import Observation

public struct SimpleSuccessResponse: Codable, Sendable {
    public let ok: Bool?
    public let id: String?

    public init(ok: Bool? = nil, id: String? = nil) {
        self.ok = ok
        self.id = id
    }
}

@Observable
@MainActor
public final class TaskDetailStore {
    public let taskId: String
    public var detail: TaskDetail?
    public var isLoading: Bool = false
    public var errorMessage: String?
    public var isWaking: Bool = false
    public var wakeSuccess: Bool = false

    public let apiClient: HarnessAPIClient?
    public var onTaskUpdated: (@MainActor @Sendable (BoardTask) -> Void)?

    public init(
        taskId: String,
        apiClient: HarnessAPIClient? = nil,
        onTaskUpdated: (@MainActor @Sendable (BoardTask) -> Void)? = nil
    ) {
        self.taskId = taskId
        self.apiClient = apiClient
        self.onTaskUpdated = onTaskUpdated
    }

    public var task: BoardTask? {
        detail?.task
    }

    public var deps: [BoardTask] {
        detail?.deps ?? []
    }

    public var subtasks: [BoardTask] {
        detail?.subtasks ?? []
    }

    public var comments: [TaskComment] {
        detail?.comments ?? []
    }

    public func loadDetail() async {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let req = try apiClient.buildRequest(path: "/api/tasks/\(taskId)")
            let res: TaskDetail = try await apiClient.send(req)
            self.detail = res
            self.errorMessage = nil
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func update(
        title: String? = nil,
        description: String? = nil,
        estimateMinutes: Int? = nil,
        assigneeId: String? = nil
    ) async throws {
        guard let apiClient else { return }
        let payload = PatchTaskPayload(
            title: title,
            description: description,
            estimateMinutes: estimateMinutes,
            assigneeId: assigneeId
        )
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(
            path: "/api/tasks/\(taskId)",
            method: "PATCH",
            body: bodyData
        )
        let updated: BoardTask = try await apiClient.send(req)
        if let current = detail {
            detail = TaskDetail(
                task: updated,
                deps: current.deps,
                subtasks: current.subtasks,
                comments: current.comments
            )
        }
        onTaskUpdated?(updated)
    }

    public func checkout() async throws {
        guard let apiClient else { return }
        let req = try apiClient.buildRequest(
            path: "/api/tasks/\(taskId)/checkout",
            method: "POST"
        )
        let updated: BoardTask = try await apiClient.send(req)
        if let current = detail {
            detail = TaskDetail(
                task: updated,
                deps: current.deps,
                subtasks: current.subtasks,
                comments: current.comments
            )
        }
        onTaskUpdated?(updated)
    }

    public func release() async throws {
        guard let apiClient else { return }
        let req = try apiClient.buildRequest(
            path: "/api/tasks/\(taskId)/release",
            method: "POST"
        )
        let updated: BoardTask = try await apiClient.send(req)
        if let current = detail {
            detail = TaskDetail(
                task: updated,
                deps: current.deps,
                subtasks: current.subtasks,
                comments: current.comments
            )
        }
        onTaskUpdated?(updated)
    }

    public func wakeAgent(assigneeId: String) async throws {
        guard let apiClient else { return }
        isWaking = true
        defer { isWaking = false }
        let payload = WakePayload(taskId: taskId)
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(
            path: "/api/members/\(assigneeId)/wake",
            method: "POST",
            body: bodyData
        )
        let _: SimpleSuccessResponse = try await apiClient.send(req)
        wakeSuccess = true
    }

    public func addDependency(dependsOnTaskId: String) async throws {
        guard let apiClient else { return }
        let payload = DepPayload(dependsOn: dependsOnTaskId)
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(
            path: "/api/tasks/\(taskId)/deps",
            method: "POST",
            body: bodyData
        )
        let _: SimpleSuccessResponse = try await apiClient.send(req)
        await loadDetail()
    }

    public func removeDependency(dependsOnTaskId: String) async throws {
        guard let apiClient else { return }
        let payload = DepPayload(dependsOn: dependsOnTaskId)
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(
            path: "/api/tasks/\(taskId)/deps",
            method: "DELETE",
            body: bodyData
        )
        let _: SimpleSuccessResponse = try await apiClient.send(req)
        await loadDetail()
    }

    public func createSubtask(
        title: String,
        description: String? = nil,
        status: TaskStatus = .todo,
        assigneeId: String? = nil,
        estimateMinutes: Int? = nil
    ) async throws -> BoardTask {
        guard let apiClient, let projectId = detail?.task.projectId else {
            throw HarnessAPIError.invalidURL("No project id found")
        }
        let payload = CreateTaskPayload(
            title: title,
            description: description,
            parentId: taskId,
            assigneeId: assigneeId,
            estimateMinutes: estimateMinutes,
            status: status.rawValue
        )
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(
            path: "/api/projects/\(projectId)/tasks",
            method: "POST",
            body: bodyData
        )
        let created: BoardTask = try await apiClient.send(req)
        await loadDetail()
        return created
    }

    public func addComment(body: String) async throws {
        guard let apiClient else { return }
        let payload = AddCommentRequest(body: body)
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(
            path: "/api/tasks/\(taskId)/comments",
            method: "POST",
            body: bodyData
        )
        let created: TaskComment = try await apiClient.send(req)
        if var current = detail {
            var comments = current.comments
            comments.append(created)
            detail = TaskDetail(
                task: current.task,
                deps: current.deps,
                subtasks: current.subtasks,
                comments: comments
            )
        }
    }
}
