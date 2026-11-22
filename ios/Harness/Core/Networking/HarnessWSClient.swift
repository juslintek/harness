import Foundation

public enum WSClientState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case revoked
}

public protocol HarnessWebSocketTask: Sendable {
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func receive() async throws -> URLSessionWebSocketTask.Message
}

extension URLSessionWebSocketTask: HarnessWebSocketTask {}

public actor HarnessWSClient {
    public let origin: String
    public let topic: String
    public let tokenProvider: @Sendable () -> String?
    public let session: URLSession

    public private(set) var state: WSClientState = .disconnected
    private var isCancelled: Bool = false
    private var currentTask: (any HarnessWebSocketTask)?

    public init(
        origin: String,
        topic: String,
        tokenProvider: @escaping @Sendable () -> String?,
        session: URLSession = .shared
    ) {
        self.origin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.topic = topic
        self.tokenProvider = tokenProvider
        self.session = session
    }

    public nonisolated static func calculateBackoff(
        attempt: Int,
        base: TimeInterval = 1.0,
        max: TimeInterval = 30.0,
        jitterFactor: Double = 0.1,
        jitterOffset: Double? = nil
    ) -> TimeInterval {
        let exp = base * pow(2.0, Double(min(attempt, 6)))
        let clamped = min(exp, max)
        let jitter = clamped * jitterFactor * (jitterOffset ?? Double.random(in: -1.0...1.0))
        return Swift.max(0.1, Swift.min(max, clamped + jitter))
    }

    public nonisolated func connect() -> AsyncStream<WsMessage> {
        AsyncStream { continuation in
            continuation.onTermination = { [weak self] _ in
                Task { [weak self] in
                    await self?.disconnect()
                }
            }

            Task { [weak self] in
                await self?.runConnectionLoop(continuation: continuation)
            }
        }
    }

    public func disconnect() {
        isCancelled = true
        let task = currentTask
        currentTask = nil
        if state != .revoked {
            state = .disconnected
        }
        task?.cancel(with: .normalClosure, reason: nil)
    }

    public func handleCloseCode(_ code: Int) -> Bool {
        if code == 4401 {
            state = .revoked
            return true
        }
        return false
    }

    private func runConnectionLoop(continuation: AsyncStream<WsMessage>.Continuation) async {
        var attempt = 0
        isCancelled = false

        while true {
            if isCancelled || state == .revoked {
                break
            }

            state = .connecting
            do {
                guard let wsURL = buildWebSocketURL() else {
                    state = .disconnected
                    break
                }
                var req = URLRequest(url: wsURL)
                req.setValue(origin, forHTTPHeaderField: "Origin")
                if let token = tokenProvider() {
                    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }

                let task = session.webSocketTask(with: req)
                currentTask = task

                task.resume()
                state = .connected
                attempt = 0

                try await receiveLoop(task: task, continuation: continuation)
            } catch {
                let wsCloseRevoked = (currentTask as? URLSessionWebSocketTask)?.closeCode.rawValue == 4401
                if wsCloseRevoked {
                    state = .revoked
                }
                let isRevoked = wsCloseRevoked || handleDisconnectError(error)
                if isRevoked {
                    continuation.finish()
                    break
                }
            }

            if isCancelled || state == .revoked {
                continuation.finish()
                break
            }

            state = .disconnected
            let delay = Self.calculateBackoff(attempt: attempt)
            attempt += 1
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    private func receiveLoop(
        task: any HarnessWebSocketTask,
        continuation: AsyncStream<WsMessage>.Continuation
    ) async throws {
        while true {
            if isCancelled { break }

            let message = try await task.receive()
            switch message {
            case .string(let text):
                if let data = text.data(using: .utf8),
                   let msg = try? JSONDecoder().decode(WsMessage.self, from: data) {
                    continuation.yield(msg)
                }
            case .data(let data):
                if let msg = try? JSONDecoder().decode(WsMessage.self, from: data) {
                    continuation.yield(msg)
                }
            @unknown default:
                break
            }
        }
    }

    private func handleDisconnectError(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.code == 4401 || nsError.userInfo["closeCode"] as? Int == 4401 {
            state = .revoked
            return true
        }
        return false
    }

    private func buildWebSocketURL() -> URL? {
        guard var components = URLComponents(string: origin) else { return nil }
        if components.scheme == "https" {
            components.scheme = "wss"
        } else {
            components.scheme = "ws"
        }
        components.path = "/ws"
        components.queryItems = [URLQueryItem(name: "topic", value: topic)]
        return components.url
    }
}
