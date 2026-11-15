import Foundation

public struct Approval: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let runId: String
    public let command: String
    public let reason: String?
    public let status: String
    public let decidedBy: String?
    public let createdAt: Int64
    public let expiresAt: Int64
    public let decidedAt: Int64?

    public init(
        id: String,
        runId: String,
        command: String,
        reason: String? = nil,
        status: String,
        decidedBy: String? = nil,
        createdAt: Int64,
        expiresAt: Int64,
        decidedAt: Int64? = nil
    ) {
        self.id = id
        self.runId = runId
        self.command = command
        self.reason = reason
        self.status = status
        self.decidedBy = decidedBy
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.decidedAt = decidedAt
    }
}

public struct Run: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let memberId: String?
    public let agentId: String
    public let model: String?
    public let repo: String
    public let branch: String?
    public let prompt: String
    public let state: String
    public let reason: String?
    public let createdAt: Int64
    public let startedAt: Int64?
    public let endedAt: Int64?
    public let inputTokens: Int
    public let outputTokens: Int

    public init(
        id: String,
        memberId: String? = nil,
        agentId: String,
        model: String? = nil,
        repo: String,
        branch: String? = nil,
        prompt: String,
        state: String,
        reason: String? = nil,
        createdAt: Int64,
        startedAt: Int64? = nil,
        endedAt: Int64? = nil,
        inputTokens: Int = 0,
        outputTokens: Int = 0
    ) {
        self.id = id
        self.memberId = memberId
        self.agentId = agentId
        self.model = model
        self.repo = repo
        self.branch = branch
        self.prompt = prompt
        self.state = state
        self.reason = reason
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

public struct RunEvent: Codable, Sendable, Equatable, Identifiable {
    public var id: Int { rowid }
    public let rowid: Int
    public let ts: Int64
    public let kind: String
    public let toolName: String?
    public let command: String?
    public let exitCode: Int?
    public let guardLayer: String?
    public let guardVerdict: String?
    public let guardRule: String?
    public let body: String?

    public init(
        rowid: Int,
        ts: Int64,
        kind: String,
        toolName: String? = nil,
        command: String? = nil,
        exitCode: Int? = nil,
        guardLayer: String? = nil,
        guardVerdict: String? = nil,
        guardRule: String? = nil,
        body: String? = nil
    ) {
        self.rowid = rowid
        self.ts = ts
        self.kind = kind
        self.toolName = toolName
        self.command = command
        self.exitCode = exitCode
        self.guardLayer = guardLayer
        self.guardVerdict = guardVerdict
        self.guardRule = guardRule
        self.body = body
    }
}

public struct RunDetail: Codable, Sendable, Equatable {
    public let run: Run
    public let events: [RunEvent]

    public init(run: Run, events: [RunEvent]) {
        self.run = run
        self.events = events
    }
}

public struct DecisionRequest: Codable, Sendable {
    public let decision: String

    public init(decision: String) {
        self.decision = decision
    }
}

public struct StartRunRequest: Codable, Sendable {
    public let agentId: String
    public let repo: String
    public let prompt: String
    public let model: String?

    public init(agentId: String, repo: String, prompt: String, model: String? = nil) {
        self.agentId = agentId
        self.repo = repo
        self.prompt = prompt
        self.model = model
    }
}
