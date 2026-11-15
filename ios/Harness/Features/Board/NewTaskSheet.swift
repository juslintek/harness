import SwiftUI

public struct NewTaskSheet: View {
    @Environment(\.dismiss) private var dismiss
    public let store: BoardStore
    public let initialStatus: TaskStatus

    @State private var title: String = ""
    @State private var description: String = ""
    @State private var selectedStatus: TaskStatus
    @State private var selectedAssigneeId: String = ""
    @State private var estimateMinutes: String = ""
    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String?

    public init(store: BoardStore, initialStatus: TaskStatus = .todo) {
        self.store = store
        self.initialStatus = initialStatus
        _selectedStatus = State(initialValue: initialStatus)
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if let errorMessage {
                        HStack {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(StudioNorthTheme.onBrand)
                            Text(errorMessage)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(StudioNorthTheme.onBrand)
                            Spacer()
                        }
                        .padding(12)
                        .background(StudioNorthTheme.danger)
                        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                    }

                    // Title
                    VStack(alignment: .leading, spacing: 6) {
                        Text("TITLE")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(StudioNorthTheme.inkMuted)

                        TextField("What needs to be done?", text: $title)
                            .font(.body)
                            .foregroundStyle(StudioNorthTheme.ink)
                            .padding(12)
                            .background(StudioNorthTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                    .stroke(StudioNorthTheme.border, lineWidth: 1)
                            )
                    }

                    // Description
                    VStack(alignment: .leading, spacing: 6) {
                        Text("DESCRIPTION")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(StudioNorthTheme.inkMuted)

                        TextEditor(text: $description)
                            .font(.body)
                            .foregroundStyle(StudioNorthTheme.ink)
                            .scrollContentBackground(.hidden)
                            .padding(8)
                            .frame(minHeight: 90)
                            .background(StudioNorthTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                    .stroke(StudioNorthTheme.border, lineWidth: 1)
                            )
                    }

                    // Status & Assignee pickers
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("STATUS")
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(StudioNorthTheme.inkMuted)

                            Picker("Status", selection: $selectedStatus) {
                                ForEach(TaskStatus.allCases) { st in
                                    Text(st.title).tag(st)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(StudioNorthTheme.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(StudioNorthTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                    .stroke(StudioNorthTheme.border, lineWidth: 1)
                            )
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("ASSIGNEE")
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(StudioNorthTheme.inkMuted)

                            Picker("Assignee", selection: $selectedAssigneeId) {
                                Text("Unassigned").tag("")
                                ForEach(store.members) { m in
                                    Text("@\(m.handle)").tag(m.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .tint(StudioNorthTheme.ink)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(StudioNorthTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                    .stroke(StudioNorthTheme.border, lineWidth: 1)
                            )
                        }
                    }

                    // Estimate Minutes
                    VStack(alignment: .leading, spacing: 6) {
                        Text("ESTIMATE (MINUTES)")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(StudioNorthTheme.inkMuted)

                        TextField("e.g. 60", text: $estimateMinutes)
                            .keyboardType(.numberPad)
                            .font(.body)
                            .foregroundStyle(StudioNorthTheme.ink)
                            .padding(12)
                            .background(StudioNorthTheme.surfaceRaised)
                            .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                                    .stroke(StudioNorthTheme.border, lineWidth: 1)
                            )
                    }

                    // Create Button
                    ActionPill(
                        title: isSubmitting ? "Creating…" : "Create Task",
                        icon: "plus"
                    ) {
                        Task { await submit() }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || isSubmitting)
                    .opacity(title.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1.0)
                    .padding(.top, 12)
                }
                .padding(20)
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                    .foregroundStyle(StudioNorthTheme.link)
                }
            }
        }
    }

    private func submit() async {
        let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
        guard !trimmedTitle.isEmpty else { return }

        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let estimate = Int(estimateMinutes)
        let assignee = selectedAssigneeId.isEmpty ? nil : selectedAssigneeId
        let desc = description.trimmingCharacters(in: .whitespaces).isEmpty ? nil : description

        do {
            _ = try await store.createTask(
                title: trimmedTitle,
                description: desc,
                status: selectedStatus,
                assigneeId: assignee,
                estimateMinutes: estimate
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
