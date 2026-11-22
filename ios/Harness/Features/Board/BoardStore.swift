import Foundation
import Observation

@Observable
@MainActor
public final class BoardStore {
    public var projects: [OrgProject] = []
    public var selectedProject: OrgProject?
    public var members: [OrgMember] = []
    public var tasks: [BoardTask] = []
    public var dependencies: [TaskDependency] = []
    public var assigneeFilter: AssigneeFilter = .all
    public var isLoading: Bool = false
    public var bannerMessage: String?
    public var selectedTaskId: String?
    public var isNewTaskSheetPresented: Bool = false

    public var apiClient: HarnessAPIClient?
    public var currentMemberId: String?
    public var wsClient: HarnessWSClient?
    private var wsTask: Task<Void, Never>?

    public init(
        apiClient: HarnessAPIClient? = nil,
        currentMemberId: String? = nil
    ) {
        self.apiClient = apiClient
        self.currentMemberId = currentMemberId
    }

    public var filteredTasks: [BoardTask] {
        switch assigneeFilter {
        case .all:
            return tasks
        case .mine:
            guard let currentMemberId else { return tasks }
            return tasks.filter { $0.assigneeId == currentMemberId }
        case .member(let id, _):
            return tasks.filter { $0.assigneeId == id }
        }
    }

    public func tasks(for status: TaskStatus) -> [BoardTask] {
        filteredTasks
            .filter { $0.status == status.rawValue }
            .sorted { $0.rank < $1.rank }
    }

    public func count(for status: TaskStatus) -> Int {
        filteredTasks.filter { $0.status == status.rawValue }.count
    }

    public func dependencyCount(for taskId: String) -> Int {
        dependencies.filter { $0.taskId == taskId }.count
    }

    public func dismissBanner() {
        bannerMessage = nil
    }

    public func updateTaskInList(_ task: BoardTask) {
        if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[idx] = task
        }
    }

    public func loadProjects(for orgSlug: String) async {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)")
            let res: OrgDetailResponse = try await apiClient.send(req)
            self.projects = res.projects
            self.members = res.members ?? []
            if selectedProject == nil || !res.projects.contains(where: { $0.id == selectedProject?.id }) {
                selectedProject = res.projects.first
            }
            if let selectedProject {
                await loadTasksAndDeps(projectId: selectedProject.id)
            }
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func selectProject(_ project: OrgProject) async {
        selectedProject = project
        await loadTasksAndDeps(projectId: project.id)
    }

    public func loadTasksAndDeps(projectId: String? = nil) async {
        guard let apiClient, let pid = projectId ?? selectedProject?.id else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let tasksReq = try apiClient.buildRequest(path: "/api/projects/\(pid)/tasks")
            let depsReq = try apiClient.buildRequest(path: "/api/projects/\(pid)/deps")
            async let loadedTasks: [BoardTask] = apiClient.send(tasksReq)
            async let loadedDeps: [TaskDependency] = apiClient.send(depsReq)
            let (t, d) = try await (loadedTasks, loadedDeps)
            self.tasks = t
            self.dependencies = d
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func moveTask(
        id: String,
        to targetStatus: TaskStatus,
        beforeId: String? = nil
    ) async throws {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        let originalTask = tasks[index]
        let originalTasks = tasks

        // Optimistic rank calculation
        let existingInTarget = tasks(for: targetStatus).filter { $0.id != id }
        let newRank: Double
        if let beforeId, let targetIdx = existingInTarget.firstIndex(where: { $0.id == beforeId }) {
            let targetTask = existingInTarget[targetIdx]
            if targetIdx == 0 {
                newRank = targetTask.rank / 2.0
            } else {
                let prevTask = existingInTarget[targetIdx - 1]
                newRank = (targetTask.rank + prevTask.rank) / 2.0
            }
        } else {
            let maxRank = existingInTarget.map(\.rank).max() ?? 0.0
            newRank = maxRank + 1000.0
        }

        let optimisticTask = BoardTask(
            id: originalTask.id,
            orgId: originalTask.orgId,
            projectId: originalTask.projectId,
            number: originalTask.number,
            parentId: originalTask.parentId,
            title: originalTask.title,
            description: originalTask.description,
            status: targetStatus.rawValue,
            rank: newRank,
            assigneeId: originalTask.assigneeId,
            holderId: originalTask.holderId,
            assignee: originalTask.assignee,
            holder: originalTask.holder,
            checkedOutAt: originalTask.checkedOutAt,
            estimateMinutes: originalTask.estimateMinutes,
            createdBy: originalTask.createdBy,
            createdAt: originalTask.createdAt,
            updatedAt: originalTask.updatedAt
        )
        tasks[index] = optimisticTask

        guard let apiClient else { return }

        do {
            let body = MoveBody(to: targetStatus.rawValue, beforeId: beforeId)
            let bodyData = try JSONEncoder().encode(body)
            let req = try apiClient.buildRequest(
                path: "/api/tasks/\(id)/move",
                method: "POST",
                body: bodyData
            )
            let updatedTask: BoardTask = try await apiClient.send(req)
            if let idx = tasks.firstIndex(where: { $0.id == id }) {
                tasks[idx] = updatedTask
            }
            bannerMessage = nil
        } catch {
            // Rollback exact prior column/rank state
            tasks = originalTasks
            if case .httpError(let statusCode, let message) = (error as? HarnessAPIError), statusCode == 409 {
                if let data = message.data(using: .utf8),
                   let err409 = try? JSONDecoder().decode(Move409ErrorResponse.self, from: data) {
                    let failure = err409.failure
                    bannerMessage = failure.bannerMessage(memberLookup: { [weak self] mid in
                        self?.members.first(where: { $0.id == mid })?.handle
                    })
                    throw MoveTaskException.moveFailure(failure)
                }
            }
            bannerMessage = error.localizedDescription
            throw error
        }
    }

    public func createTask(
        title: String,
        description: String? = nil,
        status: TaskStatus = .todo,
        assigneeId: String? = nil,
        estimateMinutes: Int? = nil
    ) async throws -> BoardTask {
        guard let apiClient, let pid = selectedProject?.id else {
            throw HarnessAPIError.invalidURL("No project selected")
        }
        let payload = CreateTaskPayload(
            title: title,
            description: description,
            parentId: nil,
            assigneeId: assigneeId,
            estimateMinutes: estimateMinutes,
            status: status.rawValue
        )
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(
            path: "/api/projects/\(pid)/tasks",
            method: "POST",
            body: bodyData
        )
        let created: BoardTask = try await apiClient.send(req)
        tasks.append(created)
        return created
    }

    public func subscribeToRealtime(orgId: String) {
        guard let apiClient else { return }
        wsTask?.cancel()
        let ws = HarnessWSClient(
            origin: apiClient.origin,
            topic: "org:\(orgId)",
            tokenProvider: apiClient.tokenProvider
        )
        self.wsClient = ws
        wsTask = Task { [weak self] in
            let stream = ws.connect()
            for await message in stream {
                guard let self else { break }
                if case .task(let projectId, _, _) = message {
                    if projectId == self.selectedProject?.id {
                        await self.loadTasksAndDeps(projectId: projectId)
                    }
                }
            }
        }
    }

    public func stopRealtime() {
        wsTask?.cancel()
        wsTask = nil
        Task { [wsClient] in
            await wsClient?.disconnect()
        }
    }
}

public enum MoveTaskException: Error, Equatable {
    case moveFailure(MoveFailure)
    case generic(String)
}
