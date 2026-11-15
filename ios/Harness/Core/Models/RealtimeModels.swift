import Foundation

public struct WsEventPayload: Codable, Sendable, Equatable {
    public let kind: String
    public let ts: Int64?

    public init(kind: String, ts: Int64? = nil) {
        self.kind = kind
        self.ts = ts
    }
}

public enum WsMessage: Codable, Sendable, Equatable {
    case event(runId: String, event: WsEventPayload)
    case run(Run)
    case approval(Approval)
    case task(projectId: String, taskId: String, kind: String)
    case chat(channelId: String, messageId: String, threadRootId: String?)
    case dashboard
    case memory(orgId: String)

    private enum CodingKeys: String, CodingKey {
        case type
        case runId
        case event
        case run
        case approval
        case projectId
        case taskId
        case kind
        case channelId
        case messageId
        case threadRootId
        case orgId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "event":
            let runId = try container.decode(String.self, forKey: .runId)
            let event = try container.decode(WsEventPayload.self, forKey: .event)
            self = .event(runId: runId, event: event)
        case "run":
            let run = try container.decode(Run.self, forKey: .run)
            self = .run(run)
        case "approval":
            let approval = try container.decode(Approval.self, forKey: .approval)
            self = .approval(approval)
        case "task":
            let projectId = try container.decode(String.self, forKey: .projectId)
            let taskId = try container.decode(String.self, forKey: .taskId)
            let kind = try container.decode(String.self, forKey: .kind)
            self = .task(projectId: projectId, taskId: taskId, kind: kind)
        case "chat":
            let channelId = try container.decode(String.self, forKey: .channelId)
            let messageId = try container.decode(String.self, forKey: .messageId)
            let threadRootId = try container.decodeIfPresent(String.self, forKey: .threadRootId)
            self = .chat(channelId: channelId, messageId: messageId, threadRootId: threadRootId)
        case "dashboard":
            self = .dashboard
        case "memory":
            let orgId = try container.decode(String.self, forKey: .orgId)
            self = .memory(orgId: orgId)
        default:
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unknown ws message type: \(type)")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .event(let runId, let event):
            try container.encode("event", forKey: .type)
            try container.encode(runId, forKey: .runId)
            try container.encode(event, forKey: .event)
        case .run(let run):
            try container.encode("run", forKey: .type)
            try container.encode(run, forKey: .run)
        case .approval(let approval):
            try container.encode("approval", forKey: .type)
            try container.encode(approval, forKey: .approval)
        case .task(let projectId, let taskId, let kind):
            try container.encode("task", forKey: .type)
            try container.encode(projectId, forKey: .projectId)
            try container.encode(taskId, forKey: .taskId)
            try container.encode(kind, forKey: .kind)
        case .chat(let channelId, let messageId, let threadRootId):
            try container.encode("chat", forKey: .type)
            try container.encode(channelId, forKey: .channelId)
            try container.encode(messageId, forKey: .messageId)
            try container.encode(threadRootId, forKey: .threadRootId)
        case .dashboard:
            try container.encode("dashboard", forKey: .type)
        case .memory(let orgId):
            try container.encode("memory", forKey: .type)
            try container.encode(orgId, forKey: .orgId)
        }
    }
}
