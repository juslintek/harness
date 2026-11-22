import Foundation
import Observation

@Observable
@MainActor
public final class RunsStore {
    public let sessionStore: AppSessionStore
    public let apiClientOverride: HarnessAPIClient?

    public var runs: [Run] = []
    public var wakeups: [WakeupView] = []
    public var selectedFilter: RunFilter = .active
    public var selectedRunId: String?
    public var isStartRunSheetPresented: Bool = false
    public var isWakeSheetPresented: Bool = false
    public var isLoading: Bool = false
    public var bannerMessage: String?
    public var bannerIsError: Bool = false

    private var wsTask: Task<Void, Never>?
    private var wsClient: HarnessWSClient?

    public var isInstanceAdmin: Bool {
        sessionStore.isInstanceAdmin
    }

    public var isOrgAdmin: Bool {
        let role = sessionStore.currentOrgRole
        return role == "admin" || role == "owner"
    }

    public var currentClient: HarnessAPIClient? {
        apiClientOverride ?? sessionStore.currentAPIClient()
    }

    public var filteredRuns: [Run] {
        if selectedFilter == .active {
            return runs.filter { run in
                run.state == "running" || run.state == "started" || run.state == "queued" || run.endedAt == nil
            }
        }
        return runs
    }

    public init(sessionStore: AppSessionStore, apiClientOverride: HarnessAPIClient? = nil) {
        self.sessionStore = sessionStore
        self.apiClientOverride = apiClientOverride
    }

    public func refresh() async {
        if isInstanceAdmin {
            await fetchRuns()
        } else {
            await fetchWakeups()
        }
    }

    public func fetchRuns(clearBanner: Bool = true) async {
        guard isInstanceAdmin, let client = currentClient else { return }
        isLoading = true
        if clearBanner {
            bannerMessage = nil
            bannerIsError = false
        }
        do {
            let req = try client.buildRequest(path: "/api/runs")
            let list: [Run] = try await client.send(req)
            self.runs = list
        } catch {
            self.bannerMessage = "Failed to load runs: \(error.localizedDescription)"
            self.bannerIsError = true
        }
        isLoading = false
    }

    public func fetchWakeups(clearBanner: Bool = true) async {
        guard let client = currentClient else { return }
        let slug = sessionStore.activeInstance?.selectedOrgSlug ?? "personal"
        isLoading = true
        if clearBanner {
            bannerMessage = nil
            bannerIsError = false
        }
        do {
            let req = try client.buildRequest(path: "/api/orgs/\(slug)/wakeups?limit=50")
            let list: [WakeupView] = try await client.send(req)
            self.wakeups = list
        } catch {
            self.bannerMessage = "Failed to load wakeups: \(error.localizedDescription)"
            self.bannerIsError = true
        }
        isLoading = false
    }

    public func startRun(
        agentId: String,
        repo: String,
        prompt: String,
        model: String? = nil
    ) async throws -> String {
        guard let client = currentClient else { throw HarnessAPIError.unauthorized }
        bannerMessage = nil
        bannerIsError = false

        let reqBody = StartRunRequest(
            agentId: agentId,
            repo: repo,
            prompt: prompt,
            model: model?.isEmpty == true ? nil : model
        )
        let bodyData = try JSONEncoder().encode(reqBody)
        let req = try client.buildRequest(path: "/api/runs", method: "POST", body: bodyData)

        do {
            let res: StartRunResponse = try await client.send(req)
            await fetchRuns(clearBanner: false)
            bannerMessage = "Run started: \(res.id)"
            bannerIsError = false
            return res.id
        } catch let apiErr as HarnessAPIError {
            switch apiErr {
            case .httpError(let code, let msg):
                if code == 409 {
                    bannerMessage = "Instance is halted: run execution refused."
                    bannerIsError = true
                } else {
                    bannerMessage = "Start run failed (\(code)): \(msg)"
                    bannerIsError = true
                }
            default:
                bannerMessage = apiErr.localizedDescription
                bannerIsError = true
            }
            throw apiErr
        }
    }

    public func killRun(id: String) async {
        guard let client = currentClient else { return }
        bannerMessage = nil
        bannerIsError = false
        do {
            let req = try client.buildRequest(path: "/api/runs/\(id)/kill", method: "POST")
            let res: ActionOkResponse = try await client.send(req)
            if res.ok {
                await fetchRuns(clearBanner: false)
                bannerMessage = "Run kill signal sent."
                bannerIsError = false
            }
        } catch {
            bannerMessage = "Failed to kill run: \(error.localizedDescription)"
            bannerIsError = true
        }
    }

    public func wakeMember(memberId: String, taskId: String? = nil) async {
        guard let client = currentClient else { return }
        bannerMessage = nil
        bannerIsError = false
        do {
            let reqBody = WakeMemberRequest(taskId: taskId?.isEmpty == true ? nil : taskId)
            let bodyData = try JSONEncoder().encode(reqBody)
            let req = try client.buildRequest(path: "/api/members/\(memberId)/wake", method: "POST", body: bodyData)
            let res: WakeMemberResponse = try await client.send(req)
            await fetchWakeups(clearBanner: false)
            bannerMessage = "Agent wake scheduled (\(res.id))."
            bannerIsError = false
        } catch {
            bannerMessage = "Failed to wake agent: \(error.localizedDescription)"
            bannerIsError = true
        }
    }

    public func startRealtime() {
        guard isInstanceAdmin, let active = sessionStore.activeInstance else { return }
        stopRealtime()
        let ws = HarnessWSClient(
            origin: active.origin,
            topic: "runs",
            tokenProvider: { [weak self] in
                self?.sessionStore.keychain.getToken(for: active.id)
            }
        )
        self.wsClient = ws
        let stream = ws.connect()
        wsTask = Task { [weak self] in
            for await msg in stream {
                guard let self else { break }
                if case .run(let updatedRun) = msg {
                    self.handleRealtimeRun(updatedRun)
                }
            }
        }
    }

    public func stopRealtime() {
        wsTask?.cancel()
        wsTask = nil
        Task { [wsClient] in
            await wsClient?.disconnect()
        }
        wsClient = nil
    }

    public func handleRealtimeRun(_ updatedRun: Run) {
        if let idx = runs.firstIndex(where: { $0.id == updatedRun.id }) {
            runs[idx] = updatedRun
        } else {
            runs.insert(updatedRun, at: 0)
        }
    }
}
