import Foundation

public struct PersonRef: Codable, Sendable, Equatable, Identifiable {
    public var id: String { handle }
    public let memberId: String?
    public let handle: String
    public let displayName: String
    public let kind: String

    enum CodingKeys: String, CodingKey {
        case memberId = "id"
        case handle
        case displayName
        case kind
    }

    public init(
        memberId: String? = nil,
        handle: String,
        displayName: String,
        kind: String = "human"
    ) {
        self.memberId = memberId
        self.handle = handle
        self.displayName = displayName
        self.kind = kind
    }
}

public struct BoardTask: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let orgId: String
    public let projectId: String
    public let number: Int
    public let parentId: String?
    public let title: String
    public let description: String
    public let status: String
    public let rank: Double
    public let assigneeId: String?
    public let holderId: String?
    public let assignee: PersonRef?
    public let holder: PersonRef?
    public let checkedOutAt: Int64?
    public let estimateMinutes: Int?
    public let createdBy: String
    public let createdAt: Int64
    public let updatedAt: Int64

    public init(
        id: String,
        orgId: String,
        projectId: String,
        number: Int,
        parentId: String? = nil,
        title: String,
        description: String,
        status: String,
        rank: Double,
        assigneeId: String? = nil,
        holderId: String? = nil,
        assignee: PersonRef? = nil,
        holder: PersonRef? = nil,
        checkedOutAt: Int64? = nil,
        estimateMinutes: Int? = nil,
        createdBy: String,
        createdAt: Int64,
        updatedAt: Int64
    ) {
        self.id = id
        self.orgId = orgId
        self.projectId = projectId
        self.number = number
        self.parentId = parentId
        self.title = title
        self.description = description
        self.status = status
        self.rank = rank
        self.assigneeId = assigneeId
        self.holderId = holderId
        self.assignee = assignee
        self.holder = holder
        self.checkedOutAt = checkedOutAt
        self.estimateMinutes = estimateMinutes
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct TaskDependency: Codable, Sendable, Equatable {
    public let taskId: String
    public let dependsOn: String

    public init(taskId: String, dependsOn: String) {
        self.taskId = taskId
        self.dependsOn = dependsOn
    }
}

public struct TaskComment: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let taskId: String
    public let authorId: String?
    public let author: PersonRef?
    public let body: String
    public let createdAt: Int64

    public init(
        id: String,
        taskId: String,
        authorId: String? = nil,
        author: PersonRef? = nil,
        body: String,
        createdAt: Int64
    ) {
        self.id = id
        self.taskId = taskId
        self.authorId = authorId
        self.author = author
        self.body = body
        self.createdAt = createdAt
    }
}

public struct TaskDetail: Codable, Sendable, Equatable {
    public let task: BoardTask
    public let deps: [BoardTask]
    public let subtasks: [BoardTask]
    public let comments: [TaskComment]

    public init(
        task: BoardTask,
        deps: [BoardTask] = [],
        subtasks: [BoardTask] = [],
        comments: [TaskComment] = []
    ) {
        self.task = task
        self.deps = deps
        self.subtasks = subtasks
        self.comments = comments
    }
}

public struct BoardTasksResponse: Codable, Sendable, Equatable {
    public let tasks: [BoardTask]
    public let deps: [TaskDependency]
    public let detail: TaskDetail?

    public init(tasks: [BoardTask], deps: [TaskDependency], detail: TaskDetail? = nil) {
        self.tasks = tasks
        self.deps = deps
        self.detail = detail
    }
}

public struct Move409Held: Codable, Sendable, Equatable {
    public let ok: Bool
    public let reason: String
    public let holderId: String
}

public struct Move409DepsOpen: Codable, Sendable, Equatable {
    public let ok: Bool
    public let reason: String
    public let open: [Int]
}

public struct Move409ChildrenOpen: Codable, Sendable, Equatable {
    public let ok: Bool
    public let reason: String
    public let open: [Int]
}

public struct Move409Fixture: Codable, Sendable, Equatable {
    public let held: Move409Held
    public let depsOpen: Move409DepsOpen
    public let childrenOpen: Move409ChildrenOpen
}

public struct MoveTaskRequest: Codable, Sendable {
    public let status: String
    public let rank: Double?

    public init(status: String, rank: Double? = nil) {
        self.status = status
        self.rank = rank
    }
}

public struct CreateTaskRequest: Codable, Sendable {
    public let projectId: String
    public let title: String
    public let description: String?
    public let status: String?
    public let assigneeId: String?
    public let estimateMinutes: Int?

    public init(projectId: String, title: String, description: String? = nil, status: String? = nil, assigneeId: String? = nil, estimateMinutes: Int? = nil) {
        self.projectId = projectId
        self.title = title
        self.description = description
        self.status = status
        self.assigneeId = assigneeId
        self.estimateMinutes = estimateMinutes
    }
}

public struct AddCommentRequest: Codable, Sendable {
    public let body: String

    public init(body: String) {
        self.body = body
    }
}
