import Foundation

public struct CreateDmRequest: Codable, Sendable {
    public let memberId: String
    public init(memberId: String) { self.memberId = memberId }
}

public struct CreateGroupRequest: Codable, Sendable {
    public let name: String
    public let memberIds: [String]
    public init(name: String, memberIds: [String]) {
        self.name = name
        self.memberIds = memberIds
    }
}

public struct ReadChannelResponse: Codable, Sendable {
    public let ok: Bool
    public init(ok: Bool = true) { self.ok = ok }
}

public struct OrgDirectoryMember: Codable, Sendable, Identifiable {
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

public struct OrgDirectoryResponse: Codable, Sendable {
    public let members: [OrgDirectoryMember]?
    public init(members: [OrgDirectoryMember]? = nil) { self.members = members }
}

extension ChatChannel: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

extension ChatTaskReference: Identifiable, Hashable {
    public var id: String { "\(projectId)-\(number)" }
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

extension Array where Element == ChatMessage {
    public func sortedChronologically() -> [ChatMessage] {
        var dict = [String: ChatMessage]()
        for m in self { dict[m.id] = m }
        return dict.values.sorted { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : $0.id < $1.id }
    }

    public func mergedWith(_ incoming: [ChatMessage]) -> [ChatMessage] {
        var dict = [String: ChatMessage]()
        for m in self { dict[m.id] = m }
        for m in incoming { dict[m.id] = m }
        return dict.values.sorted { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : $0.id < $1.id }
    }
}
