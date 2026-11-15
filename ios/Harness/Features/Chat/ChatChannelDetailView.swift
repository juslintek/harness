import SwiftUI

public struct ChatChannelDetailView: View {
    public let channel: ChatChannel
    public let store: ChatStore
    @State private var messageText: String = ""
    @State private var selectedTaskRef: ChatTaskReference?

    public init(channel: ChatChannel, store: ChatStore) {
        self.channel = channel
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if store.hasOlderMessages {
                            Button {
                                Task {
                                    await store.loadOlderMessages()
                                }
                            } label: {
                                if store.isLoadingOlder {
                                    ProgressView()
                                        .padding(.vertical, 8)
                                } else {
                                    Text("Load older messages")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(StudioNorthTheme.link)
                                        .padding(.vertical, 8)
                                        .frame(maxWidth: .infinity)
                                }
                            }
                            .buttonStyle(.plain)
                        }

                        if store.isLoading && store.messages.isEmpty {
                            ProgressView()
                                .padding(.vertical, 32)
                        } else if store.messages.isEmpty {
                            VStack(spacing: 6) {
                                Text("No messages yet")
                                    .font(.headline)
                                    .foregroundStyle(StudioNorthTheme.ink)
                                Text("Be the first to say hello in #\(channel.name)")
                                    .font(.subheadline)
                                    .foregroundStyle(StudioNorthTheme.inkMuted)
                            }
                            .padding(.vertical, 40)
                        } else {
                            ForEach(store.messages) { message in
                                messageRow(message)
                                    .id(message.id)
                            }
                        }
                    }
                    .padding(16)
                }
                .onChange(of: store.messages.count) { _, _ in
                    if let last = store.messages.last {
                        withAnimation {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            HairlineDivider()

            ChatComposerView(
                text: $messageText,
                members: store.channelMembers
            ) { text in
                Task {
                    _ = try? await store.sendMessage(body: text)
                }
            }
        }
        .background(StudioNorthTheme.surface)
        .navigationTitle(channelTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if store.activeChannel?.id != channel.id {
                await store.selectChannel(channel)
            }
        }
        .sheet(isPresented: Binding(
            get: { store.activeThread != nil },
            set: { if !$0 { store.closeThread() } }
        )) {
            if let root = store.activeThread {
                ChatThreadSheet(store: store, rootMessage: root)
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

    private var channelTitle: String {
        channel.kind == "dm" ? "@\(channel.name)" : "#\(channel.name)"
    }

    private func messageRow(_ message: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(message.author?.displayName ?? message.author?.handle ?? "Member")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(StudioNorthTheme.ink)

                if let handle = message.author?.handle {
                    Text("@\(handle)")
                        .font(.caption)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                }

                if message.author?.kind == "agent" {
                    StatusBadge(text: "agent", color: StudioNorthTheme.accent)
                }
                Spacer()
                Text(formatTimestamp(message.createdAt))
                    .font(.caption2)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            }

            Text(message.body)
                .font(.body)
                .foregroundStyle(StudioNorthTheme.ink)

            if !message.tasks.isEmpty {
                HStack(spacing: 6) {
                    ForEach(message.tasks.indices, id: \.self) { idx in
                        let taskRef = message.tasks[idx]
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
                .padding(.top, 2)
            }

            HStack {
                Spacer()
                Button {
                    Task {
                        await store.openThread(message)
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.caption2)
                        if message.replyCount > 0 {
                            Text("\(message.replyCount) replies")
                                .font(.caption.weight(.semibold))
                        } else {
                            Text("Reply")
                                .font(.caption)
                        }
                    }
                    .foregroundStyle(StudioNorthTheme.link)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
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

    private func formatTimestamp(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
