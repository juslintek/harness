import SwiftUI

public struct ApprovalsRootView: View {
    public let store: AppSessionStore
    @State private var approvalsStore: ApprovalsStore

    public init(store: AppSessionStore) {
        self.store = store
        self._approvalsStore = State(initialValue: ApprovalsStore(sessionStore: store))
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !approvalsStore.canManageApprovals {
                    restrictedEmptyState
                } else {
                    mainContent
                }
            }
            .background(StudioNorthTheme.surface)
            .navigationTitle("Approvals")
            .sheet(item: $approvalsStore.focusedApproval) { approval in
                ApprovalDetailSheet(
                    approval: approval,
                    store: approvalsStore,
                    onDismiss: {
                        approvalsStore.focusedApproval = nil
                    },
                    onJumpToRun: { runId in
                        store.selectedTab = .runs
                    }
                )
            }
            .task(id: "\(store.activeInstanceId ?? "none"):\(store.activeInstance?.selectedOrgSlug ?? "none")") {
                await approvalsStore.refresh()
                approvalsStore.startRealtime()
            }
            .onDisappear {
                approvalsStore.stopRealtime()
            }
            .task(id: store.pendingDeepLink) {
                if let url = store.pendingDeepLink {
                    await approvalsStore.handleDeepLink(url: url)
                }
            }
        }
    }

    @ViewBuilder
    private var mainContent: some View {
        VStack(spacing: 12) {
            filterSegment

            if let banner = approvalsStore.bannerMessage {
                bannerView(message: banner, isError: approvalsStore.bannerIsError)
            }

            ScrollView {
                LazyVStack(spacing: 12) {
                    let items = approvalsStore.selectedFilter == .pending
                        ? approvalsStore.pendingApprovals
                        : approvalsStore.resolvedApprovals

                    if items.isEmpty {
                        emptyFilterState
                    } else {
                        ForEach(items) { approval in
                            ApprovalCardView(
                                approval: approval,
                                store: approvalsStore,
                                onJumpToRun: { _ in
                                    store.selectedTab = .runs
                                }
                            )
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
            }
            .refreshable {
                await approvalsStore.refresh()
            }
        }
    }

    private var filterSegment: some View {
        HStack(spacing: 8) {
            ForEach(ApprovalFilter.allCases) { filter in
                Button {
                    approvalsStore.selectedFilter = filter
                    Task {
                        await approvalsStore.refresh()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(filter.rawValue)
                            .font(.subheadline.weight(.semibold))

                        if filter == .pending && !approvalsStore.pendingApprovals.isEmpty {
                            Text("\(approvalsStore.pendingApprovals.count)")
                                .font(.caption2.bold())
                                .foregroundStyle(StudioNorthTheme.onBrand)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(StudioNorthTheme.accent)
                                .clipShape(Capsule())
                        }
                    }
                    .foregroundStyle(approvalsStore.selectedFilter == filter ? StudioNorthTheme.onBrand : StudioNorthTheme.ink)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(approvalsStore.selectedFilter == filter ? StudioNorthTheme.brand : StudioNorthTheme.surfaceRaised)
                    .clipShape(Capsule())
                    .overlay(
                        Capsule()
                            .stroke(StudioNorthTheme.border, lineWidth: approvalsStore.selectedFilter == filter ? 0 : 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("approvals.filter.\(filter.rawValue.lowercased())")
            }

            Spacer()

            StatusBadge(text: store.currentOrgRole, color: StudioNorthTheme.link)
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    private func bannerView(message: String, isError: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(isError ? StudioNorthTheme.danger : StudioNorthTheme.link)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(StudioNorthTheme.ink)
            Spacer()
            Button {
                approvalsStore.bannerMessage = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
            }
            .accessibilityLabel("Dismiss banner")
        }
        .padding(12)
        .background((isError ? StudioNorthTheme.danger : StudioNorthTheme.link).opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
        .overlay(
            RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm)
                .stroke((isError ? StudioNorthTheme.danger : StudioNorthTheme.link).opacity(0.3), lineWidth: 1)
        )
        .padding(.horizontal)
    }

    private var restrictedEmptyState: some View {
        VStack(spacing: 16) {
            Spacer()

            RaisedCard {
                VStack(spacing: 12) {
                    Image(systemName: "lock.shield")
                        .font(.system(size: 36))
                        .foregroundStyle(StudioNorthTheme.inkMuted)

                    Text("Admin Access Required")
                        .font(.headline)
                        .foregroundStyle(StudioNorthTheme.ink)

                    Text("Guard approval escalations are restricted to Organization Admins and Instance Administrators. Sign in with an administrative role to review commands.")
                        .font(.subheadline)
                        .foregroundStyle(StudioNorthTheme.inkMuted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .padding(.horizontal)

            Spacer()
        }
    }

    private var emptyFilterState: some View {
        RaisedCard {
            VStack(spacing: 8) {
                Text(approvalsStore.selectedFilter == .pending ? "No Pending Approvals" : "No Resolved Approvals")
                    .font(.headline)
                    .foregroundStyle(StudioNorthTheme.ink)

                Text(approvalsStore.selectedFilter == .pending
                     ? "Agents are executing autonomously inside security boundaries. Escalations requiring human authorization will appear here in real time."
                     : "Approved, denied, and expired approval audit records will be listed here.")
                    .font(.subheadline)
                    .foregroundStyle(StudioNorthTheme.inkMuted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
        .padding(.top, 16)
    }
}
