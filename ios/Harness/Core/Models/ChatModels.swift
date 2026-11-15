import Foundation

public struct ChatChannel: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let orgId: String
    public let kind: String
    public let name: String
    public let teamId: String?
    public let projectId: String?
    public let createdAt: Int64
    public let unread: Int

    public init(
        id: String,
        orgId: String,
        kind: String,
        name: String,
        teamId: String? = nil,
        projectId: String? = nil,
        createdAt: Int64,
        unread: Int = 0
    ) {
        self.id = id
        self.orgId = orgId
        self.kind = kind
        self.name = name
        self.teamId = teamId
        self.projectId = projectId
        self.createdAt = createdAt
        self.unread = unread
    }
}

public struct ChatMember: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let handle: String
    public let displayName: String

    public init(id: String, kind: String = "human", handle: String, displayName: String) {
        self.id = id
        self.kind = kind
        self.handle = handle
        self.displayName = displayName
    }
}

public struct ChatTaskReference: Codable, Sendable, Equatable {
    public let number: Int
    public let projectId: String

    public init(number: Int, projectId: String) {
        self.number = number
        self.projectId = projectId
    }
}

public struct ChatMessage: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let channelId: String
    public let threadRootId: String?
    public let authorId: String?
    public let author: PersonRef?
    public let body: String
    public let createdAt: Int64
    public let editedAt: Int64?
    public let replyCount: Int
    public let mentions: [String]
    public let taskIds: [String]
    public let tasks: [ChatTaskReference]

    public init(
        id: String,
        channelId: String,
        threadRootId: String? = nil,
        authorId: String? = nil,
        author: PersonRef? = nil,
        body: String,
        createdAt: Int64,
        editedAt: Int64? = nil,
        replyCount: Int = 0,
        mentions: [String] = [],
        taskIds: [String] = [],
        tasks: [ChatTaskReference] = []
    ) {
        self.id = id
        self.channelId = channelId
        self.threadRootId = threadRootId
        self.authorId = authorId
        self.author = author
        self.body = body
        self.createdAt = createdAt
        self.editedAt = editedAt
        self.replyCount = replyCount
        self.mentions = mentions
        self.taskIds = taskIds
        self.tasks = tasks
    }
}

public struct ChatMessagesResponse: Codable, Sendable, Equatable {
    public let channels: [ChatChannel]
    public let members: [ChatMember]
    public let messages: [ChatMessage]

    public init(channels: [ChatChannel], members: [ChatMember], messages: [ChatMessage]) {
        self.channels = channels
        self.members = members
        self.messages = messages
    }
}

public struct PostMessageRequest: Codable, Sendable {
    public let body: String
    public let threadRootId: String?

    public init(body: String, threadRootId: String? = nil) {
        self.body = body
        self.threadRootId = threadRootId
    }
}
