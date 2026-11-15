import SwiftUI

private enum WorkspaceHubSection: String, CaseIterable, Identifiable {
    case dashboard = "Dashboard"
    case memory = "Memory Vault"
    case account = "Account"
    case admin = "Admin Web"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .dashboard: return "chart.bar"
        case .memory: return "brain.head.profile"
        case .account: return "person.crop.circle"
        case .admin: return "arrow.up.right.square"
        }
    }
}

public struct WorkspaceRootView: View {
    public let store: AppSessionStore
    @State private var selectedSection: WorkspaceHubSection = .dashboard

    public init(store: AppSessionStore) {
        self.store = store
    }

    private var activeInstance: InstanceRecord? {
        store.activeInstance
    }

    private var activeOrgSlug: String {
        activeInstance?.selectedOrgSlug ?? "personal"
    }

    private var activeOrgId: String? {
        activeInstance?.orgs.first(where: { $0.slug == activeOrgSlug })?.id
    }

    private var isOrgAdmin: Bool {
        store.currentOrgRole == "admin" || store.currentOrgRole == "owner"
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Top Segment Bar
                Picker("Workspace Section", selection: $selectedSection) {
                    ForEach(WorkspaceHubSection.allCases) { section in
                        Text(section.rawValue).tag(section)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(StudioNorthTheme.surface)
                .accessibilityIdentifier("workspace.sectionPicker")

                HairlineDivider()

                // Content View
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        switch selectedSection {
                        case .dashboard:
                            let dashboardStore = DashboardStore(
                                apiClient: store.currentAPIClient(),
                                orgSlug: activeOrgSlug,
                                orgId: activeOrgId
                            )
                            DashboardSectionView(store: dashboardStore)

                        case .memory:
                            let memoryStore = MemoryStore(
                                apiClient: store.currentAPIClient(),
                                orgSlug: activeOrgSlug,
                                orgId: activeOrgId,
                                isOrgAdmin: isOrgAdmin,
                                isInstanceAdmin: store.isInstanceAdmin
                            )
                            MemoryVaultView(store: memoryStore)

                        case .account:
                            let accountStore = AccountStore(
                                apiClient: store.currentAPIClient(),
                                orgSlug: activeOrgSlug,
                                sessionStore: store
                            )
                            AccountSettingsView(store: accountStore)

                        case .admin:
                            AdminWebLinksSection(
                                origin: activeInstance?.origin ?? "https://harness.local",
                                orgSlug: activeOrgSlug,
                                isInstanceAdmin: store.isInstanceAdmin
                            )
                        }
                    }
                    .padding(.vertical, 12)
                }
                .background(StudioNorthTheme.surface)
            }
            .navigationTitle("Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    StatusBadge(text: activeOrgSlug, color: StudioNorthTheme.accent)
                }
            }
        }
    }
}
