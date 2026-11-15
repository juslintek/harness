import Foundation
import Testing
@testable import Harness

private final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T

    init(_ value: T) {
        self._value = value
    }

    var value: T {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _value
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            _value = newValue
        }
    }

    func mutate(_ transform: (inout T) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        transform(&_value)
    }
}

private final class ChatMockURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) static var requestHandler: (@Sendable (URLRequest) throws -> (HTTPURLResponse, Data))?

    nonisolated static func setHandler(_ handler: @Sendable @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) {
        lock.lock()
        requestHandler = handler
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let handler = Self.requestHandler
        Self.lock.unlock()

        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private func extractBody(from request: URLRequest) -> Data? {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 1024)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read > 0 { data.append(buffer, count: read) } else { break }
    }
    return data
}

nonisolated private func makeTestClient(
    handler: @Sendable @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
) -> HarnessAPIClient {
    ChatMockURLProtocol.setHandler(handler)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ChatMockURLProtocol.self]
    let session = URLSession(configuration: config)
    return HarnessAPIClient(
        origin: "http://localhost:4100",
        tokenProvider: { "chat_test_token" },
        session: session
    )
}

@Suite("ChatStoreTests", .serialized)
struct ChatStoreTests {

    @Test("Channel and DM grouping and unread clear on markRead")
    @MainActor
    func testChannelGroupingAndUnreadClear() async throws {
        let chOrg = ChatChannel(id: "chn_1", orgId: "org_1", kind: "org", name: "general", createdAt: 1000, unread: 3)
        let chTeam = ChatChannel(id: "chn_2", orgId: "org_1", kind: "team", name: "eng", createdAt: 1010, unread: 0)
        let chProj = ChatChannel(id: "chn_3", orgId: "org_1", kind: "project", name: "mobile", createdAt: 1020, unread: 1)
        let chGrp = ChatChannel(id: "chn_4", orgId: "org_1", kind: "group", name: "launch", createdAt: 1030, unread: 2)
        let chDm = ChatChannel(id: "chn_5", orgId: "org_1", kind: "dm", name: "alice", createdAt: 1040, unread: 4)

        let markReadCalled = LockedBox(false)
        let client = makeTestClient { req in
            if req.httpMethod == "POST" && req.url?.path == "/api/channels/chn_1/read" {
                markReadCalled.value = true
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                let data = try! JSONEncoder().encode(ReadChannelResponse(ok: true))
                return (res, data)
            }
            throw URLError(.badURL)
        }

        let store = ChatStore(apiClient: client)
        store.channels = [chOrg, chTeam, chProj, chGrp, chDm]
        store.activeChannel = chOrg

        #expect(store.generalChannels.count == 4)
        #expect(store.generalChannels.map(\.id) == ["chn_1", "chn_2", "chn_3", "chn_4"])
        #expect(store.directMessages.count == 1)
        #expect(store.directMessages.first?.id == "chn_5")

        await store.markChannelRead(channelId: "chn_1")
        #expect(markReadCalled.value)
        #expect(store.channels.first(where: { $0.id == "chn_1" })?.unread == 0)
        #expect(store.activeChannel?.unread == 0)
    }

