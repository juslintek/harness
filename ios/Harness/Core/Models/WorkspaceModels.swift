import Foundation

public struct DashboardMemberTool: Codable, Sendable, Equatable {
    public let name: String
    public let count: Int
    public init(name: String, count: Int) { self.name = name; self.count = count }
}

public struct DashboardMember: Codable, Sendable, Equatable, Identifiable {
    public var id: String { memberId }
    public let memberId: String
    public let handle: String
    public let runs: Int
    public let completed: Int
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let costUsd: Double
    public let costEstimated: Bool
    public let unpricedEvents: Int
    public let wallMs: Int64
    public let activeMs: Int64
    public let waitingMs: Int64
    public let plannerMinutes: Int
    public let reviewerMinutes: Int
    public let tasksDone: Int
    public let tools: [DashboardMemberTool]
    public let stack: [String]

    public init(
        memberId: String, handle: String, runs: Int, completed: Int,
        inputTokens: Int, outputTokens: Int, cacheReadTokens: Int,
        costUsd: Double, costEstimated: Bool, unpricedEvents: Int,
        wallMs: Int64, activeMs: Int64, waitingMs: Int64,
        plannerMinutes: Int, reviewerMinutes: Int, tasksDone: Int,
        tools: [DashboardMemberTool] = [], stack: [String] = []
    ) {
        self.memberId = memberId; self.handle = handle; self.runs = runs; self.completed = completed
        self.inputTokens = inputTokens; self.outputTokens = outputTokens; self.cacheReadTokens = cacheReadTokens
        self.costUsd = costUsd; self.costEstimated = costEstimated; self.unpricedEvents = unpricedEvents
        self.wallMs = wallMs; self.activeMs = activeMs; self.waitingMs = waitingMs
        self.plannerMinutes = plannerMinutes; self.reviewerMinutes = reviewerMinutes; self.tasksDone = tasksDone
        self.tools = tools; self.stack = stack
    }
}

public struct DashboardQuota: Codable, Sendable, Equatable {
    public let provider: String
    public let window: String
    public let usedPercent: Double?
    public let resetsAt: Int64?
    public let source: String
    public let ts: Int64
    public init(provider: String, window: String, usedPercent: Double?, resetsAt: Int64?, source: String, ts: Int64) {
        self.provider = provider; self.window = window; self.usedPercent = usedPercent
        self.resetsAt = resetsAt; self.source = source; self.ts = ts
    }
}

public struct DashboardTask: Codable, Sendable, Equatable {
    public let number: Int
    public let title: String
    public let status: String
    public let assignee: String?
    public let plannerMinutes: Int?
    public let reviewerMinutes: Int?
    public let agentActiveMinutes: Int?
    public init(number: Int, title: String, status: String, assignee: String? = nil, plannerMinutes: Int? = nil, reviewerMinutes: Int? = nil, agentActiveMinutes: Int? = nil) {
        self.number = number; self.title = title; self.status = status; self.assignee = assignee
        self.plannerMinutes = plannerMinutes; self.reviewerMinutes = reviewerMinutes; self.agentActiveMinutes = agentActiveMinutes
    }
}

public struct WorkspaceBudget: Codable, Sendable, Equatable {
    public let id: String?
    public let amountUsd: Double?
    public init(id: String? = nil, amountUsd: Double? = nil) {
        self.id = id; self.amountUsd = amountUsd
    }
}

public struct DashboardResponse: Codable, Sendable, Equatable {
    public let members: [DashboardMember]
    public let budgets: [WorkspaceBudget]
    public let quota: [DashboardQuota]
    public let tasks: [DashboardTask]
    public init(members: [DashboardMember], budgets: [WorkspaceBudget] = [], quota: [DashboardQuota] = [], tasks: [DashboardTask] = []) {
        self.members = members; self.budgets = budgets; self.quota = quota; self.tasks = tasks
    }
}

public struct MemoryFacets: Codable, Sendable, Equatable {
    public let scopes: [String: Int]
    public let types: [String: Int]
    public let tags: [String: Int]
    public let sources: [String: Int]
    public init(scopes: [String: Int] = [:], types: [String: Int] = [:], tags: [String: Int] = [:], sources: [String: Int] = [:]) {
        self.scopes = scopes; self.types = types; self.tags = tags; self.sources = sources
    }
}

