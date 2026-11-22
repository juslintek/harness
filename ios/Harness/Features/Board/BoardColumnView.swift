import SwiftUI

public struct BoardColumnView: View {
    public let status: TaskStatus
    public let tasks: [BoardTask]
    public let store: BoardStore
    public let onSelectTask: (BoardTask) -> Void
    public let onMoveTask: (String, TaskStatus) -> Void

    public init(
        status: TaskStatus,
        tasks: [BoardTask],
        store: BoardStore,
        onSelectTask: @escaping (BoardTask) -> Void,
        onMoveTask: @escaping (String, TaskStatus) -> Void
    ) {
        self.status = status
        self.tasks = tasks
        self.store = store
        self.onSelectTask = onSelectTask
        self.onMoveTask = onMoveTask
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Column Header
            HStack(spacing: 8) {
                Text(status.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.ink)

                StatusBadge(
                    text: "\(tasks.count)",
                    color: tasks.isEmpty ? StudioNorthTheme.inkMuted : StudioNorthTheme.link
                )

                Spacer()
            }
            .padding(.horizontal, 4)

            // Column Task List
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 10) {
                    if tasks.isEmpty {
                        RaisedCard {
                            VStack(spacing: 6) {
                                Text("No tasks in \(status.title.lowercased())")
                                    .font(.caption)
                                    .foregroundStyle(StudioNorthTheme.inkMuted)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                        }
                    } else {
                        ForEach(tasks) { task in
                            TaskCardView(
                                task: task,
                                dependencyCount: store.dependencyCount(for: task.id),
                                onSelect: { onSelectTask(task) },
                                onMove: { target in onMoveTask(task.id, target) }
                            )
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .padding(12)
        .background(StudioNorthTheme.surfaceRaised.opacity(0.4))
        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.md))
        .overlay(
            RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.md)
                .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
        )
        .dropDestination(for: String.self) { items, _ in
            guard let droppedId = items.first else { return false }
            onMoveTask(droppedId, status)
            return true
        }
    }
}
