import Foundation
import Observation

@Observable
@MainActor
public final class ChatStore {
    public var channels: [ChatChannel] = []
    public var activeChannel: ChatChannel?
    public var messages: [ChatMessage] = []
    public var channelMembers: [ChatMember] = []
    public var orgMembers: [ChatMember] = []
    public var activeThread: ChatMessage?
    public var threadMessages: [ChatMessage] = []
    public var isLoading: Bool = false
    public var isLoadingOlder: Bool = false
    public var hasOlderMessages: Bool = false
    public var isLoadingThread: Bool = false
    public var bannerMessage: String?
    public var isNewDmPresented: Bool = false
    public var isNewGroupPresented: Bool = false

    public let apiClient: HarnessAPIClient?
    public var currentSlug: String?
    public var currentMemberId: String?
    public var wsClient: HarnessWSClient?
    private var wsTask: Task<Void, Never>?

    public init(apiClient: HarnessAPIClient? = nil, currentSlug: String? = nil, currentMemberId: String? = nil) {
        self.apiClient = apiClient
        self.currentSlug = currentSlug
        self.currentMemberId = currentMemberId
    }

    public var generalChannels: [ChatChannel] { channels.filter { $0.kind != "dm" } }
    public var directMessages: [ChatChannel] { channels.filter { $0.kind == "dm" } }