    @Test("Cursor pagination ordering and deduplication")
    @MainActor
    func testCursorPaginationOrderingAndDeduplication() async throws {
        let requestedCursors = LockedBox<[String]>([])

        let client = makeTestClient { req in
            let path = req.url?.path ?? ""
            let query = req.url?.query ?? ""
            guard path == "/api/channels/chn_page/messages" else {
                throw URLError(.badURL)
            }

            if query.contains("before=") {
                let params = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems
                let beforeVal = params?.first(where: { $0.name == "before" })?.value ?? ""
                requestedCursors.mutate { $0.append(beforeVal) }

                var older: [ChatMessage] = []
                for i in 1...50 {
                    let ts = Int64(500 + i)
                    let id = i == 50 ? "msg_initial_1" : "msg_older_\(i)"
                    older.append(ChatMessage(id: id, channelId: "chn_page", body: "Older \(i)", createdAt: ts))
                }
                let data = try! JSONEncoder().encode(older)
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, data)
            } else {
                var initial: [ChatMessage] = []
                for i in 1...50 {
                    let ts = Int64(1000 + i)
                    initial.append(ChatMessage(id: "msg_initial_\(i)", channelId: "chn_page", body: "Msg \(i)", createdAt: ts))
                }
                initial.reverse()
                let data = try! JSONEncoder().encode(initial)
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, data)
            }
        }

        let store = ChatStore(apiClient: client)
        store.activeChannel = ChatChannel(id: "chn_page", orgId: "org_1", kind: "org", name: "page-test", createdAt: 100, unread: 0)

        await store.loadInitialMessages(channelId: "chn_page")
        #expect(store.messages.count == 50)
        #expect(store.messages.first?.id == "msg_initial_1")
        #expect(store.messages.last?.id == "msg_initial_50")
        #expect(store.hasOlderMessages == true)

        let oldest = store.messages.first!
        let expectedCursor = "\(oldest.createdAt):\(oldest.id)"

        await store.loadOlderMessages()
        #expect(requestedCursors.value == [expectedCursor])
        #expect(store.messages.count == 99)
        #expect(store.messages.first?.id == "msg_older_1")
        #expect(store.messages.last?.id == "msg_initial_50")
    }

    @Test("Mention token extraction and member filtering at cursor")
    func testMentionTokenExtractionAndFiltering() {
        #expect(ChatMentionHelper.mentionQuery(in: "Hello @ali") == "ali")
        #expect(ChatMentionHelper.mentionQuery(in: "Hello @") == "")
        #expect(ChatMentionHelper.mentionQuery(in: "bob@example.com") == nil)
        #expect(ChatMentionHelper.mentionQuery(in: "Hey @ali and @bob", upTo: 8) == "ali")
        #expect(ChatMentionHelper.mentionQuery(in: "@claude-3-7") == "claude-3-7")
        #expect(ChatMentionHelper.mentionQuery(in: "test @!") == nil)

        let members = [
            ChatMember(id: "m1", kind: "human", handle: "alice", displayName: "Alice Cooper"),
            ChatMember(id: "m2", kind: "human", handle: "alicia", displayName: "Alicia Keys"),
            ChatMember(id: "m3", kind: "agent", handle: "claude-code", displayName: "Claude Agent"),
            ChatMember(id: "m4", kind: "human", handle: "bob", displayName: "Bob Ross")
        ]

        let aliMatches = ChatMentionHelper.filterMembers(members, prefix: "ali")
        #expect(aliMatches.map(\.handle) == ["alice", "alicia"])

        let agentMatches = ChatMentionHelper.filterMembers(members, prefix: "claude")
        #expect(agentMatches.map(\.handle) == ["claude-code"])
        #expect(agentMatches.first?.kind == "agent")

        let inserted = ChatMentionHelper.insertMention(handle: "alice", into: "Hello @ali there", cursor: 10)
        #expect(inserted.text == "Hello @alice there")
        #expect(inserted.newCursor == 13)
    }

    @Test("Thread message loading reply posting and WS chat nudge handling")
    @MainActor
    func testThreadLoadingPostingAndWSNudge() async throws {
        let requestedThreadId = LockedBox<String?>(nil)
        let postedThreadRootId = LockedBox<String?>(nil)

        let client = makeTestClient { req in
            let path = req.url?.path ?? ""
            let query = req.url?.query ?? ""

            if req.httpMethod == "GET" && path == "/api/channels/chn_1/messages" {
                if query.contains("thread=msg_root_1") {
                    requestedThreadId.value = "msg_root_1"
                    let replies = [
                        ChatMessage(id: "msg_rep_1", channelId: "chn_1", threadRootId: "msg_root_1", body: "Reply 1", createdAt: 1100),
                        ChatMessage(id: "msg_rep_2", channelId: "chn_1", threadRootId: "msg_root_1", body: "Reply 2", createdAt: 1200)
                    ]
                    let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                    return (res, try! JSONEncoder().encode(replies))
                } else {
                    let msgs = [
                        ChatMessage(id: "msg_root_1", channelId: "chn_1", body: "Root Msg", createdAt: 1000, replyCount: 2)
                    ]
                    let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                    return (res, try! JSONEncoder().encode(msgs))
                }
            } else if req.httpMethod == "POST" && path == "/api/channels/chn_1/messages" {
                guard let bodyData = extractBody(from: req),
                      let body = try? JSONDecoder().decode(PostMessageRequest.self, from: bodyData) else {
                    throw URLError(.cannotDecodeContentData)
                }
                postedThreadRootId.value = body.threadRootId
                let created = ChatMessage(
                    id: "msg_rep_new", channelId: "chn_1", threadRootId: body.threadRootId,
                    body: body.body, createdAt: 1300
                )
                let res = HTTPURLResponse(url: req.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode(created))
            } else if req.httpMethod == "POST" && path == "/api/channels/chn_1/read" {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode(ReadChannelResponse(ok: true)))
            } else if req.httpMethod == "GET" && path == "/api/orgs/acme/channels" {
                let channels = [
                    ChatChannel(id: "chn_1", orgId: "org_1", kind: "org", name: "general", createdAt: 1000, unread: 0)
                ]
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode(channels))
            }
            throw URLError(.badURL)
        }

        let store = ChatStore(apiClient: client, currentSlug: "acme")
        let activeCh = ChatChannel(id: "chn_1", orgId: "org_1", kind: "org", name: "general", createdAt: 1000, unread: 1)
        store.channels = [activeCh]
        store.activeChannel = activeCh

        let rootMsg = ChatMessage(id: "msg_root_1", channelId: "chn_1", body: "Root Msg", createdAt: 1000, replyCount: 2)
        store.messages = [rootMsg]

        // Open thread
        await store.openThread(rootMsg)
        #expect(requestedThreadId.value == "msg_root_1")
        #expect(store.threadMessages.count == 2)
        #expect(store.activeThread?.id == "msg_root_1")

        // Post reply
        let reply = try await store.sendMessage(body: "Reply 3", threadRootId: "msg_root_1")
        #expect(postedThreadRootId.value == "msg_root_1")
        #expect(reply.id == "msg_rep_new")
        #expect(store.threadMessages.count == 3)
        #expect(store.messages.first?.replyCount == 3)

        // WS nudge with threadRootId != nil matching active thread
        await store.handleWsChat(channelId: "chn_1", messageId: "msg_rep_ws", threadRootId: "msg_root_1")
        #expect(store.activeChannel?.unread == 0)

        // Close thread
        store.closeThread()
        #expect(store.activeThread == nil)
        #expect(store.threadMessages.isEmpty)

        // WS nudge with threadRootId == nil
        await store.handleWsChat(channelId: "chn_1", messageId: "msg_new_top", threadRootId: nil)
        #expect(store.messages.count == 1)
    }

    @Test("Deep link jump selects channel")
    @MainActor
    func testDeepLinkJump() async throws {
        let store = ChatStore()
        let ch1 = ChatChannel(id: "chn_target", orgId: "org_1", kind: "org", name: "target", createdAt: 100, unread: 2)
        store.channels = [ch1]

        let url = URL(string: "harness://chat/acme/chn_target")!
        let handled = await store.handleDeepLink(url: url, orgSlug: "acme")
        #expect(handled)
        #expect(store.activeChannel?.id == "chn_target")
    }

    @Test("Create DM and Create Group")
    @MainActor
    func testCreateDmAndGroup() async throws {
        let client = makeTestClient { req in
            let path = req.url?.path ?? ""
            if req.httpMethod == "POST" && path == "/api/orgs/acme/dms" {
                guard let bodyData = extractBody(from: req),
                      let body = try? JSONDecoder().decode(CreateDmRequest.self, from: bodyData) else {
                    throw URLError(.cannotDecodeContentData)
                }
                guard body.memberId == "mem_alice" else { throw URLError(.badServerResponse) }
                let created = ChatChannel(id: "chn_dm_alice", orgId: "org_1", kind: "dm", name: "alice", createdAt: 2000, unread: 0)
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode(created))
            } else if req.httpMethod == "POST" && path == "/api/orgs/acme/groups" {
                guard let bodyData = extractBody(from: req),
                      let body = try? JSONDecoder().decode(CreateGroupRequest.self, from: bodyData) else {
                    throw URLError(.cannotDecodeContentData)
                }
                guard body.name == "Frontend Team", body.memberIds == ["mem_alice", "mem_bob"] else {
                    throw URLError(.badServerResponse)
                }
                let created = ChatChannel(id: "chn_grp_fe", orgId: "org_1", kind: "group", name: "Frontend Team", createdAt: 2100, unread: 0)
                let res = HTTPURLResponse(url: req.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode(created))
            } else if req.httpMethod == "GET" && path.hasPrefix("/api/channels/") && path.hasSuffix("/messages") {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode([ChatMessage]()))
            } else if req.httpMethod == "GET" && path.hasPrefix("/api/channels/") && path.hasSuffix("/members") {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode([ChatMember]()))
            } else if req.httpMethod == "POST" && path.hasPrefix("/api/channels/") && path.hasSuffix("/read") {
                let res = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (res, try! JSONEncoder().encode(ReadChannelResponse(ok: true)))
            }
            throw URLError(.badURL)
        }

        let store = ChatStore(apiClient: client, currentSlug: "acme")
        let dm = try await store.createDm(slug: "acme", memberId: "mem_alice")
        #expect(dm.id == "chn_dm_alice")
        #expect(store.activeChannel?.id == "chn_dm_alice")
        #expect(store.directMessages.count == 1)

        let grp = try await store.createGroup(slug: "acme", name: "Frontend Team", memberIds: ["mem_alice", "mem_bob"])
        #expect(grp.id == "chn_grp_fe")
        #expect(store.activeChannel?.id == "chn_grp_fe")
        #expect(store.generalChannels.contains(where: { $0.id == "chn_grp_fe" }))
    }
}
