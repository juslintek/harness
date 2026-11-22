import SwiftUI

private enum MemorySubTab: String, CaseIterable, Identifiable {
    case notes = "Notes"
    case writes = "Write History"
    case lessons = "Lessons"

    var id: String { rawValue }
}

public struct MemoryVaultView: View {
    @Bindable var store: MemoryStore
    @State private var selectedTab: MemorySubTab = .notes
    @State private var isAgentsOnly: Bool = false
    @State private var isCreatingNote: Bool = false
    @State private var newRelPath: String = ""
    @State private var newBody: String = ""
    @State private var newScope: String = "org"

    public init(store: MemoryStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 12) {
            Picker("Memory Tab", selection: $selectedTab) {
                ForEach(MemorySubTab.allCases) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)

            switch selectedTab {
            case .notes:
                notesTab
            case .writes:
                writesTab
            case .lessons:
                lessonsTab
            }
        }
        .task {
            await store.loadFacets()
            await store.loadNotes()
            store.subscribeToRealtime()
        }
        .onDisappear {
            store.stopRealtime()
        }
        .sheet(isPresented: $isCreatingNote) {
            createNoteSheet
        }
    }

    // MARK: - Notes Tab
    private var notesTab: some View {
        VStack(spacing: 8) {
            // Search Bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                TextField("Search memory notes...", text: $store.searchQuery)
                    .textFieldStyle(.plain)
                    .foregroundStyle(StudioNorthTheme.ink)
                    .onSubmit {
                        Task { await store.loadNotes() }
                    }
                if !store.searchQuery.isEmpty {
                    Button {
                        store.searchQuery = ""
                        Task { await store.loadNotes() }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }
                }
            }
            .padding(10)
            .background(StudioNorthTheme.surfaceRaised)
            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
            .padding(.horizontal)

            // Facet Filter Chips
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    // Scope filters
                    ForEach(Array(store.facets.scopes.keys.sorted()), id: \.self) { scope in
                        let isSelected = store.selectedScope == scope
                        Button {
                            store.selectedScope = isSelected ? nil : scope
                            Task { await store.loadNotes() }
                        } label: {
                            Text("\(scope) (\(store.facets.scopes[scope] ?? 0))")
                                .font(.caption.weight(isSelected ? .bold : .regular))
                                .foregroundStyle(isSelected ? StudioNorthTheme.onBrand : StudioNorthTheme.ink)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(isSelected ? StudioNorthTheme.brand : StudioNorthTheme.surfaceRaised)
                                .clipShape(Capsule())
                        }
                    }

                    // Type filters
                    ForEach(Array(store.facets.types.keys.sorted()), id: \.self) { type in
                        let isSelected = store.selectedType == type
                        Button {
                            store.selectedType = isSelected ? nil : type
                            Task { await store.loadNotes() }
                        } label: {
                            Text("\(type) (\(store.facets.types[type] ?? 0))")
                                .font(.caption.weight(isSelected ? .bold : .regular))
                                .foregroundStyle(isSelected ? StudioNorthTheme.onBrand : StudioNorthTheme.ink)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 4)
                                .background(isSelected ? StudioNorthTheme.brand : StudioNorthTheme.surfaceRaised)
                                .clipShape(Capsule())
                        }
                    }
                }
                .padding(.horizontal)
            }

            // Create Note Button
            HStack {
                Spacer()
                Button {
                    isCreatingNote = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                        Text("New Note")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.onBrand)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(StudioNorthTheme.brand)
                    .clipShape(Capsule())
                }
            }
            .padding(.horizontal)

            // Notes List
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(store.notes) { note in
                        NavigationLink {
                            NoteDetailView(store: store, noteId: note.id)
                        } label: {
                            RaisedCard {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(note.title)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(StudioNorthTheme.ink)
                                        Spacer()
                                        StatusBadge(text: note.type, color: StudioNorthTheme.accent)
                                    }

                                    Text(note.path)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(StudioNorthTheme.inkMuted)

                                    if let snippet = note.snippet, !snippet.isEmpty {
                                        Text(snippet)
                                            .font(.caption)
                                            .foregroundStyle(StudioNorthTheme.inkMuted)
                                            .lineLimit(2)
                                    }
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: - Write History Tab
    private var writesTab: some View {
        VStack(spacing: 8) {
            Toggle("Agents Only", isOn: $isAgentsOnly)
                .font(.subheadline)
                .padding(.horizontal)
                .onChange(of: isAgentsOnly) { _, val in
                    Task { await store.loadWrites(agentsOnly: val) }
                }

            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(store.writes) { write in
                        RaisedCard {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text("\(write.op.uppercased()) by @\(write.actor)")
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(StudioNorthTheme.ink)
                                    Spacer()
                                    if write.canRevert {
                                        Button("Revert") {
                                            Task { try? await store.revertWrite(id: write.id) }
                                        }
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(StudioNorthTheme.danger)
                                    }
                                }

                                Text(write.path)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(StudioNorthTheme.inkMuted)

                                // Diff preview
                                let diff = MemoryDiffEngine.computeLineDiff(before: write.before, after: write.after)
                                VStack(alignment: .leading, spacing: 2) {
                                    ForEach(diff.prefix(6)) { line in
                                        Text("\(line.kind == .added ? "+" : line.kind == .removed ? "-" : " ") \(line.text)")
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(line.kind == .added ? StudioNorthTheme.link : line.kind == .removed ? StudioNorthTheme.danger : StudioNorthTheme.inkMuted)
                                    }
                                }
                                .padding(6)
                                .background(StudioNorthTheme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }
                }
                .padding(.horizontal)
            }
        }
        .task {
            await store.loadWrites(agentsOnly: isAgentsOnly)
        }
    }

    // MARK: - Lessons Tab
    private var lessonsTab: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(store.lessons) { lesson in
                    RaisedCard {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(lesson.body)
                                    .font(.subheadline)
                                    .foregroundStyle(StudioNorthTheme.ink)
                                Spacer()
                                StatusBadge(text: lesson.status, color: StudioNorthTheme.accent)
                            }

                            HStack {
                                Text("Author: @\(lesson.authorHandle ?? "unknown")")
                                    .font(.caption)
                                    .foregroundStyle(StudioNorthTheme.inkMuted)
                                Spacer()
                                StatusBadge(text: lesson.scope, color: StudioNorthTheme.link)
                            }

                            if lesson.status == "pending" && (store.isOrgAdmin || store.isInstanceAdmin) {
                                HStack(spacing: 8) {
                                    Button("Accept") {
                                        Task {
                                            try? await store.decideLesson(id: lesson.id, decision: "accept", reason: "Accepted from mobile")
                                        }
                                    }
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(StudioNorthTheme.onBrand)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(StudioNorthTheme.brand)
                                    .clipShape(Capsule())

                                    Button("Reject") {
                                        Task {
                                            try? await store.decideLesson(id: lesson.id, decision: "reject", reason: "Rejected from mobile")
                                        }
                                    }
                                    .font(.caption)
                                    .foregroundStyle(StudioNorthTheme.danger)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal)
        }
        .task {
            await store.loadLessons()
        }
    }

    // MARK: - Create Note Sheet
    private var createNoteSheet: some View {
        NavigationStack {
            Form {
                Section("Location") {
                    TextField("Relative path (e.g. docs/guide.md)", text: $newRelPath)
                    Picker("Scope", selection: $newScope) {
                        Text("Org").tag("org")
                        Text("Global").tag("global")
                    }
                }
                Section("Content") {
                    TextEditor(text: $newBody)
                        .frame(minHeight: 150)
                }
            }
            .navigationTitle("New Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isCreatingNote = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            try? await store.createNote(scope: newScope, rel: newRelPath, body: newBody)
                            isCreatingNote = false
                            newRelPath = ""
                            newBody = ""
                        }
                    }
                    .disabled(newRelPath.isEmpty || newBody.isEmpty)
                }
            }
        }
    }
}