    public func loadChannels(slug: String) async {
        guard let apiClient else { return }
        self.currentSlug = slug
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(slug)/channels")
            let loaded: [ChatChannel] = try await apiClient.send(req)
            self.channels = loaded
            if let active = activeChannel, let refreshed = loaded.first(where: { $0.id == active.id }) {
                self.activeChannel = refreshed
            }
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func loadOrgDirectory(slug: String) async {
        guard let apiClient else { return }
        self.currentSlug = slug
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(slug)")
            let res: OrgDirectoryResponse = try await apiClient.send(req)
            self.orgMembers = (res.members ?? []).map {
                ChatMember(id: $0.id, kind: $0.kind, handle: $0.handle, displayName: $0.displayName)
            }
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func selectChannel(_ channel: ChatChannel) async {
        activeChannel = channel
        activeThread = nil
        threadMessages = []
        async let loadMsg: Void = loadInitialMessages(channelId: channel.id)
        async let loadMbr: Void = loadChannelMembers(channelId: channel.id)
        async let mark: Void = markChannelRead(channelId: channel.id)
        _ = await (loadMsg, loadMbr, mark)
    }

    public func loadInitialMessages(channelId: String) async {
        guard let apiClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let req = try apiClient.buildRequest(path: "/api/channels/\(channelId)/messages?limit=50")
            let loaded: [ChatMessage] = try await apiClient.send(req)
            self.messages = loaded.sortedChronologically()
            self.hasOlderMessages = loaded.count >= 50
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func loadOlderMessages() async {
        guard let apiClient, let active = activeChannel, let oldest = messages.first,
              hasOlderMessages, !isLoadingOlder else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let cursor = "\(oldest.createdAt):\(oldest.id)"
            let req = try apiClient.buildRequest(path: "/api/channels/\(active.id)/messages?before=\(cursor)&limit=50")
            let older: [ChatMessage] = try await apiClient.send(req)
            self.messages = self.messages.mergedWith(older)
            self.hasOlderMessages = older.count >= 50
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func loadChannelMembers(channelId: String) async {
        guard let apiClient else { return }
        do {
            let req = try apiClient.buildRequest(path: "/api/channels/\(channelId)/members")
            let members: [ChatMember] = try await apiClient.send(req)
            self.channelMembers = members
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func markChannelRead(channelId: String) async {
        let updateChannel: (ChatChannel) -> ChatChannel = { ch in
            ChatChannel(id: ch.id, orgId: ch.orgId, kind: ch.kind, name: ch.name,
                        teamId: ch.teamId, projectId: ch.projectId, createdAt: ch.createdAt, unread: 0)
        }
        if let idx = channels.firstIndex(where: { $0.id == channelId }) {
            channels[idx] = updateChannel(channels[idx])
        }
        if activeChannel?.id == channelId {
            activeChannel = updateChannel(activeChannel!)
        }
        guard let apiClient else { return }
        do {
            let req = try apiClient.buildRequest(path: "/api/channels/\(channelId)/read", method: "POST")
            let _: ReadChannelResponse = try await apiClient.send(req)
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func sendMessage(body: String, threadRootId: String? = nil) async throws -> ChatMessage {
        guard let apiClient, let active = activeChannel else {
            throw HarnessAPIError.invalidURL("No active channel")
        }
        let payload = PostMessageRequest(body: body, threadRootId: threadRootId)
        let bodyData = try JSONEncoder().encode(payload)
        let req = try apiClient.buildRequest(path: "/api/channels/\(active.id)/messages", method: "POST", body: bodyData)
        let created: ChatMessage = try await apiClient.send(req)
        if threadRootId == nil {
            messages = messages.mergedWith([created])
        } else {
            threadMessages = threadMessages.mergedWith([created])
            if let rootIdx = messages.firstIndex(where: { $0.id == threadRootId }) {
                let r = messages[rootIdx]
                messages[rootIdx] = ChatMessage(id: r.id, channelId: r.channelId, threadRootId: r.threadRootId,
                    authorId: r.authorId, author: r.author, body: r.body, createdAt: r.createdAt,
                    editedAt: r.editedAt, replyCount: r.replyCount + 1, mentions: r.mentions,
                    taskIds: r.taskIds, tasks: r.tasks)
            }
        }
        return created
    }

    public func createDm(slug: String, memberId: String) async throws -> ChatChannel {
        guard let apiClient else { throw HarnessAPIError.invalidURL("No API client") }
        let bodyData = try JSONEncoder().encode(CreateDmRequest(memberId: memberId))
        let req = try apiClient.buildRequest(path: "/api/orgs/\(slug)/dms", method: "POST", body: bodyData)
        let created: ChatChannel = try await apiClient.send(req)
        if !channels.contains(where: { $0.id == created.id }) { channels.append(created) }
        await selectChannel(created)
        return created
    }

    public func createGroup(slug: String, name: String, memberIds: [String]) async throws -> ChatChannel {
        guard let apiClient else { throw HarnessAPIError.invalidURL("No API client") }
        let bodyData = try JSONEncoder().encode(CreateGroupRequest(name: name, memberIds: memberIds))
        let req = try apiClient.buildRequest(path: "/api/orgs/\(slug)/groups", method: "POST", body: bodyData)
        let created: ChatChannel = try await apiClient.send(req)
        if !channels.contains(where: { $0.id == created.id }) { channels.append(created) }
        await selectChannel(created)
        return created
    }

    public func openThread(_ message: ChatMessage) async {
        activeThread = message
        await loadThreadMessages(rootId: message.id)
    }

    public func closeThread() {
        activeThread = nil
        threadMessages = []
    }

    public func loadThreadMessages(rootId: String) async {
        guard let apiClient, let active = activeChannel else { return }
        isLoadingThread = true
        defer { isLoadingThread = false }
        do {
            let req = try apiClient.buildRequest(path: "/api/channels/\(active.id)/messages?thread=\(rootId)&limit=100")
            let loaded: [ChatMessage] = try await apiClient.send(req)
            self.threadMessages = loaded.sortedChronologically()
        } catch {
            bannerMessage = error.localizedDescription
        }
    }

    public func handleWsChat(channelId: String, messageId: String, threadRootId: String?) async {
        if channelId == activeChannel?.id {
            if let root = threadRootId, activeThread?.id == root {
                await loadThreadMessages(rootId: root)
            }
            await loadInitialMessages(channelId: channelId)
            await markChannelRead(channelId: channelId)
        }
        if let slug = currentSlug { await loadChannels(slug: slug) }
    }

    public func handleDeepLink(url: URL, orgSlug: String) async -> Bool {
        guard let parsed = DeepLinkRouter.parse(url),
              case .chat(let slug, let channelId) = parsed.target,
              let cid = channelId else { return false }
        let targetSlug = slug ?? orgSlug

        if let existing = channels.first(where: { $0.id == cid }) {
            await selectChannel(existing)
            return true
        }
        await loadChannels(slug: targetSlug)
        if let found = channels.first(where: { $0.id == cid }) {
            await selectChannel(found)
            return true
        }
        let fallback = ChatChannel(id: cid, orgId: "", kind: "org", name: cid, createdAt: 0, unread: 0)
        await selectChannel(fallback)
        return true
    }

    public func subscribeToRealtime(orgId: String) {
        guard let apiClient else { return }
        wsTask?.cancel()
        let ws = HarnessWSClient(origin: apiClient.origin, topic: "org:\(orgId)", tokenProvider: apiClient.tokenProvider)
        self.wsClient = ws
        wsTask = Task { [weak self] in
            let stream = ws.connect()
            for await message in stream {
                guard let self else { break }
                if case .chat(let channelId, let messageId, let threadRootId) = message {
                    await self.handleWsChat(channelId: channelId, messageId: messageId, threadRootId: threadRootId)
                }
            }
        }
    }

    public func stopRealtime() {
        wsTask?.cancel()
        wsTask = nil
        Task { [wsClient] in await wsClient?.disconnect() }
    }
}
