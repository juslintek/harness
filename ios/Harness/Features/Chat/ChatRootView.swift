import SwiftUI

public struct ChatRootView: View {
    public let store: AppSessionStore
    @State private var chatStore: ChatStore?
    @State private var selectedChannel: ChatChannel?

    public init(store: AppSessionStore) {
        self.store = store
    }

    private var currentOrgSlug: String {
        store.activeInstance?.selectedOrgSlug ?? "personal"
    }

    private var currentOrgId: String {
        let active = store.activeInstance
        let matched = active?.orgs.first(where: { $0.slug == currentOrgSlug })
        return matched?.id ?? active?.orgs.first?.id ?? ""
    }

    public var body: some View {
        NavigationStack {
            Group {
                if let cs = chatStore {
                    channelListView(cs)
                } else {
                    ProgressView()
                }
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("Chat")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            chatStore?.isNewDmPresented = true
                        } label: {
                            Label("New Direct Message", systemImage: "bubble.left")
                        }
                        Button {
                            chatStore?.isNewGroupPresented = true
                        } label: {
                            Label("New Group", systemImage: "person.2")
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.body.weight(.bold))
                            .foregroundStyle(StudioNorthTheme.link)
                    }
                    .accessibilityLabel("New conversation")
                    .accessibilityIdentifier("chat.newMenu")
                }
            }
            .sheet(isPresented: Binding(
                get: { chatStore?.isNewDmPresented ?? false },
                set: { chatStore?.isNewDmPresented = $0 }
            )) {
                if let cs = chatStore {
                    ChatNewDmSheet(store: cs, slug: currentOrgSlug)
                }
            }
            .sheet(isPresented: Binding(
                get: { chatStore?.isNewGroupPresented ?? false },
                set: { chatStore?.isNewGroupPresented = $0 }
            )) {
                if let cs = chatStore {
                    ChatNewGroupSheet(store: cs, slug: currentOrgSlug)
                }
            }
            .navigationDestination(item: $selectedChannel) { channel in
                if let cs = chatStore {
                    ChatChannelDetailView(channel: channel, store: cs)
                }
            }
        }
        .task {
            initChatStore()
            await refreshData()
        }
        .onChange(of: store.activeInstanceId) { _, _ in
            initChatStore()
            Task { await refreshData() }
        }
        .task(id: store.pendingDeepLink) {
            if let url = store.pendingDeepLink, let cs = chatStore {
                let handled = await cs.handleDeepLink(url: url, orgSlug: currentOrgSlug)
                if handled, let active = cs.activeChannel {
                    selectedChannel = active
                    store.pendingDeepLink = nil
                }
            }
        }
        .onDisappear {
            chatStore?.stopRealtime()
        }
    }

    private func initChatStore() {
        chatStore?.stopRealtime()
        let client = store.currentAPIClient()
        let activeInstance = store.activeInstance
        let cs = ChatStore(
            apiClient: client,
            currentSlug: currentOrgSlug,
            currentMemberId: activeInstance?.user.id
        )
        self.chatStore = cs
    }

    private func refreshData() async {
        guard let cs = chatStore else { return }
        await cs.loadChannels(slug: currentOrgSlug)
        await cs.loadOrgDirectory(slug: currentOrgSlug)
        if !currentOrgId.isEmpty {
            cs.subscribeToRealtime(orgId: currentOrgId)
        }
    }

    private func channelListView(_ cs: ChatStore) -> some View {
        List {
            Section {
                if cs.generalChannels.isEmpty && !cs.isLoading {
                    Text("No channels found")
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                        .listRowBackground(StudioNorthTheme.surface)
                } else {
                    ForEach(cs.generalChannels) { channel in
                        channelRow(channel, cs: cs)
                    }
                }
            } header: {
                HStack {
                    Text("Channels")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                    Spacer()
                    Button {
                        cs.isNewGroupPresented = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(StudioNorthTheme.link)
                    }
                }
            }

            Section {
                if cs.directMessages.isEmpty && !cs.isLoading {
                    Text("No direct messages")
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                        .listRowBackground(StudioNorthTheme.surface)
                } else {
                    ForEach(cs.directMessages) { channel in
                        channelRow(channel, cs: cs)
                    }
                }
            } header: {
                HStack {
                    Text("Direct Messages")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                    Spacer()
                    Button {
                        cs.isNewDmPresented = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(StudioNorthTheme.link)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable {
            await refreshData()
        }
    }

    private func channelRow(_ channel: ChatChannel, cs: ChatStore) -> some View {
        Button {
            selectedChannel = channel
        } label: {
            HStack(spacing: 10) {
                Image(systemName: channel.kind == "dm" ? "person.crop.circle" : "number")
                    .font(.body)
                    .foregroundStyle(StudioNorthTheme.inkMuted)

                Text(channel.name)
                    .font(.body.weight(channel.unread > 0 ? .bold : .regular))
                    .foregroundStyle(StudioNorthTheme.ink)

                Spacer()

                if channel.unread > 0 {
                    Circle()
                        .fill(StudioNorthTheme.accent)
                        .frame(width: 8, height: 8)
                }

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(StudioNorthTheme.surfaceRaised)
        .accessibilityIdentifier("chat.channel.\(channel.id)")
    }
}
