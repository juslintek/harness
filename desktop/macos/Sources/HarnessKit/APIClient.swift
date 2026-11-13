import Foundation

public enum APIError: Error, LocalizedError, Equatable, Sendable {
    case unauthorized
    case forbidden
    case notImplemented
    case server(status: Int, code: String)
    case transport(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized: "Not signed in, or the credentials were rejected."
        case .forbidden: "This account is not allowed to do that."
        case .notImplemented: "Not available on this backend"
        case .server(let status, let code): "Server error \(status): \(code)"
        case .transport(let message): "Could not reach the backend: \(message)"
        case .decoding(let message): "Unexpected response from the backend: \(message)"
        }
    }
}

public struct User: Codable, Sendable, Equatable {
    public let id: String
    public let email: String
    public let name: String
    public let instanceAdmin: Bool
    public let createdAt: Int
}

public struct SessionSummary: Codable, Sendable, Equatable {
    public let id: String
    public let method: String
    public let stepUpAt: Int?
    public let stepUpFresh: Bool
}

public struct Me: Codable, Sendable, Equatable {
    public let user: User
    public let session: SessionSummary
    public let orgs: [Org]
}

/// `role` is only present on the copies inside `/api/auth/me`.
public struct Org: Codable, Sendable, Equatable, Identifiable, Hashable {
    public let id: String
    public let slug: String
    public let name: String
    public let createdAt: Int
    public let role: String?
}

public struct Project: Codable, Sendable, Equatable, Identifiable, Hashable {
    public let id: String
    public let orgId: String
    public let teamId: String?
    public let key: String
    public let name: String
    public let repo: String?
}

public enum TaskStatus: String, Codable, Sendable, CaseIterable, Identifiable {
    case backlog, todo
    case inProgress = "in_progress"
    case inReview = "in_review"
    case done, blocked, cancelled

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .backlog: "Backlog"
        case .todo: "Todo"
        case .inProgress: "In progress"
        case .inReview: "In review"
        case .done: "Done"
        case .blocked: "Blocked"
        case .cancelled: "Cancelled"
        }
    }
}

public struct MemberRef: Codable, Sendable, Equatable {
    public let handle: String
    public let displayName: String
    public let kind: String
}

public struct TaskItem: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let orgId: String
    public let projectId: String
    public let number: Int
    public let parentId: String?
    public let title: String
    public let description: String
    public let status: TaskStatus
    public let rank: Double
    public let assigneeId: String?
    public let holderId: String?
    public let assignee: MemberRef?
    public let holder: MemberRef?
    public let checkedOutAt: Int?
    public let estimateMinutes: Int?
    public let createdBy: String
    public let createdAt: Int
    public let updatedAt: Int
}

public struct TaskComment: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let taskId: String
    public let authorId: String?
    public let author: MemberRef?
    public let body: String
    public let createdAt: Int

    public var created: Date { Date(timeIntervalSince1970: Double(createdAt) / 1000) }
}

public struct TaskDetail: Codable, Sendable, Equatable {
    public let task: TaskItem
    public let deps: [TaskItem]
    public let subtasks: [TaskItem]
    public let comments: [TaskComment]
}

public struct SessionInfo: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let method: String
    public let userAgent: String?
    public let createdAt: Int
    public let lastSeenAt: Int
    public let expiresAt: Int
    public let current: Bool

    public var created: Date { Date(timeIntervalSince1970: Double(createdAt) / 1000) }
    public var lastSeen: Date { Date(timeIntervalSince1970: Double(lastSeenAt) / 1000) }
}

public struct Health: Codable, Sendable, Equatable {
    public let ok: Bool
    public let instanceId: String
    public let version: String
}

/// The session cookie lives only in this client's ephemeral URLSession, so it dies with the process.
public final class APIClient: Sendable {
    public let origin: String
    private let session: URLSession

    public init(port: Int) {
        // The server only accepts a localhost Origin/Host pair, not 127.0.0.1.
        origin = "http://localhost:\(port)"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
    }

    public func health() async throws -> Health {
        try decode(await send("GET", "/api/health"))
    }

    public func requestCode(email: String) async throws {
        _ = try await send("POST", "/api/auth/email/request", body: ["email": email])
    }

    public func verify(email: String, code: String) async throws -> User {
        struct Reply: Decodable { let user: User }
        let reply: Reply = try decode(await send("POST", "/api/auth/email/verify", body: ["email": email, "code": code]))
        return reply.user
    }

    public func me() async throws -> Me {
        try decode(await send("GET", "/api/auth/me"))
    }

    public func sessions() async throws -> [SessionInfo] {
        try decode(await send("GET", "/api/auth/sessions"))
    }

    public func revokeSession(id: String) async throws {
        _ = try await send("DELETE", "/api/auth/sessions/\(id)")
    }

