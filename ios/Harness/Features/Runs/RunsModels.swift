import Foundation

public struct WakeupView: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let memberId: String
    public let reason: String
    public let taskId: String?
    public let taskNumber: Int?
    public let channelId: String?
    public let channelName: String?
    public let messageId: String?
    public let causedBy: String?
    public let status: String
    public let runId: String?
    public let createdAt: Int64
    public let startedAt: Int64?
    public let endedAt: Int64?

    public init(
        id: String,
        memberId: String,
        reason: String,
        taskId: String? = nil,
        taskNumber: Int? = nil,
        channelId: String? = nil,
        channelName: String? = nil,
        messageId: String? = nil,
        causedBy: String? = nil,
        status: String,
        runId: String? = nil,
        createdAt: Int64,
        startedAt: Int64? = nil,
        endedAt: Int64? = nil
    ) {
        self.id = id
        self.memberId = memberId
        self.reason = reason
        self.taskId = taskId
        self.taskNumber = taskNumber
        self.channelId = channelId
        self.channelName = channelName
        self.messageId = messageId
        self.causedBy = causedBy
        self.status = status
        self.runId = runId
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}

public struct WakeMemberRequest: Codable, Sendable {
    public let taskId: String?

    public init(taskId: String? = nil) {
        self.taskId = taskId
    }
}

public struct WakeMemberResponse: Codable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

public struct StartRunResponse: Codable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }
}

public struct ActionOkResponse: Codable, Sendable {
    public let ok: Bool

    public init(ok: Bool = true) {
        self.ok = ok
    }
}

public enum RunFilter: String, CaseIterable, Identifiable, Sendable {
    case active = "Active"
    case all = "All"

    public var id: String { rawValue }
}
