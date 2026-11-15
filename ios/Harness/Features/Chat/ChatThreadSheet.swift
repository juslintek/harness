import SwiftUI

public struct ChatThreadSheet: View {
    public let store: ChatStore
    public let rootMessage: ChatMessage
    @Environment(\.dismiss) private var dismiss
    @State private var replyText: String = ""
    @State private var selectedTaskRef: ChatTaskReference?

    public init(store: ChatStore, rootMessage: ChatMessage) {
        self.store = store
        self.rootMessage = rootMessage
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        RaisedCard {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 8) {
                                    Text(rootMessage.author?.displayName ?? rootMessage.author?.handle ?? "Unknown")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(StudioNorthTheme.ink)

                                    if let handle = rootMessage.author?.handle {
                                        Text("@\(handle)")
                                            .font(.caption)
                                            .foregroundStyle(StudioNorthTheme.inkMuted)
                                    }

                                    if rootMessage.author?.kind == "agent" {
                                        StatusBadge(text: "agent", color: StudioNorthTheme.accent)
                                    }
                                    Spacer()
                                    Text(formatTimestamp(rootMessage.createdAt))
                                        .font(.caption2)
                                        .foregroundStyle(StudioNorthTheme.inkMuted)
                                }

                                Text(rootMessage.body)
                                    .font(.body)
                                    .foregroundStyle(StudioNorthTheme.ink)

                                if !rootMessage.tasks.isEmpty {
                                    tasksRow(tasks: rootMessage.tasks)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        HairlineDivider()

                        Text("Replies (\(store.threadMessages.count))")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                            .padding(.horizontal, 4)

                        if store.isLoadingThread {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding()
                        } else if store.threadMessages.isEmpty {
                            Text("No replies yet. Start the conversation.")
                                .font(.subheadline)
                                .foregroundStyle(StudioNorthTheme.inkMuted)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.vertical, 24)
                        } else {
                            ForEach(store.threadMessages) { reply in
                                replyBubble(reply)
                            }
                        }
                    }
                    .padding(16)
                }

                HairlineDivider()

                ChatComposerView(
                    text: $replyText,
                    members: store.channelMembers
                ) { text in
                    Task {
                        _ = try? await store.sendMessage(body: text, threadRootId: rootMessage.id)
                    }
                }
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        store.closeThread()
                        dismiss()
                    }
                    .foregroundStyle(StudioNorthTheme.link)
                }
            }
            .sheet(item: $selectedTaskRef) { ref in
                NavigationStack {
                    VStack(spacing: 16) {
                        Text("Task #\(ref.number)")
                            .font(.title2.weight(.bold))
                            .foregroundStyle(StudioNorthTheme.ink)
                        Text("Project ID: \(ref.projectId)")
                            .font(.subheadline)
                            .foregroundStyle(StudioNorthTheme.inkMuted)
                        Spacer()
                    }
                    .padding()
                    .background(StudioNorthTheme.surface)
                    .navigationTitle("Task Preview")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { selectedTaskRef = nil }
                                .foregroundStyle(StudioNorthTheme.link)
                        }
                    }
                }
                .presentationDetents([.medium])
            }
        }
    }

    private func replyBubble(_ reply: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(reply.author?.displayName ?? reply.author?.handle ?? "Member")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.ink)

                if let handle = reply.author?.handle {
                    Text("@\(handle)")
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }

                if reply.author?.kind == "agent" {
                    StatusBadge(text: "agent", color: StudioNorthTheme.accent)
                }
                Spacer()
                Text(formatTimestamp(reply.createdAt))
                    .font(.caption2)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            }

            Text(reply.body)
                .font(.body)
                .foregroundStyle(StudioNorthTheme.ink)

            if !reply.tasks.isEmpty {
                tasksRow(tasks: reply.tasks)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(StudioNorthTheme.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
        .overlay(
            RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
        )
    }

    private func tasksRow(tasks: [ChatTaskReference]) -> some View {
        HStack(spacing: 6) {
            ForEach(tasks.indices, id: \.self) { idx in
                let taskRef = tasks[idx]
                Button {
                    selectedTaskRef = taskRef
                } label: {
                    Text("#\(taskRef.number)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(StudioNorthTheme.link)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(StudioNorthTheme.surface)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(StudioNorthTheme.border, lineWidth: StudioNorthTheme.hairline)
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func formatTimestamp(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
