import SwiftUI

public struct TaskDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    public let taskId: String
    public let boardStore: BoardStore
    public let isUserAdmin: Bool

    @State private var detailStore: TaskDetailStore
    @State private var isEditing: Bool = false
    @State private var editTitle: String = ""
    @State private var editDescription: String = ""
    @State private var editEstimate: String = ""
    @State private var editAssigneeId: String = ""
    @State private var actionError: String?

    public init(
        taskId: String,
        boardStore: BoardStore,
        isUserAdmin: Bool = false
    ) {
        self.taskId = taskId
        self.boardStore = boardStore
        self.isUserAdmin = isUserAdmin
        _detailStore = State(initialValue: TaskDetailStore(
            taskId: taskId,
            apiClient: boardStore.apiClient,
            onTaskUpdated: { updated in
                boardStore.updateTaskInList(updated)
            }
        ))
    }

    private var isAssigneeAgent: Bool {
        guard let task = detailStore.task, let aid = task.assigneeId else { return false }
        if task.assignee?.kind == "agent" { return true }
        return boardStore.members.first(where: { $0.id == aid })?.kind == "agent"
    }

    private var availableDepTasks: [BoardTask] {
        let existingIds = Set(detailStore.deps.map(\.id))
        return boardStore.tasks.filter { $0.id != taskId && !existingIds.contains($0.id) }
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let error = actionError ?? detailStore.errorMessage {
                        errorBanner(error)
                    }

                    if detailStore.isLoading && detailStore.task == nil {
                        ProgressView()
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.vertical, 40)
                    } else if let task = detailStore.task {
                        headerSection(task: task)
                        actionsSection(task: task)
                        TaskDependenciesSection(
                            detailStore: detailStore,
                            availableTasks: availableDepTasks,
                            onError: { actionError = $0 }
                        )
                        TaskSubtasksSection(
                            detailStore: detailStore,
                            onError: { actionError = $0 }
                        )
                        TaskCommentsSection(
                            detailStore: detailStore,
                            onError: { actionError = $0 }
                        )
                    }
                }
                .padding(20)
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle(detailStore.task.map { "#\($0.number)" } ?? "Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(StudioNorthTheme.link)
                }
            }
            .task {
                await detailStore.loadDetail()
                if let task = detailStore.task {
                    syncEditFields(with: task)
                }
            }
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(StudioNorthTheme.onBrand)
            Text(message)
                .font(.footnote.weight(.medium))
                .foregroundStyle(StudioNorthTheme.onBrand)
            Spacer()
            Button { actionError = nil } label: {
                Image(systemName: "xmark").foregroundStyle(StudioNorthTheme.onBrand)
            }
        }
        .padding(12)
        .background(StudioNorthTheme.danger)
        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
    }

    private func headerSection(task: BoardTask) -> some View {
        RaisedCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    StatusBadge(text: task.status, color: StudioNorthTheme.link)
                    Spacer()
                    Button(isEditing ? "Cancel" : "Edit") {
                        if isEditing { syncEditFields(with: task) }
                        isEditing.toggle()
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.link)
                }

                if isEditing {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Title", text: $editTitle)
                            .font(.headline)
                            .padding(8)
                            .background(StudioNorthTheme.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 8))

                        TextEditor(text: $editDescription)
                            .font(.body)
                            .frame(minHeight: 80)
                            .padding(4)
                            .background(StudioNorthTheme.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 8))

                        HStack(spacing: 12) {
                            Picker("Assignee", selection: $editAssigneeId) {
                                Text("Unassigned").tag("")
                                ForEach(boardStore.members) { m in
                                    Text("@\(m.handle)").tag(m.id)
                                }
                            }
                            .pickerStyle(.menu)

                            TextField("Estimate (min)", text: $editEstimate)
                                .keyboardType(.numberPad)
                                .frame(width: 120)
                                .padding(8)
                                .background(StudioNorthTheme.surface)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }

                        Button("Save Changes") {
                            Task { await saveEdits() }
                        }
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(StudioNorthTheme.onBrand)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(StudioNorthTheme.brand)
                        .clipShape(Capsule())
                    }
                } else {
                    Text(task.title)
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(StudioNorthTheme.ink)

                    if !task.description.isEmpty {
                        Text(task.description)
                            .font(.subheadline)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                    }

                    HStack(spacing: 12) {
                        if let assignee = task.assignee {
                            StatusBadge(text: "@\(assignee.handle)", color: StudioNorthTheme.ink)
                        } else {
                            StatusBadge(text: "Unassigned", color: StudioNorthTheme.inkMuted)
                        }

                        if let estimate = task.estimateMinutes, estimate > 0 {
                            StatusBadge(text: "\(estimate)m", color: StudioNorthTheme.inkMuted)
                        }
                    }
                }
            }
        }
    }

    private func actionsSection(task: BoardTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ACTIONS")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(StudioNorthTheme.inkMuted)

            HStack(spacing: 10) {
                if task.holderId != nil || task.checkedOutAt != nil {
                    let holderName = task.holder?.handle ?? task.holderId ?? "held"
                    ActionPill(title: "Release (\(holderName))", icon: "lock.open", isDestructive: true) {
                        Task {
                            do { try await detailStore.release() }
                            catch { actionError = error.localizedDescription }
                        }
                    }
                } else {
                    ActionPill(title: "Check Out", icon: "lock.fill") {
                        Task {
                            do { try await detailStore.checkout() }
                            catch { actionError = error.localizedDescription }
                        }
                    }
                }

                if isAssigneeAgent && isUserAdmin, let aid = task.assigneeId {
                    ActionPill(
                        title: detailStore.wakeSuccess ? "Agent Woken" : (detailStore.isWaking ? "Waking…" : "Wake Agent"),
                        icon: detailStore.wakeSuccess ? "checkmark" : "bolt.fill"
                    ) {
                        Task {
                            do { try await detailStore.wakeAgent(assigneeId: aid) }
                            catch { actionError = error.localizedDescription }
                        }
                    }
                }
            }
        }
    }

    private func syncEditFields(with task: BoardTask) {
        editTitle = task.title
        editDescription = task.description
        editEstimate = task.estimateMinutes.map(String.init) ?? ""
        editAssigneeId = task.assigneeId ?? ""
    }

    private func saveEdits() async {
        let est = Int(editEstimate)
        let aid = editAssigneeId.isEmpty ? nil : editAssigneeId
        do {
            try await detailStore.update(
                title: editTitle,
                description: editDescription,
                estimateMinutes: est,
                assigneeId: aid
            )
            isEditing = false
        } catch {
            actionError = error.localizedDescription
        }
    }
}
