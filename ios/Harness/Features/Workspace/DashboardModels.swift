import Foundation

public enum DashboardRange: String, CaseIterable, Identifiable, Sendable {
    case twentyFourHours = "24h"
    case sevenDays = "7d"
    case thirtyDays = "30d"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .twentyFourHours: return "24h"
        case .sevenDays: return "7d"
        case .thirtyDays: return "30d"
        }
    }

    public func sinceEpochMs(from reference: Date = Date()) -> Int64 {
        let nowMs = Int64(reference.timeIntervalSince1970 * 1000)
        let dayMs: Int64 = 86_400_000
        switch self {
        case .twentyFourHours:
            return nowMs - dayMs
        case .sevenDays:
            return nowMs - (7 * dayMs)
        case .thirtyDays:
            return nowMs - (30 * dayMs)
        }
    }
}

public struct DashboardBudgetItem: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let scopeKind: String?
    public let scopeId: String?
    public let monthlyUsd: Double?
    public let spentUsd: Double?
    public let ratio: Double?
    public let state: String?
    public let unpriced: Int?
    public let amountUsd: Double?

    public init(
        id: String,
        scopeKind: String? = nil,
        scopeId: String? = nil,
        monthlyUsd: Double? = nil,
        spentUsd: Double? = nil,
        ratio: Double? = nil,
        state: String? = nil,
        unpriced: Int? = nil,
        amountUsd: Double? = nil
    ) {
        self.id = id
        self.scopeKind = scopeKind
        self.scopeId = scopeId
        self.monthlyUsd = monthlyUsd
        self.spentUsd = spentUsd
        self.ratio = ratio
        self.state = state
        self.unpriced = unpriced
        self.amountUsd = amountUsd
    }

    public var isNearCap: Bool {
        if let ratio, ratio >= 0.8 { return true }
        if let state, state == "warn" || state == "paused" { return true }
        return false
    }

    public var displayMonthly: Double {
        monthlyUsd ?? amountUsd ?? 0.0
    }

    public var displaySpent: Double {
        spentUsd ?? 0.0
    }

    public var displayRatio: Double {
        if let ratio { return ratio }
        let monthly = displayMonthly
        guard monthly > 0 else { return 0 }
        return min(1.0, displaySpent / monthly)
    }
}

public struct WorkspaceDashboardData: Codable, Sendable, Equatable {
    public let members: [DashboardMember]
    public let budgets: [DashboardBudgetItem]
    public let quota: [DashboardQuota]
    public let tasks: [DashboardTask]

    public init(
        members: [DashboardMember] = [],
        budgets: [DashboardBudgetItem] = [],
        quota: [DashboardQuota] = [],
        tasks: [DashboardTask] = []
    ) {
        self.members = members
        self.budgets = budgets
        self.quota = quota
        self.tasks = tasks
    }
}