    public func logout() async throws {
        _ = try await send("POST", "/api/auth/logout")
    }

    /// Puts a `name=value` session cookie into this client's cookie store. For tests that start from a
    /// seeded session; the app itself signs in through the email code flow.
    public func installSessionCookie(_ pair: String) {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2,
              let cookie = HTTPCookie(properties: [.name: parts[0], .value: parts[1], .domain: "localhost", .path: "/"])
        else { return }
        session.configuration.httpCookieStorage?.setCookie(cookie)
    }

    public func orgs() async throws -> [Org] {
        try decode(await send("GET", "/api/orgs"))
    }

    public func createOrg(name: String, slug: String) async throws -> Org {
        try decode(await send("POST", "/api/orgs", body: ["name": name, "slug": slug]))
    }

    /// Projects come with the org detail; there is no separate list route.
    public func projects(orgSlug: String) async throws -> [Project] {
        struct Detail: Decodable { let projects: [Project] }
        let detail: Detail = try decode(await send("GET", "/api/orgs/\(orgSlug)"))
        return detail.projects
    }

    public func createProject(orgSlug: String, key: String, name: String) async throws -> Project {
        try decode(await send("POST", "/api/orgs/\(orgSlug)/projects", body: ["key": key, "name": name]))
    }

    public func tasks(projectId: String) async throws -> [TaskItem] {
        try decode(await send("GET", "/api/projects/\(projectId)/tasks"))
    }

    public func createTask(projectId: String, title: String, description: String = "", status: TaskStatus? = nil) async throws -> TaskItem {
        var body = ["title": title, "description": description]
        if let status { body["status"] = status.rawValue }
        return try decode(await send("POST", "/api/projects/\(projectId)/tasks", body: body))
    }

    public func task(id: String) async throws -> TaskDetail {
        try decode(await send("GET", "/api/tasks/\(id)"))
    }

    /// The board's drag-and-drop uses this route; PATCH /api/tasks/:id edits fields, not the column.
    public func moveTask(id: String, to status: TaskStatus, beforeId: String? = nil) async throws -> TaskItem {
        var body = ["to": status.rawValue]
        if let beforeId { body["beforeId"] = beforeId }
        return try decode(await send("POST", "/api/tasks/\(id)/move", body: body))
    }

    public func addComment(taskId: String, body: String) async throws -> TaskComment {
        try decode(await send("POST", "/api/tasks/\(taskId)/comments", body: ["body": body]))
    }

    /// Keeps a WebSocket on `topic` until the task is cancelled, reconnecting with a delay that doubles
    /// from 1 s to 30 s. `onEvent` gets `nil` each time a connection opens and the frame text for each
    /// frame, so callers refetch on both.
    public func watch(topic: String, onEvent: @Sendable (String?) async -> Void) async {
        var delay = 1.0
        while !Task.isCancelled {
            guard let url = URL(string: "ws" + origin.dropFirst(4) + "/ws?topic=" + (topic.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? topic)) else { return }
            var request = URLRequest(url: url)
            request.setValue(origin, forHTTPHeaderField: "Origin")
            let socket = session.webSocketTask(with: request)
            socket.resume()
            if await ping(socket) {
                delay = 1
                await onEvent(nil)
                while let message = try? await socket.receive() {
                    if case .string(let text) = message { await onEvent(text) }
                }
            }
            socket.cancel(with: .goingAway, reason: nil)
            if (try? await Task.sleep(for: .seconds(delay))) == nil { return }
            delay = min(delay * 2, 30)
        }
    }

    /// A pong proves the upgrade went through, which URLSessionWebSocketTask otherwise only reports on the first receive.
    private func ping(_ socket: URLSessionWebSocketTask) async -> Bool {
        await withCheckedContinuation { continuation in
            socket.sendPing { continuation.resume(returning: $0 == nil) }
        }
    }

    /// Raw GET for routes that have no typed method yet.
    public func get(_ path: String) async throws -> Data {
        try await send("GET", path)
    }

    private func send(_ method: String, _ path: String, body: [String: String]? = nil) async throws -> Data {
        guard let url = URL(string: origin + path) else { throw APIError.transport("bad path \(path)") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(origin, forHTTPHeaderField: "Origin")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport("not an HTTP response") }
        switch http.statusCode {
        case 200..<300: return data
        case 401: throw APIError.unauthorized
        case 403: throw APIError.forbidden
        case 501: throw APIError.notImplemented
        default:
            // Board moves refused with 409 carry `reason` (held, deps_open, children_open) instead of `error`.
            struct Body: Decodable { let error: String?; let reason: String? }
            let body = try? JSONDecoder().decode(Body.self, from: data)
            let code = body?.error ?? body?.reason ?? "unknown"
            throw APIError.server(status: http.statusCode, code: code)
        }
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding("\(error)")
        }
    }
}
