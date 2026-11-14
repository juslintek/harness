import HarnessKit
import SwiftUI

enum Phase: Equatable {
    case loading, ready, unavailable
    case failed(String)

    init(_ error: Error) {
        self = error as? APIError == .notImplemented ? .unavailable : .failed(error.localizedDescription)
    }
}

/// Covers its content while loading or after a failure; the 501 case is not an error, the backend just lacks the feature.
struct PhaseView: View {
    let phase: Phase
    let retry: () -> Void

    var body: some View {
        switch phase {
        case .ready:
            EmptyView()
        case .loading:
            ProgressView().accessibilityLabel("Loading")
        case .unavailable:
            ContentUnavailableView("Not available on this backend", systemImage: "nosign")
        case .failed(let message):
            ContentUnavailableView {
                Label("Could not load", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry", action: retry)
            }
        }
    }
}

struct BoardView: View {
    let client: APIClient
    let org: Org
    let project: Project

    @State private var tasks: [TaskItem] = []
    @State private var phase = Phase.loading
    @State private var selection: String?
    @State private var showNewTask = false
    @State private var moveError: String?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(TaskStatus.allCases) { status in
                    column(status)
                }
            }
            .padding()
        }
        .overlay {
            if phase != .ready {
                PhaseView(phase: phase) { Task { await load() } }
            } else if tasks.isEmpty {
                ContentUnavailableView("No tasks yet", systemImage: "rectangle.3.group",
                                       description: Text("Create one with New Task."))
            }
        }
        .inspector(isPresented: Binding(get: { selection != nil }, set: { if !$0 { selection = nil } })) {
            if let selection {
                TaskInspector(client: client, taskId: selection, version: tasks.first { $0.id == selection }?.updatedAt ?? 0)
                    .inspectorColumnWidth(min: 260, ideal: 320, max: 460)
            }
        }
        .navigationTitle("\(project.name) Board")
        .toolbar {
            Button("New Task", systemImage: "plus") { showNewTask = true }
                .keyboardShortcut("n")
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                .keyboardShortcut("r")
        }
        .sheet(isPresented: $showNewTask) {
            NewTaskSheet { title, description in
                let created = try await client.createTask(projectId: project.id, title: title, description: description)
                selection = created.id
                await load()
            }
        }
        .alert("Could not move task", isPresented: Binding(get: { moveError != nil }, set: { if !$0 { moveError = nil } })) {
            Button("OK") {}
        } message: {
            Text(moveError ?? "")
        }
        .task(id: project.id) {
            tasks = []
            selection = nil
            phase = .loading
            await load()
            await client.watch(topic: "org:\(org.id)") { _ in await load() }
        }
    }

    private func column(_ status: TaskStatus) -> some View {
        let cards = tasks.filter { $0.status == status }.sorted { $0.rank < $1.rank }
        return VStack(alignment: .leading, spacing: 8) {
            Text("\(status.label)  \(cards.count)")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(cards) { task in card(task) }
                }
            }
        }
        .frame(width: 250)
        .frame(maxHeight: .infinity, alignment: .top)
        .padding(8)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, tasks.first(where: { $0.id == id })?.status != status else { return false }
            Task { await move(id, to: status) }
            return true
        }
    }

    private func card(_ task: TaskItem) -> some View {
        Button { selection = task.id } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text("#\(task.number)").font(.caption).foregroundStyle(.secondary)
                Text(task.title).frame(maxWidth: .infinity, alignment: .leading)
                if let assignee = task.assignee {
                    Label(assignee.displayName, systemImage: assignee.kind == "agent" ? "cpu" : "person")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
            .background(selection == task.id ? AnyShapeStyle(.selection) : AnyShapeStyle(.background),
                        in: RoundedRectangle(cornerRadius: 6))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .draggable(task.id)
        .contextMenu {
            Menu("Move to") {
                ForEach(TaskStatus.allCases.filter { $0 != task.status }) { status in
                    Button(status.label) { Task { await move(task.id, to: status) } }
                }
            }
        }
    }

    private func load() async {
        do {
            tasks = try await client.tasks(projectId: project.id)
            phase = .ready
        } catch {
            if !Task.isCancelled { phase = Phase(error) }
        }
    }

    private func move(_ id: String, to status: TaskStatus) async {
        do {
            _ = try await client.moveTask(id: id, to: status)
            await load()
        } catch {
            moveError = error.localizedDescription
        }
    }
}

struct TaskInspector: View {
    let client: APIClient
    let taskId: String
    /// Changes when the board sees the task change, so the detail refetches.
    let version: Int

    @State private var detail: TaskDetail?
    @State private var phase = Phase.loading
    @State private var comment = ""
    @State private var commentError: String?

    var body: some View {
        ScrollView {
            if let detail {
                VStack(alignment: .leading, spacing: 12) {
                    Text("#\(detail.task.number) \(detail.task.title)").font(.title3).textSelection(.enabled)
                    LabeledContent("Status", value: detail.task.status.label)
                    LabeledContent("Assignee", value: detail.task.assignee?.displayName ?? "Unassigned")
                    if !detail.task.description.isEmpty {
                        Text(detail.task.description).textSelection(.enabled)
                    }
                    Divider()
                    Text("Comments").font(.headline)
                    if detail.comments.isEmpty { Text("No comments yet").foregroundStyle(.secondary) }
                    ForEach(detail.comments) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(item.author?.displayName ?? "Unknown") · \(item.created.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption).foregroundStyle(.secondary)
                            Text(item.body).textSelection(.enabled)
                        }
                    }
                    TextField("Add a comment", text: $comment, axis: .vertical)
                        .onSubmit(send)
                    if let commentError { Text(commentError).foregroundStyle(.red) }
                    Button("Comment", action: send).disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding()
            }
        }
        .overlay { if detail == nil { PhaseView(phase: phase) { Task { await load() } } } }
        .task(id: "\(taskId)-\(version)") { await load() }
    }

    private func load() async {
        do {
            detail = try await client.task(id: taskId)
        } catch {
            if !Task.isCancelled { phase = Phase(error) }
        }
    }

    private func send() {
        let body = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        Task {
            do {
                _ = try await client.addComment(taskId: taskId, body: body)
                comment = ""
                commentError = nil
                await load()
            } catch {
                commentError = error.localizedDescription
            }
        }
    }
}

struct NewTaskSheet: View {
    let create: (String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            TextField("Title", text: $title)
            LabeledContent("Description") {
                TextEditor(text: $description)
                    .frame(minHeight: 80)
                    .accessibilityLabel("Description")
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create") {
                    busy = true
                    Task {
                        do { try await create(title, description); dismiss() } catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding()
        .frame(width: 420)
    }
}

/// Two text fields and a submit button: used for a new organisation (name, slug) and a new project (key, name).
struct TwoFieldSheet: View {
    let title: String
    let first: String
    let second: String
    let create: (String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var firstValue = ""
    @State private var secondValue = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Text(title).font(.headline)
            TextField(first, text: $firstValue)
            TextField(second, text: $secondValue)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create") {
                    busy = true
                    Task {
                        do { try await create(firstValue, secondValue); dismiss() } catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy || firstValue.isEmpty || secondValue.isEmpty)
            }
        }
        .padding()
        .frame(width: 360)
    }
}
