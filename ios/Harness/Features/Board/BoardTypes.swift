import Foundation

public enum TaskStatus: String, CaseIterable, Identifiable, Sendable, Codable {
    case backlog
    case todo
    case inProgress = "in_progress"
    case inReview = "in_review"
    case done
    case blocked
    case cancelled

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .backlog: return "Backlog"
        case .todo: return "Todo"
        case .inProgress: return "In Progress"
        case .inReview: return "In Review"
        case .done: return "Done"
        case .blocked: return "Blocked"
        case .cancelled: return "Cancelled"
        }
    }
}

public struct OrgProject: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let orgId: String
    public let teamId: String?
    public let key: String
    public let name: String
    public let repo: String?

    public init(
        id: String,
        orgId: String,
        teamId: String? = nil,
        key: String,
        name: String,
        repo: String? = nil
    ) {
        self.id = id
        self.orgId = orgId
        self.teamId = teamId
        self.key = key
        self.name = name
        self.repo = repo
    }
}

public struct OrgMember: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let orgId: String
    public let kind: String
    public let handle: String
    public let displayName: String
    public let role: String

    public init(
        id: String,
        orgId: String,
        kind: String = "human",
        handle: String,
        displayName: String,
        role: String = "member"
    ) {
        self.id = id
        self.orgId = orgId
        self.kind = kind
        self.handle = handle
        self.displayName = displayName
        self.role = role
    }
}

public struct OrgDetailResponse: Codable, Sendable {
    public let projects: [OrgProject]
    public let members: [OrgMember]?

    public init(projects: [OrgProject], members: [OrgMember]? = nil) {
        self.projects = projects
        self.members = members
    }
}

public struct MoveBody: Codable, Sendable {
    public let to: String
    public let beforeId: String?

    public init(to: String, beforeId: String? = nil) {
        self.to = to
        self.beforeId = beforeId
    }
}

public enum MoveFailure: Sendable, Equatable {
    case held(holderId: String)
    case depsOpen(open: [Int])
    case childrenOpen(open: [Int])
    case other(String)

    public func bannerMessage(memberLookup: ((String) -> String?)? = nil) -> String {
        switch self {
        case .held(let holderId):
            let name = memberLookup?(holderId) ?? holderId
            return "Task is currently held by \(name)"
        case .depsOpen(let open):
            let numbers = open.map { "#\($0)" }.joined(separator: ", ")
            return "Cannot move: open dependencies \(numbers)"
        case .childrenOpen(let open):
            let numbers = open.map { "#\($0)" }.joined(separator: ", ")
            return "Cannot move: open subtasks \(numbers)"
        case .other(let reason):
            return "Cannot move task: \(reason)"
        }
    }
}

public struct Move409ErrorResponse: Codable, Sendable {
    public let ok: Bool?
    public let reason: String
    public let holderId: String?
    public let open: [Int]?

    public var failure: MoveFailure {
        switch reason {
        case "held":
            return .held(holderId: holderId ?? "another member")
        case "deps_open":
            return .depsOpen(open: open ?? [])
        case "children_open":
            return .childrenOpen(open: open ?? [])
        default:
            return .other(reason)
        }
    }
}

public struct CreateTaskPayload: Codable, Sendable {
    public let title: String
    public let description: String?
    public let parentId: String?
    public let assigneeId: String?
    public let estimateMinutes: Int?
    public let status: String?

    public init(
        title: String,
        description: String? = nil,
        parentId: String? = nil,
        assigneeId: String? = nil,
        estimateMinutes: Int? = nil,
        status: String? = nil
    ) {
        self.title = title
        self.description = description
        self.parentId = parentId
        self.assigneeId = assigneeId
        self.estimateMinutes = estimateMinutes
        self.status = status
    }
}

public struct PatchTaskPayload: Codable, Sendable {
    public let title: String?
    public let description: String?
    public let estimateMinutes: Int?
    public let assigneeId: String?

    public init(
        title: String? = nil,
        description: String? = nil,
        estimateMinutes: Int? = nil,
        assigneeId: String? = nil
    ) {
        self.title = title
        self.description = description
        self.estimateMinutes = estimateMinutes
        self.assigneeId = assigneeId
    }
}

public struct DepPayload: Codable, Sendable {
    public let dependsOn: String

    public init(dependsOn: String) {
        self.dependsOn = dependsOn
    }
}

public struct WakePayload: Codable, Sendable {
    public let taskId: String?

    public init(taskId: String?) {
        self.taskId = taskId
    }
}

public enum AssigneeFilter: Equatable, Hashable, Sendable {
    case all
    case mine
    case member(id: String, handle: String)

    public var title: String {
        switch self {
        case .all: return "All"
        case .mine: return "Mine"
        case .member(_, let handle): return "@\(handle)"
        }
    }
}
