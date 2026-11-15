import Foundation

public enum NotificationChannel: String, CaseIterable, Codable, Sendable {
    case push
    case email
    case slack
    case telegram
    case webhook

    public var label: String {
        switch self {
        case .push: return "Push"
        case .email: return "Email"
        case .slack: return "Slack"
        case .telegram: return "Telegram"
        case .webhook: return "Webhook"
        }
    }
}

public enum NotificationKind: String, CaseIterable, Codable, Sendable {
    case approvalRequested = "approval_requested"
    case approvalResolved = "approval_resolved"
    case mention = "mention"
    case dm = "dm"
    case runBlocked = "run_blocked"

    public var label: String {
        switch self {
        case .approvalRequested: return "Approval needed"
        case .approvalResolved: return "Approval decided"
        case .mention: return "Mentioned in chat"
        case .dm: return "Direct message"
        case .runBlocked: return "Run blocked"
        }
    }
}

public struct NotificationPref: Codable, Sendable, Equatable {
    public let channel: NotificationChannel
    public let kind: NotificationKind
    public var enabled: Bool

    public init(channel: NotificationChannel, kind: NotificationKind, enabled: Bool) {
        self.channel = channel
        self.kind = kind
        self.enabled = enabled
    }
}

public struct NotificationTarget: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let channel: String
    public let label: String?

    public init(id: String, channel: String, label: String? = nil) {
        self.id = id
        self.channel = channel
        self.label = label
    }
}

public struct PushTargetCreateResponse: Codable, Sendable {
    public let id: String
    public init(id: String) { self.id = id }
}
