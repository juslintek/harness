import SwiftUI

public struct ChatNewDmSheet: View {
    public let store: ChatStore
    public let slug: String
    @Environment(\.dismiss) private var dismiss
    @State private var searchQuery: String = ""
    @State private var isCreating: Bool = false
    @State private var errorMessage: String?

    public init(store: ChatStore, slug: String) {
        self.store = store
        self.slug = slug
    }

    private var filteredMembers: [ChatMember] {
        if searchQuery.isEmpty {
            return store.orgMembers
        }
        let lower = searchQuery.lowercased()
        return store.orgMembers.filter {
            $0.handle.lowercased().contains(lower) ||
            $0.displayName.lowercased().contains(lower)
        }
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.danger)
                        .padding(.horizontal)
                }

                TextField("Search members…", text: $searchQuery)
                    .font(.body)
                    .foregroundStyle(StudioNorthTheme.ink)
                    .padding(10)
                    .background(StudioNorthTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                    .overlay(
                        RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                            .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
                    )
                    .padding(.horizontal)

                List {
                    ForEach(filteredMembers) { member in
                        Button {
                            Task {
                                isCreating = true
                                defer { isCreating = false }
                                do {
                                    _ = try await store.createDm(slug: slug, memberId: member.id)
                                    dismiss()
                                } catch {
                                    errorMessage = error.localizedDescription
                                }
                            }
                        } label: {
                            HStack(spacing: 10) {
                                StatusBadge(
                                    text: member.kind,
                                    color: member.kind == "agent" ? StudioNorthTheme.accent : StudioNorthTheme.inkMuted
                                )
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(member.displayName)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(StudioNorthTheme.ink)
                                    Text("@\(member.handle)")
                                        .font(.caption)
                                        .foregroundStyle(StudioNorthTheme.inkMuted)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(StudioNorthTheme.inkMuted)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(StudioNorthTheme.surface)
                    }
                }
                .listStyle(.plain)
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("New Direct Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(StudioNorthTheme.link)
                }
            }
        }
    }
}

public struct ChatNewGroupSheet: View {
    public let store: ChatStore
    public let slug: String
    @Environment(\.dismiss) private var dismiss
    @State private var groupName: String = ""
    @State private var selectedMemberIds: Set<String> = []
    @State private var isCreating: Bool = false
    @State private var errorMessage: String?

    public init(store: ChatStore, slug: String) {
        self.store = store
        self.slug = slug
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.danger)
                        .padding(.horizontal)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Group Name")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(StudioNorthTheme.inkMuted)

                    TextField("e.g. mobile-launch", text: $groupName)
                        .font(.body)
                        .foregroundStyle(StudioNorthTheme.ink)
                        .padding(10)
                        .background(StudioNorthTheme.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
                        )
                }
                .padding(.horizontal)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Select Members (\(selectedMemberIds.count))")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                        .padding(.horizontal)

                    List {
                        ForEach(store.orgMembers) { member in
                            Button {
                                if selectedMemberIds.contains(member.id) {
                                    selectedMemberIds.remove(member.id)
                                } else {
                                    selectedMemberIds.insert(member.id)
                                }
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: selectedMemberIds.contains(member.id) ? "checkmark.circle.fill" : "circle")
                                        .font(.body)
                                        .foregroundStyle(selectedMemberIds.contains(member.id) ? StudioNorthTheme.link : StudioNorthTheme.inkMuted)

                                    StatusBadge(
                                        text: member.kind,
                                        color: member.kind == "agent" ? StudioNorthTheme.accent : StudioNorthTheme.inkMuted
                                    )
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(member.displayName)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(StudioNorthTheme.ink)
                                        Text("@\(member.handle)")
                                            .font(.caption)
                                            .foregroundStyle(StudioNorthTheme.inkMuted)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(StudioNorthTheme.surface)
                        }
                    }
                    .listStyle(.plain)
                }

                ActionPill(
                    title: isCreating ? "Creating…" : "Create Group",
                    icon: "plus"
                ) {
                    guard !groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    Task {
                        isCreating = true
                        defer { isCreating = false }
                        do {
                            _ = try await store.createGroup(
                                slug: slug,
                                name: groupName.trimmingCharacters(in: .whitespacesAndNewlines),
                                memberIds: Array(selectedMemberIds)
                            )
                            dismiss()
                        } catch {
                            errorMessage = error.localizedDescription
                        }
                    }
                }
                .disabled(groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isCreating)
                .padding(.bottom, 12)
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("New Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(StudioNorthTheme.link)
                }
            }
        }
    }
}
