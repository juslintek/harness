import SwiftUI

public struct TaskCardView: View {
    public let task: BoardTask
    public let dependencyCount: Int
    public let onSelect: () -> Void
    public let onMove: (TaskStatus) -> Void

    public init(
        task: BoardTask,
        dependencyCount: Int = 0,
        onSelect: @escaping () -> Void,
        onMove: @escaping (TaskStatus) -> Void
    ) {
        self.task = task
        self.dependencyCount = dependencyCount
        self.onSelect = onSelect
        self.onMove = onMove
    }

    private var isCheckedOut: Bool {
        task.holderId != nil || task.checkedOutAt != nil
    }

    private var currentStatus: TaskStatus? {
        TaskStatus(rawValue: task.status)
    }

    public var body: some View {
        Button(action: onSelect) {
            RaisedCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .center) {
                        Text("#\(task.number)")
                            .font(.system(size: 12, weight: .bold, design: .monospaced))
                            .foregroundStyle(StudioNorthTheme.inkMuted)

                        Spacer()

                        if isCheckedOut {
                            let holderName = task.holder?.handle ?? task.holderId ?? "held"
                            StatusBadge(text: "🔒 \(holderName)", color: StudioNorthTheme.accent)
                        } else if let assignee = task.assignee {
                            StatusBadge(text: "@\(assignee.handle)", color: StudioNorthTheme.inkMuted)
                        }
                    }

                    Text(task.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(StudioNorthTheme.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 12) {
                        if dependencyCount > 0 {
                            HStack(spacing: 3) {
                                Image(systemName: "link")
                                    .font(.system(size: 10, weight: .semibold))
                                Text("\(dependencyCount)")
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                            }
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                        }

                        if let estimate = task.estimateMinutes, estimate > 0 {
                            HStack(spacing: 3) {
                                Image(systemName: "clock")
                                    .font(.system(size: 10, weight: .semibold))
                                Text("\(estimate)m")
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                            }
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                        }

                        Spacer()

                        Menu {
                            ForEach(TaskStatus.allCases.filter { $0.rawValue != task.status }) { target in
                                Button(target.title) {
                                    onMove(target)
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(StudioNorthTheme.inkMuted)
                                .frame(width: 24, height: 24)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Task actions")
                        .accessibilityIdentifier("board.task.menu.\(task.id)")
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Task #\(task.number): \(task.title)")
        .accessibilityIdentifier("board.task.\(task.id)")
        .draggable(task.id)
        .contextMenu {
            Menu("Move to…") {
                ForEach(TaskStatus.allCases.filter { $0.rawValue != task.status }) { target in
                    Button(target.title) {
                        onMove(target)
                    }
                }
            }
        }
    }
}
