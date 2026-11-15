import SwiftUI

public struct RootShellView: View {
    @Bindable var store: AppSessionStore

    public init(store: AppSessionStore) {
        self.store = store
    }

    public var body: some View {
        VStack(spacing: 0) {
            headerBar

            TabView(selection: $store.selectedTab) {
                ApprovalsRootView(store: store)
                    .tabItem {
                        Label(AppTab.approvals.title, systemImage: AppTab.approvals.icon)
                            .accessibilityIdentifier("tab.approvals")
                    }
                    .tag(AppTab.approvals)

                BoardRootView(store: store)
                    .tabItem {
                        Label(AppTab.board.title, systemImage: AppTab.board.icon)
                            .accessibilityIdentifier("tab.board")
                    }
                    .tag(AppTab.board)

                RunsRootView(store: store)
                    .tabItem {
                        Label(AppTab.runs.title, systemImage: AppTab.runs.icon)
                            .accessibilityIdentifier("tab.runs")
                    }
                    .tag(AppTab.runs)

                ChatRootView(store: store)
                    .tabItem {
                        Label(AppTab.chat.title, systemImage: AppTab.chat.icon)
                            .accessibilityIdentifier("tab.chat")
                    }
                    .tag(AppTab.chat)

                WorkspaceRootView(store: store)
                    .tabItem {
                        Label(AppTab.workspace.title, systemImage: AppTab.workspace.icon)
                            .accessibilityIdentifier("tab.workspace")
                    }
                    .tag(AppTab.workspace)
            }
            .tint(StudioNorthTheme.ink)
        }
        .sheet(isPresented: $store.isPairingSheetPresented) {
            PairEnrollView(store: store)
        }
        .sheet(isPresented: $store.isHaltSheetPresented) {
            HaltConfirmSheet(store: store)
        }
    }

    private var headerBar: some View {
        HStack(spacing: 12) {
            Menu {
                ForEach(store.instances) { instance in
                    Button {
                        store.switchInstance(to: instance.id)
                    } label: {
                        HStack {
                            Text(instance.origin)
                            if instance.id == store.activeInstanceId {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
                Divider()
                Button {
                    store.isPairingSheetPresented = true
                } label: {
                    Label("Pair New Instance...", systemImage: "plus")
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "server.rack")
                        .font(.caption)
                    Text(instanceDisplayName)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                }
                .foregroundStyle(StudioNorthTheme.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(StudioNorthTheme.surfaceRaised)
                .clipShape(Capsule())
            }
            .accessibilityLabel("Select instance")
            .accessibilityIdentifier("header.instancePicker")

            if let active = store.activeInstance, !active.orgs.isEmpty {
                Menu {
                    ForEach(active.orgs) { org in
                        Button {
                            store.selectOrg(slug: org.slug)
                        } label: {
                            HStack {
                                Text(org.name)
                                if org.slug == active.selectedOrgSlug {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(active.orgs.first(where: { $0.slug == active.selectedOrgSlug })?.name ?? "Org")
                            .font(.subheadline)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                    }
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                }
                .accessibilityLabel("Select organization")
                .accessibilityIdentifier("header.orgPicker")
            }

            Spacer()

            if store.isInstanceAdmin {
                ActionPill(
                    title: store.isHalted ? "Halted" : "Halt",
                    icon: store.isHalted ? "play.fill" : "pause.fill",
                    isDestructive: true
                ) {
                    store.isHaltSheetPresented = true
                }
                .accessibilityLabel(store.isHalted ? "Resume instance" : "Halt instance")
                .accessibilityIdentifier("button.halt")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(StudioNorthTheme.surface)
        .overlay(
            HairlineDivider(),
            alignment: .bottom
        )
    }

    private var instanceDisplayName: String {
        guard let origin = store.activeInstance?.origin else { return "No Instance" }
        return origin
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
    }
}
