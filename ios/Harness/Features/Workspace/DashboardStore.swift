import Foundation
import Observation

@Observable
@MainActor
public final class DashboardStore {
    public var selectedRange: DashboardRange = .thirtyDays
    public var data: WorkspaceDashboardData?
    public var isLoading: Bool = false
    public var errorMessage: String?

    public let apiClient: HarnessAPIClient?
    public let orgSlug: String
    public let orgId: String?

    public var wsClient: HarnessWSClient?
    private var wsTask: Task<Void, Never>?

    public init(
        apiClient: HarnessAPIClient? = nil,
        orgSlug: String,
        orgId: String? = nil
    ) {
        self.apiClient = apiClient
        self.orgSlug = orgSlug
        self.orgId = orgId
    }

    public func load(range: DashboardRange? = nil, referenceDate: Date = Date()) async {
        guard let apiClient else { return }
        if let range {
            selectedRange = range
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        let sinceMs = selectedRange.sinceEpochMs(from: referenceDate)
        do {
            let req = try apiClient.buildRequest(path: "/api/orgs/\(orgSlug)/dashboard?since=\(sinceMs)")
            let res: WorkspaceDashboardData = try await apiClient.send(req)
            self.data = res
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    public func subscribeToRealtime() {
        guard let apiClient, let orgId, !orgId.isEmpty else { return }
        wsTask?.cancel()
        let ws = HarnessWSClient(
            origin: apiClient.origin,
            topic: "org:\(orgId)",
            tokenProvider: apiClient.tokenProvider
        )
        self.wsClient = ws
        wsTask = Task { [weak self] in
            let stream = ws.connect()
            for await message in stream {
                guard let self else { break }
                if case .dashboard = message {
                    await self.load()
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
    }
}
