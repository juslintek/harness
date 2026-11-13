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
        case .notImplemented: "The backend does not implement this yet."
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
            struct Body: Decodable { let error: String }
            let code = (try? JSONDecoder().decode(Body.self, from: data))?.error ?? "unknown"
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
