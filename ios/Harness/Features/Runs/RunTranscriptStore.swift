import Foundation
import Observation

@Observable
@MainActor
public final class RunTranscriptStore {
    public let runId: String
    public let sessionStore: AppSessionStore
    public let apiClientOverride: HarnessAPIClient?

    public var run: Run?
    public var events: [RunEvent] = []
    public var lastRowid: Int = 0
    public var inlineApprovals: [Approval] = []
    public var autoScrollEnabled: Bool = true
    public var isLoading: Bool = false
    public var isKilling: Bool = false
    public var bannerMessage: String?
    public var bannerIsError: Bool = false

    private var wsTask: Task<Void, Never>?
    private var wsClient: HarnessWSClient?

    public var currentClient: HarnessAPIClient? {
        apiClientOverride ?? sessionStore.currentAPIClient()
    }

    public init(
        runId: String,
        sessionStore: AppSessionStore,
        apiClientOverride: HarnessAPIClient? = nil
    ) {
        self.runId = runId
        self.sessionStore = sessionStore
        self.apiClientOverride = apiClientOverride
    }

    public func loadInitial() async {
        guard let client = currentClient else { return }
        isLoading = true
        bannerMessage = nil
        bannerIsError = false
        do {
            let req = try client.buildRequest(path: "/api/runs/\(runId)?after=0")
            let detail: RunDetail = try await client.send(req)
            self.run = detail.run
            self.events = detail.events
            self.lastRowid = detail.events.last?.rowid ?? 0
            await fetchInlineApprovals()
        } catch {
            self.bannerMessage = "Failed to load run: \(error.localizedDescription)"
            self.bannerIsError = true
        }
        isLoading = false
    }

    public func pollIncremental() async {
        guard let client = currentClient else { return }
        do {
            let req = try client.buildRequest(path: "/api/runs/\(runId)?after=\(lastRowid)")
            let detail: RunDetail = try await client.send(req)
            self.run = detail.run

            let existingRowids = Set(events.map(\.rowid))
            let freshEvents = detail.events.filter { !existingRowids.contains($0.rowid) }
            if !freshEvents.isEmpty {
                events.append(contentsOf: freshEvents)
                if let maxRow = events.map(\.rowid).max() {
                    lastRowid = max(lastRowid, maxRow)
                }
            }
        } catch {
            // Non-critical background polling failure
        }
    }

    public func fetchInlineApprovals() async {
        guard let client = currentClient else { return }
        do {
            let req = try client.buildRequest(path: "/api/approvals?status=pending")
            let list: [Approval] = try await client.send(req)
            self.inlineApprovals = list.filter { $0.runId == self.runId }
        } catch {
            // Non-fatal for transcript
        }
    }

    public func decideApproval(id: String, decision: String) async {
        guard let client = currentClient else { return }
        bannerMessage = nil
        bannerIsError = false
        do {
            let body = try JSONEncoder().encode(DecisionRequest(decision: decision))
            let req = try client.buildRequest(path: "/api/approvals/\(id)", method: "POST", body: body)
            let updated: Approval = try await client.send(req)
            inlineApprovals.removeAll { $0.id == id }
            bannerMessage = "Guard approval marked \(updated.status)."
            bannerIsError = false
        } catch {
            bannerMessage = "Approval decision failed: \(error.localizedDescription)"
            bannerIsError = true
        }
    }

    public func killRun() async {
        guard let client = currentClient else { return }
        isKilling = true
        bannerMessage = nil
        bannerIsError = false
        do {
            let req = try client.buildRequest(path: "/api/runs/\(runId)/kill", method: "POST")
            let res: ActionOkResponse = try await client.send(req)
            if res.ok {
                bannerMessage = "Run kill signal sent."
                bannerIsError = false
                await pollIncremental()
            }
        } catch {
            bannerMessage = "Failed to kill run: \(error.localizedDescription)"
            bannerIsError = true
        }
        isKilling = false
    }

    public func startRealtime() {
        guard sessionStore.isInstanceAdmin, let active = sessionStore.activeInstance else { return }
        stopRealtime()
        let ws = HarnessWSClient(
            origin: active.origin,
            topic: "run:\(runId)",
            tokenProvider: { [weak self] in
                self?.sessionStore.keychain.getToken(for: active.id)
            }
        )
        self.wsClient = ws
        let stream = ws.connect()
        wsTask = Task { [weak self] in
            for await msg in stream {
                guard let self else { break }
                switch msg {
                case .event(let rId, _):
                    if rId == self.runId {
                        await self.pollIncremental()
                    }
                case .run(let updatedRun):
                    if updatedRun.id == self.runId {
                        self.run = updatedRun
                        await self.pollIncremental()
                    }
                case .approval(let app):
                    if app.runId == self.runId {
                        await self.fetchInlineApprovals()
                    }
                default:
                    break
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
}
