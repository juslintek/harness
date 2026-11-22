import SwiftUI

public struct DashboardSectionView: View {
    @Bindable var store: DashboardStore

    public init(store: DashboardStore) {
        self.store = store
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Range selector
            Picker("Range", selection: $store.selectedRange) {
                ForEach(DashboardRange.allCases) { range in
                    Text(range.label).tag(range)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: store.selectedRange) { _, newRange in
                Task {
                    await store.load(range: newRange)
                }
            }

            if store.isLoading && store.data == nil {
                ProgressView("Loading dashboard...")
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 24)
            } else if let error = store.errorMessage {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(StudioNorthTheme.danger)
            } else if let data = store.data {
                // Budgets Section
                if !data.budgets.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Budgets")
                            .font(.headline)
                            .foregroundStyle(StudioNorthTheme.ink)

                        ForEach(data.budgets) { budget in
                            budgetRow(budget)
                        }
                    }
                }

                // Quota Windows Section
                if !data.quota.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Quota Windows")
                            .font(.headline)
                            .foregroundStyle(StudioNorthTheme.ink)

                        ForEach(Array(data.quota.enumerated()), id: \.offset) { _, q in
                            quotaRow(q)
                        }
                    }
                }

                // Member Reports Section
                if !data.members.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Member Reports")
                            .font(.headline)
                            .foregroundStyle(StudioNorthTheme.ink)

                        ForEach(data.members) { member in
                            memberCard(member)
                        }
                    }
                }

                // Active Tasks Section
                if !data.tasks.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Active Tasks")
                            .font(.headline)
                            .foregroundStyle(StudioNorthTheme.ink)

                        ForEach(Array(data.tasks.enumerated()), id: \.offset) { _, task in
                            taskRow(task)
                        }
                    }
                }
            } else {
                Text("No dashboard metrics available.")
                    .font(.subheadline)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            }
        }
        .task {
            if store.data == nil {
                await store.load()
            }
            store.subscribeToRealtime()
        }
        .onDisappear {
            store.stopRealtime()
        }
    }

    @ViewBuilder
    private func budgetRow(_ b: DashboardBudgetItem) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(b.scopeId ?? (b.scopeKind ?? "Budget"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(StudioNorthTheme.ink)
                    Spacer()
                    if b.isNearCap {
                        StatusBadge(text: b.state ?? "near cap", color: StudioNorthTheme.danger)
                    } else {
                        StatusBadge(text: b.state ?? "ok", color: StudioNorthTheme.link)
                    }
                }

                // Progress bar
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(StudioNorthTheme.border.opacity(0.3))
                            .frame(height: 8)
                        Capsule()
                            .fill(b.isNearCap ? StudioNorthTheme.danger : StudioNorthTheme.ink)
                            .frame(width: max(0, min(geo.size.width, geo.size.width * CGFloat(b.displayRatio))), height: 8)
                    }
                }
                .frame(height: 8)

                HStack {
                    Text(String(format: "$%.2f of $%.2f", b.displaySpent, b.displayMonthly))
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                    Spacer()
                    Text(String(format: "%.0f%%", b.displayRatio * 100))
                        .font(.caption.monospaced())
                        .foregroundStyle(StudioNorthTheme.ink)
                }
            }
        }
    }

    @ViewBuilder
    private func quotaRow(_ q: DashboardQuota) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(q.provider.capitalized)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(StudioNorthTheme.ink)
                    Spacer()
                    StatusBadge(text: q.window, color: StudioNorthTheme.accent)
                }

                HStack {
                    Text(q.usedPercent.map { String(format: "%.1f%% used", $0) } ?? "N/A")
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                    Spacer()
                    if let resetsAt = q.resetsAt {
                        let date = Date(timeIntervalSince1970: Double(resetsAt) / 1000)
                        Text("Resets: \(date.formatted(date: .omitted, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func memberCard(_ m: DashboardMember) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("@\(m.handle)")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(StudioNorthTheme.ink)
                    Spacer()
                    Text(String(format: "$%.2f", m.costUsd))
                        .font(.subheadline.monospaced())
                        .foregroundStyle(StudioNorthTheme.ink)
                }

                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Runs")
                            .font(.caption2)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                        Text("\(m.completed)/\(m.runs)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudioNorthTheme.ink)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Tokens (In / Out)")
                            .font(.caption2)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                        Text("\(m.inputTokens) / \(m.outputTokens)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudioNorthTheme.ink)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Active Time")
                            .font(.caption2)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                        Text("\(m.activeMs / 60_000)m")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(StudioNorthTheme.ink)
                    }
                }

                if !m.tools.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(m.tools, id: \.name) { tool in
                                StatusBadge(text: "\(tool.name): \(tool.count)", color: StudioNorthTheme.inkMuted)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func taskRow(_ t: DashboardTask) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("#\(t.number) \(t.title)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(StudioNorthTheme.ink)
                        .lineLimit(1)
                    Spacer()
                    StatusBadge(text: t.status, color: StudioNorthTheme.accent)
                }

                HStack {
                    Text("Assignee: \(t.assignee.map { "@\($0)" } ?? "unassigned")")
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                    Spacer()
                    Text("Agent active: \(t.agentActiveMinutes ?? 0)m")
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }
            }
        }
    }
}
