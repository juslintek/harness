import SwiftUI

public struct BoardRootView: View {
    public let store: AppSessionStore
    @State private var boardStore: BoardStore

    @State private var selectedTaskForDetail: BoardTask?
    @State private var scrollTargetStatus: TaskStatus?

    public init(store: AppSessionStore) {
        self.store = store
        _boardStore = State(initialValue: BoardStore(
            apiClient: store.currentAPIClient(),
            currentMemberId: store.activeInstance?.user.id
        ))
    }

    private var isUserAdmin: Bool {
        store.isInstanceAdmin || ["admin", "orgAdmin", "owner"].contains(store.currentOrgRole)
    }

    private var activeOrgSlug: String {
        store.activeInstance?.selectedOrgSlug ?? "personal"
    }

    private var activeOrgId: String {
        store.activeInstance?.orgs.first(where: { $0.slug == activeOrgSlug })?.id ?? activeOrgSlug
    }

    public var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                VStack(spacing: 12) {
                    // Top Bar: Project chips + New Task CTA
                    topBar

                    // Danger Banner for 409 Move Failures / Errors
                    if let banner = boardStore.bannerMessage {
                        dangerBanner(banner)
                    }

                    // Assignee Filter Bar
                    assigneeFilterBar

                    // Status Jump Pills
                    statusJumpBar(proxy: proxy)

                    // Horizontal Paged Columns
                    columnsPagedView
                }
                .padding(.vertical, 8)
                .background(StudioNorthTheme.surface)
                .navigationTitle("Board")
                .navigationBarTitleDisplayMode(.inline)
            }
        }
        .sheet(isPresented: $boardStore.isNewTaskSheetPresented) {
            NewTaskSheet(store: boardStore)
        }
        .sheet(item: $selectedTaskForDetail) { task in
            TaskDetailSheet(
                taskId: task.id,
                boardStore: boardStore,
                isUserAdmin: isUserAdmin
            )
        }
        .task(id: "\(store.activeInstanceId ?? "none"):\(activeOrgSlug)") {
            boardStore.apiClient = store.currentAPIClient()
            boardStore.currentMemberId = store.activeInstance?.user.id
            await boardStore.loadProjects(for: activeOrgSlug)
            boardStore.subscribeToRealtime(orgId: activeOrgId)
        }
        .onDisappear {
            boardStore.stopRealtime()
        }
    }

    private var topBar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(boardStore.projects) { project in
                        Button {
                            Task { await boardStore.selectProject(project) }
                        } label: {
                            Text(project.key)
                                .font(.caption.weight(.bold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(boardStore.selectedProject?.id == project.id ? StudioNorthTheme.brand : StudioNorthTheme.surfaceRaised)
                                .foregroundStyle(boardStore.selectedProject?.id == project.id ? StudioNorthTheme.onBrand : StudioNorthTheme.ink)
                                .clipShape(Capsule())
                                .overlay(
                                    Capsule().stroke(StudioNorthTheme.border, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("board.project.\(project.key)")
                    }
                }
                .padding(.horizontal, 16)
            }

            ActionPill(title: "New Task", icon: "plus") {
                boardStore.isNewTaskSheetPresented = true
            }
            .accessibilityLabel("Create new task")
            .accessibilityIdentifier("board.newTask")
            .padding(.trailing, 16)
        }
    }

    private func dangerBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(StudioNorthTheme.onBrand)
            Text(message)
                .font(.footnote.weight(.medium))
                .foregroundStyle(StudioNorthTheme.onBrand)
                .lineLimit(2)
            Spacer()
            Button {
                boardStore.dismissBanner()
            } label: {
                Image(systemName: "xmark")
                    .foregroundStyle(StudioNorthTheme.onBrand)
            }
            .accessibilityLabel("Dismiss banner")
        }
        .padding(10)
        .background(StudioNorthTheme.danger)
        .clipShape(RoundedRectangle(cornerRadius: StudioNorthTheme.Radii.sm))
        .padding(.horizontal, 16)
    }

    private var assigneeFilterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                filterChip(title: "All", isSelected: boardStore.assigneeFilter == .all) {
                    boardStore.assigneeFilter = .all
                }

                filterChip(title: "Mine", isSelected: boardStore.assigneeFilter == .mine) {
                    boardStore.assigneeFilter = .mine
                }

                ForEach(boardStore.members) { m in
                    let isSel = boardStore.assigneeFilter == .member(id: m.id, handle: m.handle)
                    filterChip(title: "@\(m.handle)", isSelected: isSel) {
                        boardStore.assigneeFilter = .member(id: m.id, handle: m.handle)
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func filterChip(title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11, weight: isSelected ? .bold : .medium))
                .foregroundStyle(isSelected ? StudioNorthTheme.onBrand : StudioNorthTheme.inkMuted)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(isSelected ? StudioNorthTheme.ink : StudioNorthTheme.surfaceRaised)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func statusJumpBar(proxy: ScrollViewProxy) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(TaskStatus.allCases) { status in
                    Button {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            proxy.scrollTo(status, anchor: .center)
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(status.title)
                                .font(.system(size: 11, weight: .semibold))
                            Text("\(boardStore.count(for: status))")
                                .font(.system(size: 10, weight: .bold, design: .monospaced))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(StudioNorthTheme.border.opacity(0.3))
                                .clipShape(Capsule())
                        }
                        .foregroundStyle(StudioNorthTheme.ink)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(StudioNorthTheme.surfaceRaised)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule().stroke(StudioNorthTheme.border, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var columnsPagedView: some View {
        GeometryReader { geo in
            let colWidth = max(280, geo.size.width - 48)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(TaskStatus.allCases) { status in
                        BoardColumnView(
                            status: status,
                            tasks: boardStore.tasks(for: status),
                            store: boardStore,
                            onSelectTask: { task in
                                selectedTaskForDetail = task
                            },
                            onMoveTask: { taskId, targetStatus in
                                Task {
                                    do {
                                        try await boardStore.moveTask(id: taskId, to: targetStatus)
                                    } catch {
                                        // banner already surfaced by store
                                    }
                                }
                            }
                        )
                        .frame(width: colWidth)
                        .id(status)
                    }
                }
                .padding(.horizontal, 16)
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
        }
    }
}
