import SwiftUI

public struct ApprovalCardView: View {
    public let approval: Approval
    public let store: ApprovalsStore
    public let onJumpToRun: (String) -> Void

    public init(
        approval: Approval,
        store: ApprovalsStore,
        onJumpToRun: @escaping (String) -> Void = { _ in }
    ) {
        self.approval = approval
        self.store = store
        self.onJumpToRun = onJumpToRun
    }

    public var body: some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 12) {
                headerRow

                commandBox

                if let reason = approval.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.ink)
                }

                runLinkRow

                if approval.status == "pending" {
                    HairlineDivider()
                    actionsRow
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var headerRow: some View {
        HStack {
            if approval.status == "pending" {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remaining = ApprovalsStore.remainingSeconds(expiresAt: approval.expiresAt, now: context.date)
                    let isExpired = remaining <= 0
                    let isDanger = remaining > 0 && remaining < 30

                    HStack(spacing: 4) {
                        Image(systemName: isExpired ? "hourglass.bottomhalf.filled" : "clock")
                            .font(.caption2)
                        Text(isExpired ? "EXPIRED" : "\(remaining)s remaining")
                            .font(.caption.monospacedDigit().weight(.medium))
                    }
                    .foregroundStyle(isExpired || isDanger ? StudioNorthTheme.danger : StudioNorthTheme.inkMuted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background((isExpired || isDanger ? StudioNorthTheme.danger : StudioNorthTheme.inkMuted).opacity(0.1))
                    .clipShape(Capsule())
                }
            } else {
                StatusBadge(text: approval.status, color: statusColor(for: approval.status))
            }

            Spacer()

            if let decidedBy = approval.decidedBy {
                Text(decidedBy)
                    .font(.caption2.monospaced())
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            }
        }
    }

    private var commandBox: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("COMMAND")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(StudioNorthTheme.inkMuted)

            Text(approval.command)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(StudioNorthTheme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(StudioNorthTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                        .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
                )
        }
    }

    private var runLinkRow: some View {
        HStack {
            Button {
                onJumpToRun(approval.runId)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "play.circle")
                        .font(.caption)
                    Text("Run \(approval.runId)")
                        .font(.caption.monospaced())
                        .lineLimit(1)
                    Image(systemName: "arrow.up.right")
                        .font(.caption2)
                }
                .foregroundStyle(StudioNorthTheme.link)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("approval.runLink.\(approval.id)")

            Spacer()
        }
    }

    private var actionsRow: some View {
        HStack(spacing: 12) {
            let inFlight = store.decidingIds.contains(approval.id)

            ActionPill(
                title: inFlight ? "Approving..." : "Approve ↗",
                icon: nil
            ) {
                Task {
                    await store.decide(id: approval.id, decision: "approve")
                }
            }
            .disabled(inFlight)
            .opacity(inFlight ? 0.6 : 1.0)
            .accessibilityLabel("Approve guard request")
            .accessibilityIdentifier("approval.approve.\(approval.id)")

            Button {
                Task {
                    await store.decide(id: approval.id, decision: "deny")
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                    Text(inFlight ? "Denying..." : "Deny")
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(StudioNorthTheme.danger)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.clear)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(StudioNorthTheme.danger, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(inFlight)
            .opacity(inFlight ? 0.6 : 1.0)
            .accessibilityLabel("Deny guard request")
            .accessibilityIdentifier("approval.deny.\(approval.id)")
        }
    }

    private func statusColor(for status: String) -> Color {
        switch status {
        case "approved": return StudioNorthTheme.link
        case "denied": return StudioNorthTheme.danger
        case "expired": return StudioNorthTheme.inkMuted
        default: return StudioNorthTheme.inkMuted
        }
    }
}
