import Foundation
import Observation

public enum ApprovalFilter: String, CaseIterable, Identifiable, Sendable {
    case pending = "Pending"
    case resolved = "Resolved"

    public var id: String { rawValue }
}

@Observable
@MainActor
public final class ApprovalsStore {
    public let sessionStore: AppSessionStore
    public let apiClientOverride: HarnessAPIClient?

    public var pendingApprovals: [Approval] = []
    public var resolvedApprovals: [Approval] = []
    public var focusedApproval: Approval?
    public var focusedApprovalId: String?
    public var selectedFilter: ApprovalFilter = .pending
    public var isLoading: Bool = false
    public var errorMessage: String?
    public var bannerMessage: String?
    public var bannerIsError: Bool = false
    public var decidingIds: Set<String> = []

    private var wsTask: Task<Void, Never>?
    private var wsClient: HarnessWSClient?

    public var canManageApprovals: Bool {
        if sessionStore.isInstanceAdmin { return true }
        let role = sessionStore.currentOrgRole
        return role == "owner" || role == "admin"
    }

    public var currentClient: HarnessAPIClient? {
        apiClientOverride ?? sessionStore.currentAPIClient()
    }

    public init(sessionStore: AppSessionStore, apiClientOverride: HarnessAPIClient? = nil) {
        self.sessionStore = sessionStore
        self.apiClientOverride = apiClientOverride
    }

    public func refresh() async {
        if selectedFilter == .pending {
            await fetchPending()
        } else {
            await fetchResolved()
        }
    }

    public func fetchPending() async {
        guard canManageApprovals else {
            pendingApprovals = []
            return
        }
        guard let client = currentClient else { return }
        isLoading = true
        errorMessage = nil
        do {
            let req = try client.buildRequest(path: "/api/approvals?status=pending")
            let list: [Approval] = try await client.send(req)
            self.pendingApprovals = list
        } catch {
            self.errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    public func fetchResolved() async {
        guard canManageApprovals else {
            resolvedApprovals = []
            return
        }
        guard let client = currentClient else { return }
        isLoading = true
        errorMessage = nil
        do {
            let req = try client.buildRequest(path: "/api/approvals")
            let all: [Approval] = try await client.send(req)
            self.resolvedApprovals = all.filter { $0.status != "pending" }
        } catch {
            self.errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    public func fetchApproval(id: String) async throws -> Approval {
        guard let client = currentClient else { throw HarnessAPIError.unauthorized }
        let req = try client.buildRequest(path: "/api/approvals/\(id)")
        return try await client.send(req)
    }

    public func handleDeepLink(url: URL) async {
        guard let parsed = DeepLinkRouter.parse(url),
              case .approval(let id?) = parsed.target else { return }
        self.focusedApprovalId = id
        if let pending = sessionStore.pendingGuardDecision, pending.approvalId == id {
            sessionStore.pendingGuardDecision = nil
            await decide(id: id, decision: pending.decision)
            return
        }
        do {
            let app = try await fetchApproval(id: id)
            self.focusedApproval = app
        } catch {
            self.bannerMessage = "Could not load approval \(id): \(error.localizedDescription)"
            self.bannerIsError = true
        }
    }

    public func decide(id: String, decision: String) async {
        guard !decidingIds.contains(id) else { return }
        guard let client = currentClient else { return }
        decidingIds.insert(id)
        bannerMessage = nil
        bannerIsError = false

        do {
            let body = try JSONEncoder().encode(DecisionRequest(decision: decision))
            let req = try client.buildRequest(path: "/api/approvals/\(id)", method: "POST", body: body)
            let updated: Approval = try await client.send(req)

            pendingApprovals.removeAll { $0.id == id }
            resolvedApprovals.removeAll { $0.id == id }
            resolvedApprovals.insert(updated, at: 0)
            if focusedApproval?.id == id {
                focusedApproval = updated
            }
            bannerMessage = "Approval marked \(updated.status)."
            bannerIsError = false
        } catch let apiErr as HarnessAPIError {
            switch apiErr {
            case .httpError(let code, _):
                if code == 409 {
                    bannerMessage = "Approval is no longer pending."
                    bannerIsError = true
                    pendingApprovals.removeAll { $0.id == id }
                } else if code == 403 {
                    bannerMessage = "Instance administrator privilege required to decide this approval."
                    bannerIsError = true
                } else {
                    bannerMessage = apiErr.localizedDescription
                    bannerIsError = true
                }
            default:
                bannerMessage = apiErr.localizedDescription
                bannerIsError = true
            }
        } catch {
            bannerMessage = error.localizedDescription
            bannerIsError = true
        }
        decidingIds.remove(id)
    }

    public func startRealtime() {
        guard sessionStore.isInstanceAdmin, let active = sessionStore.activeInstance else { return }
        stopRealtime()
        let ws = HarnessWSClient(
            origin: active.origin,
            topic: "approvals",
            tokenProvider: { [weak self] in
                self?.sessionStore.keychain.getToken(for: active.id)
            }
        )
        self.wsClient = ws
        let stream = ws.connect()
        wsTask = Task { [weak self] in
            for await msg in stream {
                guard let self else { break }
                if case .approval(let app) = msg {
                    self.handleRealtimeApproval(app)
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

    public func handleRealtimeApproval(_ approval: Approval) {
        if approval.status == "pending" {
            if let idx = pendingApprovals.firstIndex(where: { $0.id == approval.id }) {
                pendingApprovals[idx] = approval
            } else {
                pendingApprovals.insert(approval, at: 0)
            }
            resolvedApprovals.removeAll { $0.id == approval.id }
        } else {
            pendingApprovals.removeAll { $0.id == approval.id }
            if let idx = resolvedApprovals.firstIndex(where: { $0.id == approval.id }) {
                resolvedApprovals[idx] = approval
            } else {
                resolvedApprovals.insert(approval, at: 0)
            }
        }
    }

    public static func remainingSeconds(expiresAt: Int64, now: Date = .now) -> Int {
        let sec = Int64(expiresAt / 1000) - Int64(now.timeIntervalSince1970)
        return max(0, Int(sec))
    }

    public static func isExpired(expiresAt: Int64, now: Date = .now) -> Bool {
        remainingSeconds(expiresAt: expiresAt, now: now) <= 0
    }

    public static func isDanger(expiresAt: Int64, now: Date = .now) -> Bool {
        let sec = remainingSeconds(expiresAt: expiresAt, now: now)
        return sec > 0 && sec < 30
    }
}
