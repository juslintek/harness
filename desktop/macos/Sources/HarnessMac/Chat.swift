import HarnessKit
import SwiftUI

private let pageSize = 50

private func merged(_ a: [Message], _ b: [Message]) -> [Message] {
    Dictionary((a + b).map { ($0.id, $0) }, uniquingKeysWith: { $1 }).values
        .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
}

struct ChatView: View {
    let client: APIClient
    let org: Org

    @State private var channels: [Channel] = []
    @State private var phase = Phase.loading
    @State private var selection: String?
    /// Bumped on every WebSocket event so the open channel and thread refetch.
    @State private var tick = 0
    @State private var showNewChannel = false

    var body: some View {
        HSplitView {
            List(channels, selection: $selection) { channel in
                Label(channel.name, systemImage: Self.icon(channel.kind))
                    .badge(channel.unread)
                    .tag(channel.id)
            }
            .accessibilityLabel("Channels")
            .frame(minWidth: 160, idealWidth: 200, maxWidth: 300)
            Group {
                if let channel = channels.first(where: { $0.id == selection }) {
                    MessagesPane(client: client, channel: channel, tick: tick) { await loadChannels() }
                } else {
                    ContentUnavailableView("Select a channel", systemImage: "bubble.left.and.bubble.right")
                }
            }
            .frame(minWidth: 320, maxWidth: .infinity)
        }
        .overlay {
            if phase != .ready {
                PhaseView(phase: phase) { Task { await loadChannels() } }
            } else if channels.isEmpty {
                ContentUnavailableView("No channels yet", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Create one with New Channel."))
            }
        }
        .navigationTitle("Chat")
        .toolbar {
            Button("New Channel", systemImage: "plus") { showNewChannel = true }
        }
        .sheet(isPresented: $showNewChannel) {
            NameSheet(title: "New Channel", field: "Name") { name in
                let created = try await client.createGroup(orgSlug: org.slug, name: name)
                await loadChannels()
                selection = created.id
            }
        }
        .task(id: org.id) {
            channels = []
            selection = nil
            phase = .loading
            await loadChannels()
            await client.watch(topic: "org:\(org.id)") { _ in
                await bump()
                await loadChannels()
            }
        }
    }

    private static func icon(_ kind: String) -> String {
        switch kind {
        case "org": "building.2"
        case "team": "person.2"
        case "project": "rectangle.3.group"
        case "dm": "person"
        default: "number"
        }
    }

    private func bump() { tick += 1 }

    private func loadChannels() async {
        do {
            channels = try await client.channels(orgSlug: org.slug)
            phase = .ready
            if !channels.contains(where: { $0.id == selection }) {
                selection = (channels.first { $0.kind == "org" } ?? channels.first)?.id
            }
        } catch {
            if !Task.isCancelled { phase = Phase(error) }
        }
    }
}

private struct MessagesPane: View {
    let client: APIClient
    let channel: Channel
    let tick: Int
    let channelsChanged: () async -> Void

