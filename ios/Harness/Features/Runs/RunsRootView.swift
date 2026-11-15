import SwiftUI

public struct RunsRootView: View {
    public let store: AppSessionStore
    @State private var runsStore: RunsStore

    public init(store: AppSessionStore) {
        self.store = store
        self._runsStore = State(initialValue: RunsStore(sessionStore: store))
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let banner = runsStore.bannerMessage {
                    bannerView(message: banner, isError: runsStore.bannerIsError)
                }

                if !runsStore.isInstanceAdmin {
                    wakeupsView
                } else {
                    runsView
                }
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("Runs")
            .sheet(isPresented: $runsStore.isStartRunSheetPresented) {
                StartRunSheet(
                    store: runsStore,
                    onDismiss: {
                        runsStore.isStartRunSheetPresented = false
                    },
                    onRunStarted: { newRunId in
                        runsStore.selectedRunId = newRunId
                    }
                )
            }
            .navigationDestination(item: $runsStore.selectedRunId) { runId in
                RunDetailView(runId: runId, sessionStore: store)
            }
            .task(id: "\(store.activeInstanceId ?? "none"):\(store.activeInstance?.selectedOrgSlug ?? "none")") {
                await runsStore.refresh()
                runsStore.startRealtime()
            }
            .task(id: store.pendingDeepLink) {
                if let url = store.pendingDeepLink,
                   let parsed = DeepLinkRouter.parse(url),
                   case .run(let runId?) = parsed.target {
                    runsStore.selectedRunId = runId
                    store.pendingDeepLink = nil
                }
            }
            .onDisappear {
                runsStore.stopRealtime()
            }
        }
    }

    private var runsView: some View {
        VStack(spacing: 12) {
            runsControlBar

            ScrollView {
                LazyVStack(spacing: 12) {
                    if runsStore.filteredRuns.isEmpty {
                        emptyRunsState
                    } else {
                        ForEach(runsStore.filteredRuns) { run in
                            Button {
                                runsStore.selectedRunId = run.id
                            } label: {
                                runCard(run)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("runs.card.\(run.id)")
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .refreshable {
                await runsStore.fetchRuns()
            }
        }
    }

    private var runsControlBar: some View {
        HStack(spacing: 8) {
            ForEach(RunFilter.allCases) { filter in
                Button {
                    runsStore.selectedFilter = filter
                } label: {
                    Text(filter.rawValue)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(runsStore.selectedFilter == filter ? StudioNorthTheme.onBrand : StudioNorthTheme.ink)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(runsStore.selectedFilter == filter ? StudioNorthTheme.brand : StudioNorthTheme.surfaceRaised)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule().stroke(StudioNorthTheme.border, lineWidth: runsStore.selectedFilter == filter ? 0 : 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("runs.filter.\(filter.rawValue.lowercased())")
            }

            Spacer()

            ActionPill(title: "Start Run ↗", icon: nil) {
                runsStore.isStartRunSheetPresented = true
            }
            .accessibilityIdentifier("runs.startRun")
            .accessibilityLabel("Start new run")
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    private func runCard(_ run: Run) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    StatusBadge(text: run.state, color: stateColor(for: run.state))

                    Text(run.agentId)
                        .font(.headline)
                        .foregroundStyle(StudioNorthTheme.ink)

                    if let model = run.model {
                        Text(model)
                            .font(.caption.monospaced())
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }

                    Spacer()

                    Text(formatDuration(run))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }

                HStack(spacing: 10) {
                    let repoName = URL(fileURLWithPath: run.repo).lastPathComponent
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                            .font(.caption2)
                        Text(repoName.isEmpty ? run.repo : repoName)
                            .font(.caption.weight(.medium))
                    }

                    if let branch = run.branch {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.triangle.branch")
                                .font(.caption2)
                            Text(branch)
                                .font(.caption.monospaced())
                        }
                    }

                    Spacer()

                    Text("\(run.inputTokens) in / \(run.outputTokens) out")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }
                .foregroundStyle(StudioNorthTheme.inkMuted)

                if !run.prompt.isEmpty {
                    Text(run.prompt)
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.ink)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var wakeupsView: some View {
        VStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "info.circle")
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                Text("Instance run transcripts require Instance Admin. Showing Org Wakeups.")
                    .font(.caption)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                Spacer()
            }
            .padding(.horizontal)
            .padding(.top, 8)

            ScrollView {
                LazyVStack(spacing: 12) {
                    if runsStore.wakeups.isEmpty {
                        emptyWakeupsState
                    } else {
                        ForEach(runsStore.wakeups) { wake in
                            wakeupCard(wake)
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .refreshable {
                await runsStore.fetchWakeups()
            }
        }
    }

    private func wakeupCard(_ wake: WakeupView) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    StatusBadge(text: wake.status, color: wakeupStatusColor(wake.status))
                    StatusBadge(text: wake.reason, color: StudioNorthTheme.inkMuted)
                    Spacer()
                    if let taskNum = wake.taskNumber {
                        Text("Task #\(taskNum)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                }

                HStack {
                    Text("Member: \(wake.memberId)")
                        .font(.caption.monospaced())
                        .foregroundStyle(StudioNorthTheme.ink)
                    Spacer()
                    if let by = wake.causedBy {
                        Text("By: \(by)")
                            .font(.caption2)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func bannerView(message: String, isError: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(isError ? StudioNorthTheme.danger : StudioNorthTheme.link)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(StudioNorthTheme.ink)
            Spacer()
            Button {
                runsStore.bannerMessage = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            }
        }
        .padding(10)
        .background((isError ? StudioNorthTheme.danger : StudioNorthTheme.link).opacity(0.1))
        .padding(.horizontal)
    }

    private var emptyRunsState: some View {
        RaisedCard {
            VStack(spacing: 8) {
                Text(runsStore.selectedFilter == .active ? "No Active Runs" : "No Runs Found")
                    .font(.headline)
                    .foregroundStyle(StudioNorthTheme.ink)

                Text("Start an agent execution or wait for incoming autonomous task runs.")
                    .font(.subheadline)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
        .padding(.top, 16)
    }

    private var emptyWakeupsState: some View {
        RaisedCard {
            VStack(spacing: 8) {
                Text("No Wakeups Recorded")
                    .font(.headline)
                    .foregroundStyle(StudioNorthTheme.ink)

                Text("Heartbeat wakes scheduled for organization members will be displayed here.")
                    .font(.subheadline)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
        .padding(.top, 16)
    }

    private func stateColor(for state: String) -> Color {
        switch state {
        case "running", "started": return StudioNorthTheme.link
        case "failed", "killed": return StudioNorthTheme.danger
        default: return StudioNorthTheme.inkMuted
        }
    }

    private func wakeupStatusColor(_ status: String) -> Color {
        switch status {
        case "done": return StudioNorthTheme.link
        case "started": return StudioNorthTheme.accent
        case "failed": return StudioNorthTheme.danger
        default: return StudioNorthTheme.inkMuted
        }
    }

    private func formatDuration(_ run: Run) -> String {
        guard let start = run.startedAt else { return "queued" }
        let end = run.endedAt ?? Int64(Date().timeIntervalSince1970 * 1000)
        let sec = max(0, Int((end - start) / 1000))
        return "\(sec)s"
    }
}
