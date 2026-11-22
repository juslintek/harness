import SwiftUI

struct TaskDependenciesSection: View {
    let detailStore: TaskDetailStore
    let availableTasks: [BoardTask]
    let onError: (String) -> Void

    @State private var isAddingDep: Bool = false
    @State private var selectedDepTaskId: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("DEPENDENCIES (\(detailStore.deps.count))")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                Spacer()
                Button(isAddingDep ? "Cancel" : "+ Add") { isAddingDep.toggle() }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.link)
            }

            if isAddingDep {
                HStack(spacing: 8) {
                    Picker("Select Task", selection: $selectedDepTaskId) {
                        Text("Select task…").tag("")
                        ForEach(availableTasks) { t in
                            Text("#\(t.number) \(t.title)").tag(t.id)
                        }
                    }
                    .pickerStyle(.menu)

                    Button("Link") {
                        Task {
                            guard !selectedDepTaskId.isEmpty else { return }
                            do {
                                try await detailStore.addDependency(dependsOnTaskId: selectedDepTaskId)
                                selectedDepTaskId = ""
                                isAddingDep = false
                            } catch { onError(error.localizedDescription) }
                        }
                    }
                    .disabled(selectedDepTaskId.isEmpty)
                }
                .padding(8)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            ForEach(detailStore.deps) { dep in
                HStack {
                    Text("#\(dep.number) \(dep.title)")
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.ink)
                        .lineLimit(1)
                    Spacer()
                    Button {
                        Task {
                            do { try await detailStore.removeDependency(dependsOnTaskId: dep.id) }
                            catch { onError(error.localizedDescription) }
                        }
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                            .foregroundStyle(StudioNorthTheme.danger)
                    }
                }
                .padding(10)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

struct TaskSubtasksSection: View {
    let detailStore: TaskDetailStore
    let onError: (String) -> Void

    @State private var isAddingSubtask: Bool = false
    @State private var newSubtaskTitle: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("SUBTASKS (\(detailStore.subtasks.count))")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                Spacer()
                Button(isAddingSubtask ? "Cancel" : "+ Add") { isAddingSubtask.toggle() }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.link)
            }

            if isAddingSubtask {
                HStack(spacing: 8) {
                    TextField("Subtask title", text: $newSubtaskTitle)
                        .font(.subheadline)
                        .padding(8)
                        .background(StudioNorthTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                    Button("Create") {
                        Task {
                            let title = newSubtaskTitle.trimmingCharacters(in: .whitespaces)
                            guard !title.isEmpty else { return }
                            do {
                                _ = try await detailStore.createSubtask(title: title)
                                newSubtaskTitle = ""
                                isAddingSubtask = false
                            } catch { onError(error.localizedDescription) }
                        }
                    }
                    .disabled(newSubtaskTitle.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(8)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            ForEach(detailStore.subtasks) { sub in
                HStack {
                    Text("#\(sub.number) \(sub.title)")
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.ink)
                        .lineLimit(1)
                    Spacer()
                    StatusBadge(text: sub.status, color: StudioNorthTheme.inkMuted)
                }
                .padding(10)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

struct TaskCommentsSection: View {
    let detailStore: TaskDetailStore
    let onError: (String) -> Void

    @State private var newCommentText: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("COMMENTS (\(detailStore.comments.count))")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(StudioNorthTheme.inkMuted)

            ForEach(detailStore.comments) { comment in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(comment.author.map { "@\($0.handle)" } ?? "Member")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(StudioNorthTheme.ink)
                        Spacer()
                    }
                    Text(comment.body)
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.ink)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            HStack(spacing: 8) {
                TextField("Add a comment…", text: $newCommentText)
                    .font(.subheadline)
                    .padding(10)
                    .background(StudioNorthTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                Button {
                    Task {
                        let text = newCommentText.trimmingCharacters(in: .whitespaces)
                        guard !text.isEmpty else { return }
                        do {
                            try await detailStore.addComment(body: text)
                            newCommentText = ""
                        } catch { onError(error.localizedDescription) }
                    }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(newCommentText.trimmingCharacters(in: .whitespaces).isEmpty ? StudioNorthTheme.inkMuted : StudioNorthTheme.link)
                }
                .disabled(newCommentText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}
