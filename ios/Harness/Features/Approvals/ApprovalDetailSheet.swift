import SwiftUI

public struct ApprovalDetailSheet: View {
    public let approval: Approval
    public let store: ApprovalsStore
    public let onDismiss: () -> Void
    public let onJumpToRun: (String) -> Void

    public init(
        approval: Approval,
        store: ApprovalsStore,
        onDismiss: @escaping () -> Void,
        onJumpToRun: @escaping (String) -> Void = { _ in }
    ) {
        self.approval = approval
        self.store = store
        self.onDismiss = onDismiss
        self.onJumpToRun = onJumpToRun
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ApprovalCardView(
                        approval: approval,
                        store: store,
                        onJumpToRun: { runId in
                            onDismiss()
                            onJumpToRun(runId)
                        }
                    )

                    RaisedCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Approval Metadata")
                                .font(.headline)
                                .foregroundStyle(StudioNorthTheme.ink)

                            metaRow(label: "ID", value: approval.id)
                            metaRow(label: "Run ID", value: approval.runId)
                            metaRow(label: "Created", value: formatDate(approval.createdAt))
                            metaRow(label: "Expires", value: formatDate(approval.expiresAt))
                            if let decidedAt = approval.decidedAt {
                                metaRow(label: "Decided At", value: formatDate(decidedAt))
                            }
                            if let decidedBy = approval.decidedBy {
                                metaRow(label: "Decided By", value: decidedBy)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("Guard Approval")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        onDismiss()
                    }
                    .foregroundStyle(StudioNorthTheme.ink)
                }
            }
        }
    }

    private func metaRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(StudioNorthTheme.inkMuted)
            Spacer()
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(StudioNorthTheme.ink)
        }
    }

    private func formatDate(_ timestamp: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(timestamp) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }
}
