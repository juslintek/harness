import SwiftUI

public struct NoteConflictSheet: View {
    @Bindable var store: MemoryStore
    let noteId: String
    @Environment(\.dismiss) private var dismiss

    public init(store: MemoryStore, noteId: String) {
        self.store = store
        self.noteId = noteId
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let conflict = store.conflictState {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Edit Conflict (HTTP 409)")
                            .font(.headline)
                            .foregroundStyle(StudioNorthTheme.danger)

                        Text("Another user or agent modified this note while you were editing. Your draft has been preserved. Review the differences below and choose how to proceed.")
                            .font(.caption)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                    .padding(.horizontal)

                    // Line diff preview
                    let diffLines = MemoryDiffEngine.computeLineDiff(
                        before: conflict.latestRemote.body,
                        after: conflict.localDraft
                    )

                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(diffLines) { line in
                                HStack(alignment: .top, spacing: 4) {
                                    Text(prefix(for: line.kind))
                                        .font(.system(.caption2, design: .monospaced).bold())
                                        .foregroundStyle(color(for: line.kind))
                                        .frame(width: 14)

                                    Text(line.text.isEmpty ? " " : line.text)
                                        .font(.system(.caption2, design: .monospaced))
                                        .foregroundStyle(color(for: line.kind))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                                .background(background(for: line.kind))
                            }
                        }
                        .padding(.vertical, 8)
                    }
                    .background(StudioNorthTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                    .overlay(
                        RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                            .stroke(StudioNorthTheme.border, lineWidth: 1)
                    )
                    .padding(.horizontal)

                    // Conflict resolution buttons
                    VStack(spacing: 8) {
                        Button {
                            Task {
                                try? await store.resolveConflictWithDraftOverwrite(id: noteId)
                                if store.conflictState == nil {
                                    dismiss()
                                }
                            }
                        } label: {
                            HStack {
                                Text("Keep My Draft & Overwrite Latest")
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                Image(systemName: "arrow.up.circle.fill")
                            }
                            .foregroundStyle(StudioNorthTheme.onBrand)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(StudioNorthTheme.brand)
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)

                        Button {
                            store.resolveConflictWithRemoteReload()
                            dismiss()
                        } label: {
                            HStack {
                                Text("Reload Remote")
                                    .font(.subheadline)
                                Spacer()
                                Image(systemName: "arrow.clockwise")
                            }
                            .foregroundStyle(StudioNorthTheme.link)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(Color.clear)
                            .overlay(
                                Capsule()
                                    .stroke(StudioNorthTheme.border, lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 16)
                } else {
                    Text("No active conflict.")
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("Resolve Conflict")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        dismiss()
                    }
                    .foregroundStyle(StudioNorthTheme.link)
                }
            }
        }
    }

    private func prefix(for kind: DiffLineKind) -> String {
        switch kind {
        case .added: return "+"
        case .removed: return "-"
        case .unchanged: return " "
        }
    }

    private func color(for kind: DiffLineKind) -> Color {
        switch kind {
        case .added: return StudioNorthTheme.link
        case .removed: return StudioNorthTheme.danger
        case .unchanged: return StudioNorthTheme.inkMuted
        }
    }

    private func background(for kind: DiffLineKind) -> Color {
        switch kind {
        case .added: return StudioNorthTheme.link.opacity(0.08)
        case .removed: return StudioNorthTheme.danger.opacity(0.08)
        case .unchanged: return Color.clear
        }
    }
}
