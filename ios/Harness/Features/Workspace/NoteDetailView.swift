import SwiftUI

public struct NoteDetailView: View {
    @Bindable var store: MemoryStore
    let noteId: String
    @Environment(\.dismiss) private var dismiss
    @State private var isEditing: Bool = false
    @State private var wikilinkError: String?

    public init(store: MemoryStore, noteId: String) {
        self.store = store
        self.noteId = noteId
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if store.isLoading && store.selectedNote == nil {
                    ProgressView("Loading note...")
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 32)
                } else if let note = store.selectedNote {
                    // Header metadata card
                    RaisedCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(note.title)
                                    .font(.title3.weight(.bold))
                                    .foregroundStyle(StudioNorthTheme.ink)
                                Spacer()
                                StatusBadge(text: note.type, color: StudioNorthTheme.accent)
                                if store.wasLastSaveRedacted {
                                    StatusBadge(text: "Redacted", color: StudioNorthTheme.danger)
                                }
                            }

                            HStack(spacing: 8) {
                                Text(note.path)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(StudioNorthTheme.inkMuted)
                                Spacer()
                                StatusBadge(text: note.scope, color: StudioNorthTheme.link)
                            }

                            if !note.tags.isEmpty {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 6) {
                                        ForEach(note.tags, id: \.self) { tag in
                                            StatusBadge(text: "#\(tag)", color: StudioNorthTheme.inkMuted)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Body Viewer / Editor
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(isEditing ? "Edit Draft" : "Content")
                                .font(.headline)
                                .foregroundStyle(StudioNorthTheme.ink)
                            Spacer()
                            if note.canWrite {
                                Button(isEditing ? "Preview" : "Edit") {
                                    isEditing.toggle()
                                }
                                .font(.subheadline)
                                .foregroundStyle(StudioNorthTheme.link)
                            }
                        }

                        if isEditing {
                            TextEditor(text: $store.localDraft)
                                .font(.system(.body, design: .monospaced))
                                .frame(minHeight: 200)
                                .padding(8)
                                .background(StudioNorthTheme.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                                .overlay(
                                    RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                        .stroke(StudioNorthTheme.border, lineWidth: 1)
                                )

                            HStack {
                                Button {
                                    Task {
                                        try? await store.saveNote(
                                            id: note.id,
                                            body: store.localDraft,
                                            baseHash: note.hash,
                                            type: note.type,
                                            tags: note.tags
                                        )
                                        if store.conflictState == nil {
                                            isEditing = false
                                        }
                                    }
                                } label: {
                                    Text("Save Changes")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(StudioNorthTheme.onBrand)
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 8)
                                        .background(StudioNorthTheme.brand)
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)

                                Spacer()
                            }
                        } else {
                            bodyWithWikilinks(note.body)
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(StudioNorthTheme.surfaceRaised)
                                .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                        }
                    }

                    // Backlinks section
                    if !store.backlinks.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Backlinks (\(store.backlinks.count))")
                                .font(.headline)
                                .foregroundStyle(StudioNorthTheme.ink)

                            ForEach(store.backlinks) { backlink in
                                Button {
                                    Task {
                                        await store.loadNoteDetail(id: backlink.id)
                                    }
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(backlink.title)
                                                .font(.subheadline.weight(.medium))
                                                .foregroundStyle(StudioNorthTheme.ink)
                                            Text(backlink.path)
                                                .font(.caption2.monospaced())
                                                .foregroundStyle(StudioNorthTheme.inkMuted)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                            .foregroundStyle(StudioNorthTheme.inkMuted)
                                    }
                                    .padding(8)
                                    .background(StudioNorthTheme.surfaceRaised)
                                    .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    // Delete Note Action
                    if note.canWrite {
                        Button(role: .destructive) {
                            Task {
                                try? await store.deleteNote(id: note.id, baseHash: note.hash)
                                dismiss()
                            }
                        } label: {
                            HStack {
                                Text("Delete Note")
                                Spacer()
                                Image(systemName: "trash")
                            }
                            .font(.subheadline)
                            .foregroundStyle(StudioNorthTheme.danger)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(StudioNorthTheme.danger.opacity(0.1))
                            .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 8)
                    }
                }
            }
            .padding(16)
        }
        .background(StudioNorthTheme.surface)
        .navigationTitle(store.selectedNote?.title ?? "Note")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.loadNoteDetail(id: noteId)
        }
        .sheet(isPresented: $store.isConflictPresented) {
            NoteConflictSheet(store: store, noteId: noteId)
        }
    }

    @ViewBuilder
    private func bodyWithWikilinks(_ text: String) -> some View {
        let pattern = "\\[\\[([^\\]|]+)(?:\\|([^\\]]*))?\\]\\]"
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let nsString = text as NSString
            let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsString.length))

            if matches.isEmpty {
                Text(text)
                    .font(.body)
                    .foregroundStyle(StudioNorthTheme.ink)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(text)
                        .font(.body)
                        .foregroundStyle(StudioNorthTheme.ink)

                    // Surface detected wikilinks as actionable pills below text
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Array(matches.enumerated()), id: \.offset) { _, match in
                                let target = nsString.substring(with: match.range(at: 1)).components(separatedBy: "#")[0].trimmingCharacters(in: .whitespaces)
                                let label = match.numberOfRanges > 2 && match.range(at: 2).location != NSNotFound
                                    ? nsString.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespaces)
                                    : target

                                Button {
                                    Task {
                                        if let hit = await store.resolveWikilink(sourceNoteId: noteId, target: target) {
                                            await store.loadNoteDetail(id: hit.id)
                                        }
                                    }
                                } label: {
                                    HStack(spacing: 4) {
                                        Image(systemName: "link")
                                            .font(.caption2)
                                        Text(label.isEmpty ? target : label)
                                            .font(.caption.weight(.semibold))
                                    }
                                    .foregroundStyle(StudioNorthTheme.link)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(StudioNorthTheme.link.opacity(0.12))
                                    .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        } else {
            Text(text)
                .font(.body)
                .foregroundStyle(StudioNorthTheme.ink)
        }
    }
}