public struct MemoryNoteSummary: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let path: String
    public let scope: String
    public let orgId: String?
    public let projectId: String?
    public let memberId: String?
    public let type: String
    public let title: String
    public let tags: [String]
    public let sourceAgent: String
    public let confidence: Double
    public let created: String
    public let updated: String
    public let hash: String
    public let snippet: String?

    public init(
        id: String, path: String, scope: String, orgId: String? = nil, projectId: String? = nil,
        memberId: String? = nil, type: String, title: String, tags: [String] = [], sourceAgent: String,
        confidence: Double = 1.0, created: String, updated: String, hash: String, snippet: String? = nil
    ) {
        self.id = id; self.path = path; self.scope = scope; self.orgId = orgId; self.projectId = projectId
        self.memberId = memberId; self.type = type; self.title = title; self.tags = tags
        self.sourceAgent = sourceAgent; self.confidence = confidence; self.created = created
        self.updated = updated; self.hash = hash; self.snippet = snippet
    }
}

public struct MemoryNoteDetail: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let path: String
    public let scope: String
    public let orgId: String?
    public let projectId: String?
    public let memberId: String?
    public let type: String
    public let title: String
    public let tags: [String]
    public let sourceAgent: String
    public let confidence: Double
    public let created: String
    public let updated: String
    public let hash: String
    public let body: String
    public let canWrite: Bool

    public init(
        id: String, path: String, scope: String, orgId: String? = nil, projectId: String? = nil,
        memberId: String? = nil, type: String, title: String, tags: [String] = [], sourceAgent: String,
        confidence: Double = 1.0, created: String, updated: String, hash: String, body: String, canWrite: Bool = true
    ) {
        self.id = id; self.path = path; self.scope = scope; self.orgId = orgId; self.projectId = projectId
        self.memberId = memberId; self.type = type; self.title = title; self.tags = tags
        self.sourceAgent = sourceAgent; self.confidence = confidence; self.created = created
        self.updated = updated; self.hash = hash; self.body = body; self.canWrite = canWrite
    }
}

public struct MemoryConflict409: Codable, Sendable, Equatable {
    public let error: String
    public let hash: String
    public init(error: String, hash: String) { self.error = error; self.hash = hash }
}

public struct MemoryWrite: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let noteId: String
    public let path: String
    public let op: String
    public let actor: String
    public let runId: String?
    public let at: Int64
    public let beforeHash: String?
    public let afterHash: String?
    public let before: String?
    public let after: String?
    public let canRevert: Bool

    public init(
        id: String, noteId: String, path: String, op: String, actor: String, runId: String? = nil,
        at: Int64, beforeHash: String? = nil, afterHash: String? = nil, before: String? = nil,
        after: String? = nil, canRevert: Bool = false
    ) {
        self.id = id; self.noteId = noteId; self.path = path; self.op = op; self.actor = actor
        self.runId = runId; self.at = at; self.beforeHash = beforeHash; self.afterHash = afterHash
        self.before = before; self.after = after; self.canRevert = canRevert
    }
}

public struct MemoryLessonTask: Codable, Sendable, Equatable {
    public let number: Int
    public let projectId: String
    public let title: String
    public init(number: Int, projectId: String, title: String) {
        self.number = number; self.projectId = projectId; self.title = title
    }
}

public struct MemoryLesson: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let taskId: String?
    public let orgId: String?
    public let projectId: String?
    public let authorId: String?
    public let authorHandle: String?
    public let body: String
    public let scope: String
    public let type: String
    public let status: String
    public let reviewerId: String?
    public let reason: String?
    public let noteId: String?
    public let createdAt: Int64
    public let decidedAt: Int64?
    public let task: MemoryLessonTask?

    public init(
        id: String, taskId: String? = nil, orgId: String? = nil, projectId: String? = nil,
        authorId: String? = nil, authorHandle: String? = nil, body: String, scope: String,
        type: String, status: String, reviewerId: String? = nil, reason: String? = nil,
        noteId: String? = nil, createdAt: Int64, decidedAt: Int64? = nil, task: MemoryLessonTask? = nil
    ) {
        self.id = id; self.taskId = taskId; self.orgId = orgId; self.projectId = projectId
        self.authorId = authorId; self.authorHandle = authorHandle; self.body = body; self.scope = scope
        self.type = type; self.status = status; self.reviewerId = reviewerId; self.reason = reason
        self.noteId = noteId; self.createdAt = createdAt; self.decidedAt = decidedAt; self.task = task
    }
}

public struct MemoryFixtureResponse: Codable, Sendable, Equatable {
    public let facets: MemoryFacets
    public let notes: [MemoryNoteSummary]
    public let note: MemoryNoteDetail?
    public let conflict409: MemoryConflict409?
    public let writes: [MemoryWrite]
    public let lessons: [MemoryLesson]

    public init(
        facets: MemoryFacets, notes: [MemoryNoteSummary] = [], note: MemoryNoteDetail? = nil,
        conflict409: MemoryConflict409? = nil, writes: [MemoryWrite] = [], lessons: [MemoryLesson] = []
    ) {
        self.facets = facets; self.notes = notes; self.note = note
        self.conflict409 = conflict409; self.writes = writes; self.lessons = lessons
    }
}