    @State private var messages: [Message] = []
    @State private var hasOlder = false
    @State private var phase = Phase.loading
    @State private var atBottom = true
    @State private var loadingOlder = false
    @State private var thread: Message?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if hasOlder {
                            Button("Load earlier") { Task { await loadOlder(proxy) } }
                                .disabled(loadingOlder)
                                .frame(maxWidth: .infinity)
                        }
                        ForEach(messages) { message in row(message) }
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { atBottom = true }
                            .onDisappear { atBottom = false }
                    }
                    .padding()
                }
                .onChange(of: messages.last?.id) { _, _ in
                    if atBottom { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .overlay {
                    if phase != .ready {
                        PhaseView(phase: phase) { Task { await load() } }
                    } else if messages.isEmpty {
                        ContentUnavailableView("No messages yet", systemImage: "text.bubble")
                    }
                }
                .task(id: channel.id) {
                    messages = []
                    thread = nil
                    atBottom = true
                    phase = .loading
                    await load()
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                .task(id: tick) { if tick > 0 { await load() } }
            }
            Divider()
            Composer(label: "Message #\(channel.name)") { text in
                _ = try await client.postMessage(channelId: channel.id, body: text)
                atBottom = true
                await load()
            }
        }
        .inspector(isPresented: Binding(get: { thread != nil }, set: { if !$0 { thread = nil } })) {
            if let root = thread {
                ThreadPanel(client: client, root: root, tick: tick) { thread = nil }
                    .inspectorColumnWidth(min: 260, ideal: 320, max: 460)
            }
        }
    }

    private func row(_ message: Message) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(message.author?.displayName ?? "Unknown") · \(message.created.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
            Text(message.body).textSelection(.enabled)
            Button(message.replyCount > 0 ? "\(message.replyCount) \(message.replyCount == 1 ? "reply" : "replies")" : "Reply") {
                thread = message
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .accessibilityLabel(message.replyCount > 0 ? "Open thread, \(message.replyCount) replies" : "Reply in thread")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func load() async {
        do {
            let latest = try await client.messages(channelId: channel.id, limit: pageSize)
            if messages.isEmpty { hasOlder = latest.count >= pageSize }
            // Keep pages the user loaded earlier and messages a busy channel pushed out of the latest window.
            messages = merged(messages, latest)
            phase = .ready
            try? await client.markRead(channelId: channel.id)
            await channelsChanged()
        } catch {
            if !Task.isCancelled { phase = Phase(error) }
        }
    }

    private func loadOlder(_ proxy: ScrollViewProxy) async {
        guard let oldest = messages.first else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await client.messages(channelId: channel.id, before: oldest.cursor, limit: pageSize)
            hasOlder = page.count >= pageSize
            messages = merged(messages, page)
            proxy.scrollTo(oldest.id, anchor: .top)
        } catch {
            phase = Phase(error)
        }
    }
}

private struct ThreadPanel: View {
    let client: APIClient
    let root: Message
    let tick: Int
    let close: () -> Void

    @State private var replies: [Message] = []
    @State private var phase = Phase.loading

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Thread").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Close Thread", systemImage: "xmark", action: close).labelStyle(.iconOnly).buttonStyle(.borderless)
            }
            .padding()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    entry(root)
                    Divider()
                    ForEach(replies) { entry($0) }
                }
                .padding(.horizontal)
            }
            .overlay { if phase != .ready { PhaseView(phase: phase) { Task { await load() } } } }
            Divider()
            Composer(label: "Reply in thread") { text in
                _ = try await client.postMessage(channelId: root.channelId, body: text, threadRootId: root.id)
                await load()
            }
        }
        .task(id: "\(root.id)-\(tick)") { await load() }
    }

    private func entry(_ message: Message) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(message.author?.displayName ?? "Unknown") · \(message.created.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
            Text(message.body).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func load() async {
        do {
            replies = try await client.messages(channelId: root.channelId, thread: root.id, limit: 200)
            phase = .ready
        } catch {
            if !Task.isCancelled { phase = Phase(error) }
        }
    }
}

/// Return sends, Shift-Return makes a newline. The text stays when sending fails.
private struct Composer: View {
    let label: String
    let send: (String) async throws -> Void

    @State private var text = ""
    @State private var sending = false
    @State private var error: String?

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            HStack(alignment: .bottom) {
                TextEditor(text: $text)
                    .frame(minHeight: 36, maxHeight: 120)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty { Text(label).foregroundStyle(.secondary).padding(.horizontal, 5).padding(.vertical, 8).allowsHitTesting(false) }
                    }
                    .accessibilityLabel(label)
                    .disabled(sending)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        submit()
                        return .handled
                    }
                Button("Send", systemImage: "paperplane", action: submit)
                    .labelStyle(.iconOnly)
                    .disabled(sending || trimmed.isEmpty)
            }
        }
        .padding(8)
    }

    private func submit() {
        let body = trimmed
        guard !body.isEmpty, !sending else { return }
        sending = true
        Task {
            do {
                try await send(body)
                text = ""
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            sending = false
        }
    }
}

struct NameSheet: View {
    let title: String
    let field: String
    let create: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Text(title).font(.headline)
            TextField(field, text: $name)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create") {
                    busy = true
                    Task {
                        do { try await create(name.trimmingCharacters(in: .whitespaces)); dismiss() } catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding()
        .frame(width: 360)
    }
}
