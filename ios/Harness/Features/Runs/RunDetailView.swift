import SwiftUI

public struct RunDetailView: View {
    public let runId: String
    public let sessionStore: AppSessionStore
    @State private var transcriptStore: RunTranscriptStore

    public init(
        runId: String,
        sessionStore: AppSessionStore,
        apiClientOverride: HarnessAPIClient? = nil
    ) {
        self.runId = runId
        self.sessionStore = sessionStore
        self._transcriptStore = State(
            initialValue: RunTranscriptStore(
                runId: runId,
                sessionStore: sessionStore,
                apiClientOverride: apiClientOverride
            )
        )
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let banner = transcriptStore.bannerMessage {
                bannerView(message: banner, isError: transcriptStore.bannerIsError)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let run = transcriptStore.run {
                            runHeader(run)
                        }

                        if !transcriptStore.inlineApprovals.isEmpty {
                            inlineApprovalsSection
                        }

                        eventsList
                            .id("events_list_bottom")
                    }
                    .padding()
                }
                .onChange(of: transcriptStore.events.count) { _, _ in
                    if transcriptStore.autoScrollEnabled {
                        withAnimation {
                            proxy.scrollTo("events_list_bottom", anchor: .bottom)
                        }
                    }
                }
            }

            stickyBottomBar
        }
        .background(StudioNorthTheme.surface)
        .navigationTitle("Run Transcript")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await transcriptStore.loadInitial()
            transcriptStore.startRealtime()
        }
        .onDisappear {
            transcriptStore.stopRealtime()
        }
    }

    private func runHeader(_ run: Run) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    StatusBadge(text: run.state, color: stateColor(for: run.state))
                    Spacer()
                    Text(formatDuration(run))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }

                HStack(spacing: 8) {
                    Text(run.agentId)
                        .font(.headline)
                        .foregroundStyle(StudioNorthTheme.ink)

                    if let model = run.model {
                        Text(model)
                            .font(.caption.monospaced())
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                }

                HStack(spacing: 12) {
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

                    HStack(spacing: 6) {
                        Text("\(run.inputTokens) in / \(run.outputTokens) out")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                }
                .foregroundStyle(StudioNorthTheme.inkMuted)

                if !run.prompt.isEmpty {
                    HairlineDivider()
                    Text(run.prompt)
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.ink)
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var inlineApprovalsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "shield.lefthalf.filled")
                    .foregroundStyle(StudioNorthTheme.accent)
                Text("Action Requires Approval")
                    .font(.caption.bold())
                    .foregroundStyle(StudioNorthTheme.ink)
            }

            ForEach(transcriptStore.inlineApprovals) { approval in
                RaisedCard {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(approval.command)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(StudioNorthTheme.ink)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(StudioNorthTheme.surface)
                            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))

                        if let reason = approval.reason, !reason.isEmpty {
                            Text(reason)
                                .font(.caption)
                                .foregroundStyle(StudioNorthTheme.inkMuted)
                        }

                        HStack(spacing: 8) {
                            ActionPill(title: "Approve ↗", icon: nil) {
                                Task { await transcriptStore.decideApproval(id: approval.id, decision: "approve") }
                            }

                            Button {
                                Task { await transcriptStore.decideApproval(id: approval.id, decision: "deny") }
                            } label: {
                                Text("Deny")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(StudioNorthTheme.danger)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .overlay(Capsule().stroke(StudioNorthTheme.danger, lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var eventsList: some View {
        LazyVStack(spacing: 10) {
            ForEach(transcriptStore.events) { event in
                eventCard(event)
            }
        }
    }

    @ViewBuilder
    private func eventCard(_ event: RunEvent) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    StatusBadge(text: event.kind, color: eventKindColor(event.kind))

                    if let exitCode = event.exitCode {
                        StatusBadge(
                            text: "exit \(exitCode)",
                            color: exitCode == 0 ? StudioNorthTheme.link : StudioNorthTheme.danger
                        )
                    }

                    if let guardVerdict = event.guardVerdict {
                        StatusBadge(
                            text: guardVerdict,
                            color: guardVerdict == "approved" ? StudioNorthTheme.link : StudioNorthTheme.danger
                        )
                    }

                    Spacer()

                    Text(formatEventTime(event.ts))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }

                if let tool = event.toolName {
                    Text("Tool: \(tool)")
                        .font(.caption.monospaced())
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }

                if let cmd = event.command {
                    Text(cmd)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(StudioNorthTheme.ink)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(StudioNorthTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                }

                if let layer = event.guardLayer {
                    Text("Layer: \(layer)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }

                if let rule = event.guardRule {
                    Text("Rule: \(rule)")
                        .font(.caption2.monospaced())
                        .foregroundStyle(StudioNorthTheme.danger)
                }

                if let body = event.body, !body.isEmpty {
                    Text(body)
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.ink)
                        .lineLimit(10)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var stickyBottomBar: some View {
        HStack(spacing: 12) {
            Button {
                transcriptStore.autoScrollEnabled.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: transcriptStore.autoScrollEnabled ? "arrow.down.circle.fill" : "arrow.down.circle")
                    Text("Auto-scroll")
                        .font(.caption.weight(.medium))
                }
                .foregroundStyle(transcriptStore.autoScrollEnabled ? StudioNorthTheme.link : StudioNorthTheme.inkMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)

            Spacer()

            if let run = transcriptStore.run,
               run.state == "running" || run.state == "started" || run.state == "queued" {
                ActionPill(
                    title: transcriptStore.isKilling ? "Killing..." : "Kill Run",
                    icon: "xmark.circle",
                    isDestructive: true
                ) {
                    Task { await transcriptStore.killRun() }
                }
                .disabled(transcriptStore.isKilling)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(StudioNorthTheme.surface)
        .overlay(HairlineDivider(), alignment: .top)
    }

    private func bannerView(message: String, isError: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(isError ? StudioNorthTheme.danger : StudioNorthTheme.link)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(StudioNorthTheme.ink)
            Spacer()
        }
        .padding(10)
        .background((isError ? StudioNorthTheme.danger : StudioNorthTheme.link).opacity(0.1))
    }

    private func stateColor(for state: String) -> Color {
        switch state {
        case "running", "started": return StudioNorthTheme.link
        case "failed", "killed": return StudioNorthTheme.danger
        default: return StudioNorthTheme.inkMuted
        }
    }

    private func eventKindColor(_ kind: String) -> Color {
        switch kind {
        case "command": return StudioNorthTheme.brand
        case "tool_call": return StudioNorthTheme.link
        case "guard": return StudioNorthTheme.danger
        default: return StudioNorthTheme.inkMuted
        }
    }

    private func formatDuration(_ run: Run) -> String {
        guard let start = run.startedAt else { return "queued" }
        let end = run.endedAt ?? Int64(Date().timeIntervalSince1970 * 1000)
        let sec = max(0, Int((end - start) / 1000))
        return "\(sec)s"
    }

    private func formatEventTime(_ ts: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ts) / 1000.0)
        let f = DateFormatter()
        f.timeStyle = .medium
        return f.string(from: date)
    }
}
