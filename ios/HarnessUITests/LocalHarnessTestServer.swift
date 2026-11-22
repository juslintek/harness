import Foundation
import Network

final class LocalHarnessTestServer: @unchecked Sendable {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var stepUpDone = false
        var approvalStatus = "pending"
        var chatMessages: [(id: String, body: String)] = [
            ("msg_init", "Welcome to #general")
        ]
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.harness.uitest.server")
    private let state = State()
    private(set) var port: UInt16 = 0

    var origin: String { "http://127.0.0.1:\(port)" }

    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        self.listener = try NWListener(using: params)
    }

    func start() throws {
        let readySemaphore = DispatchSemaphore(value: 0)
        final class StartBox: @unchecked Sendable {
            var error: Error?
            var port: UInt16 = 0
        }
        let box = StartBox()

        listener.stateUpdateHandler = { [weak listener] newState in
            switch newState {
            case .ready:
                box.port = listener?.port?.rawValue ?? 0
                readySemaphore.signal()
            case .failed(let err):
                box.error = err
                readySemaphore.signal()
            default:
                break
            }
        }

        let state = self.state
        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection, state: state)
        }
        listener.start(queue: queue)
        readySemaphore.wait()

        if let err = box.error { throw err }
        self.port = box.port
    }

    func stop() {
        listener.cancel()
    }

    private func handleConnection(_ connection: NWConnection, state: State) {
        connection.start(queue: queue)
        readRequest(connection: connection, buffer: Data()) { [weak self] method, fullPath, body in
            guard let self else {
                connection.cancel()
                return
            }
            let (status, json) = self.route(method: method, fullPath: fullPath, body: body, state: state)
            let bodyData = Data(json.utf8)
            let statusText = status == 200 ? "OK" : (status == 403 ? "Forbidden" : "Not Found")
            let headers = [
                "HTTP/1.1 \(status) \(statusText)",
                "Content-Type: application/json",
                "Content-Length: \(bodyData.count)",
                "Connection: close",
                "",
                ""
            ].joined(separator: "\r\n")
            var payload = Data(headers.utf8)
            payload.append(bodyData)
            connection.send(content: payload, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func readRequest(
        connection: NWConnection,
        buffer: Data,
        completion: @escaping @Sendable (String, String, Data) -> Void
    ) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, _ in
            var accumulated = buffer
            if let data { accumulated.append(data) }

            if let headerRange = accumulated.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = accumulated.subdata(in: 0..<headerRange.lowerBound)
                let bodyStart = headerRange.upperBound
                let headerText = String(data: headerData, encoding: .utf8) ?? ""
                let lines = headerText.components(separatedBy: "\r\n")
                let requestLine = (lines.first ?? "").components(separatedBy: " ")
                let method = requestLine.count > 0 ? requestLine[0] : "GET"
                let fullPath = requestLine.count > 1 ? requestLine[1] : "/"

                var contentLength = 0
                for line in lines.dropFirst() {
                    let parts = line.split(separator: ":", maxSplits: 1)
                    if parts.count == 2, parts[0].lowercased() == "content-length" {
                        contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
                    }
                }

                let currentBodyCount = accumulated.count - bodyStart
                if currentBodyCount >= contentLength || isComplete {
                    let body = accumulated.subdata(in: bodyStart..<min(accumulated.count, bodyStart + contentLength))
                    completion(method, fullPath, body)
                    return
                }
            }

            if isComplete {
                completion("GET", "/", Data())
                return
            }
            self?.readRequest(connection: connection, buffer: accumulated, completion: completion)
        }
    }

    private func route(method: String, fullPath: String, body: Data, state: State) -> (Int, String) {
        let pathOnly = fullPath.components(separatedBy: "?").first ?? fullPath
        let origin = self.origin
        let futureMs = Int64(Date().timeIntervalSince1970 * 1000) + 120_000

        if pathOnly == "/api/auth/mobile/pair/options" {
            return (200, "{\"challengeId\":\"ch_e2e_1\",\"nonce\":\"nonce_e2e_1\",\"rpOrigin\":\"\(origin)\"}")
        }
        if pathOnly == "/api/auth/mobile/pair/verify" {
            return (200, "{\"token\":\"hmob_e2e_token\",\"deviceId\":\"dev_e2e_1\",\"user\":{\"id\":\"usr_e2e\",\"email\":\"e2e@harness.local\",\"name\":\"E2E Admin\",\"instanceAdmin\":true,\"createdAt\":1700000000000}}")
        }
        if pathOnly == "/api/auth/me" {
            return (200, "{\"user\":{\"id\":\"usr_e2e\",\"email\":\"e2e@harness.local\",\"name\":\"E2E Admin\",\"instanceAdmin\":true,\"createdAt\":1700000000000},\"session\":{\"id\":\"ses_e2e\",\"method\":\"mobile\",\"stepUpAt\":1700000000000,\"stepUpFresh\":false},\"orgs\":[{\"id\":\"org_e2e\",\"slug\":\"personal\",\"name\":\"Personal\",\"personal\":true,\"createdAt\":1700000000000,\"role\":\"owner\"}],\"devices\":[]}")
        }
        if pathOnly == "/api/auth/mobile/step-up/options" {
            return (200, "{\"challengeId\":\"ch_su_1\",\"nonce\":\"nonce_su_1\",\"expiresAt\":\(futureMs)}")
        }
        if pathOnly == "/api/auth/mobile/step-up/verify" {
            state.lock.lock()
            state.stepUpDone = true
            state.lock.unlock()
            return (200, "{\"ok\":true,\"stepUpAt\":1700000000000}")
        }
        if pathOnly == "/api/approvals" && method == "GET" {
            state.lock.lock()
            let status = state.approvalStatus
            state.lock.unlock()
            let item = "{\"id\":\"app_e2e_1\",\"runId\":\"run_e2e_1\",\"command\":\"git push origin main\",\"reason\":\"Deploy verified build\",\"status\":\"\(status)\",\"createdAt\":1700000000000,\"expiresAt\":\(futureMs)}"
            if fullPath.contains("status=pending") && status != "pending" {
                return (200, "[]")
            }
            return (200, "[\(item)]")
        }
        if pathOnly == "/api/approvals/app_e2e_1" && method == "POST" {
            state.lock.lock()
            let steppedUp = state.stepUpDone
            if steppedUp {
                state.approvalStatus = "approved"
            }
            state.lock.unlock()
            if !steppedUp {
                return (403, "{\"error\":\"step_up_required\"}")
            }
            return (200, "{\"id\":\"app_e2e_1\",\"runId\":\"run_e2e_1\",\"command\":\"git push origin main\",\"reason\":\"Deploy verified build\",\"status\":\"approved\",\"decidedBy\":\"usr_e2e\",\"createdAt\":1700000000000,\"expiresAt\":\(futureMs)}")
        }
        if pathOnly == "/api/orgs/personal" {
            return (200, "{\"org\":{\"id\":\"org_e2e\",\"slug\":\"personal\",\"name\":\"Personal\",\"personal\":true,\"createdAt\":1700000000000},\"projects\":[{\"id\":\"proj_1\",\"orgId\":\"org_e2e\",\"key\":\"HAR\",\"name\":\"Harness\",\"description\":\"Core\",\"createdAt\":1700000000000}],\"members\":[{\"id\":\"usr_e2e\",\"orgId\":\"org_e2e\",\"kind\":\"human\",\"handle\":\"e2e\",\"displayName\":\"E2E Admin\",\"role\":\"owner\",\"createdAt\":1700000000000}]}")
        }
        if pathOnly == "/api/projects/proj_1/tasks" {
            return (200, "[{\"id\":\"task_e2e_1\",\"projectId\":\"proj_1\",\"number\":101,\"title\":\"Verify E2E pipeline\",\"description\":\"Run hermetic tests\",\"status\":\"todo\",\"priority\":1,\"estimateMinutes\":30,\"createdAt\":1700000000000,\"updatedAt\":1700000000000}]")
        }
        if pathOnly == "/api/projects/proj_1/deps" {
            return (200, "[]")
        }
        if pathOnly == "/api/tasks/task_e2e_1" {
            return (200, "{\"task\":{\"id\":\"task_e2e_1\",\"projectId\":\"proj_1\",\"number\":101,\"title\":\"Verify E2E pipeline\",\"description\":\"Run hermetic tests\",\"status\":\"todo\",\"priority\":1,\"estimateMinutes\":30,\"createdAt\":1700000000000,\"updatedAt\":1700000000000},\"comments\":[],\"dependencies\":[],\"dependents\":[]}")
        }
        if pathOnly == "/api/runs" {
            return (200, "[{\"id\":\"run_e2e_1\",\"agentId\":\"coder\",\"model\":\"claude-sonnet\",\"repo\":\"/workspace/harness\",\"prompt\":\"Fix push deep links\",\"state\":\"running\",\"createdAt\":1700000000000,\"startedAt\":1700000000000,\"inputTokens\":120,\"outputTokens\":45}]")
        }
        if pathOnly == "/api/runs/run_e2e_1" {
            return (200, "{\"run\":{\"id\":\"run_e2e_1\",\"agentId\":\"coder\",\"model\":\"claude-sonnet\",\"repo\":\"/workspace/harness\",\"prompt\":\"Fix push deep links\",\"state\":\"running\",\"createdAt\":1700000000000,\"startedAt\":1700000000000,\"inputTokens\":120,\"outputTokens\":45},\"events\":[{\"rowid\":1,\"ts\":1700000001000,\"kind\":\"message\",\"body\":\"Running E2E transcript verification\"}]}")
        }
        if pathOnly == "/api/orgs/personal/channels" {
            return (200, "[{\"id\":\"chan_e2e_1\",\"orgId\":\"org_e2e\",\"kind\":\"org\",\"name\":\"general\",\"createdAt\":1700000000000,\"unread\":0}]")
        }
        if pathOnly == "/api/channels/chan_e2e_1/messages" && method == "GET" {
            state.lock.lock()
            let msgs = state.chatMessages.enumerated().map { idx, item in
                "{\"id\":\"\(item.id)\",\"channelId\":\"chan_e2e_1\",\"authorId\":\"usr_e2e\",\"body\":\"\(item.body)\",\"createdAt\":\(1700000000000 + idx),\"replyCount\":0,\"mentions\":[],\"taskIds\":[],\"tasks\":[]}"
            }
            state.lock.unlock()
            return (200, "[\(msgs.joined(separator: ","))]")
        }
        if pathOnly == "/api/channels/chan_e2e_1/messages" && method == "POST" {
            let parsed = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["body"] as? String ?? "Hello"
            let escaped = parsed.replacingOccurrences(of: "\"", with: "\\\"")
            let msgId = "msg_\(Int.random(in: 100...999))"
            state.lock.lock()
            state.chatMessages.append((id: msgId, body: escaped))
            state.lock.unlock()
            return (200, "{\"id\":\"\(msgId)\",\"channelId\":\"chan_e2e_1\",\"authorId\":\"usr_e2e\",\"body\":\"\(escaped)\",\"createdAt\":1700000005000,\"replyCount\":0,\"mentions\":[],\"taskIds\":[],\"tasks\":[]}")
        }
        if pathOnly == "/api/channels/chan_e2e_1/members" {
            return (200, "[{\"id\":\"usr_e2e\",\"orgId\":\"org_e2e\",\"kind\":\"human\",\"handle\":\"e2e\",\"displayName\":\"E2E Admin\",\"role\":\"owner\",\"createdAt\":1700000000000}]")
        }
        if pathOnly == "/api/orgs/personal/dashboard" {
            return (200, "{\"runsCount\":1,\"approvalsPending\":0,\"spendUsd\":1.25,\"budgets\":[],\"utilization\":[]}")
        }
        if pathOnly == "/api/orgs/personal/memory/facets" {
            return (200, "{\"types\":[\"note\"],\"tags\":[\"e2e\"],\"projects\":[]}")
        }
        if pathOnly == "/api/orgs/personal/memory/notes" {
            return (200, "[{\"id\":\"note_1\",\"rel\":\"notes/e2e.md\",\"title\":\"E2E Note\",\"type\":\"note\",\"tags\":[\"e2e\"],\"updatedAt\":1700000000000,\"hash\":\"h1\"}]")
        }
        if pathOnly == "/api/orgs/personal/memory/writes" || pathOnly == "/api/orgs/personal/memory/lessons" {
            return (200, "[]")
        }
        return (200, "{}")
    }
}
