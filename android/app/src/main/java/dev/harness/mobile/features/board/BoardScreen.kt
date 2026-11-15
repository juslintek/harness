package dev.harness.mobile.features.board

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StudioNorthTheme
import kotlinx.coroutines.launch

@Composable
fun BoardScreen(
    session: SessionRepository,
    modifier: Modifier = Modifier,
    baseUrl: String = "http://127.0.0.1:4100",
    viewModel: BoardViewModel? = null
) {
    val colors = StudioNorthTheme.colors
    val coroutineScope = rememberCoroutineScope()
    val activeOrg by session.activeOrg.collectAsState()

    var storedToken by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        storedToken = session.getStoredToken()
    }

    val boardVm = viewModel ?: remember(activeOrg?.id, storedToken) {
        val repo = BoardHttpRepository(
            baseUrlProvider = { baseUrl },
            tokenProvider = { storedToken }
        )
        BoardViewModel(repository = repo)
    }

    val state by boardVm.state.collectAsState()

    LaunchedEffect(activeOrg?.slug, storedToken) {
        val slug = activeOrg?.slug
        if (!slug.isNullOrBlank() && (viewModel != null || !storedToken.isNullOrBlank())) {
            boardVm.load(slug)
        }
    }

    val pagerState = rememberPagerState(
        initialPage = 1,
        pageCount = { BOARD_COLUMNS.size }
    )

    var showNewTaskDialog by remember { mutableStateOf(false) }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Header: Project chips + New Task ActionPill
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                LazyRow(
                    modifier = Modifier.weight(1f).padding(end = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    items(state.projects) { proj ->
                        val isSelected = proj.id == state.selectedProjectId
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                                .background(if (isSelected) colors.surfaceRaised else colors.surface)
                                .border(
                                    1.dp,
                                    if (isSelected) colors.brand else colors.border,
                                    RoundedCornerShape(StudioNorthTheme.radius24)
                                )
                                .clickable { boardVm.selectProject(proj.id) }
                                .padding(horizontal = 12.dp, vertical = 6.dp)
                        ) {
                            Text(
                                text = proj.name.ifBlank { proj.key },
                                fontSize = 13.sp,
                                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                                color = colors.ink
                            )
                        }
                    }
                }

                ActionPill(
                    text = "New Task",
                    onClick = { showNewTaskDialog = true }
                )
            }

            // Assignee Filter Row
            if (state.members.isNotEmpty()) {
                LazyRow(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    item {
                        val isAllSelected = state.selectedAssigneeId == null
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                                .background(if (isAllSelected) colors.surfaceRaised else colors.surface)
                                .border(1.dp, if (isAllSelected) colors.brand else colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                                .clickable { boardVm.filterAssignee(null) }
                                .padding(horizontal = 8.dp, vertical = 4.dp)
                        ) {
                            Text(text = "All", fontSize = 12.sp, color = colors.ink, fontWeight = FontWeight.Medium)
                        }
                    }
                    items(state.members) { m ->
                        val isSelected = state.selectedAssigneeId == m.id
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                                .background(if (isSelected) colors.surfaceRaised else colors.surface)
                                .border(1.dp, if (isSelected) colors.brand else colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                                .clickable { boardVm.filterAssignee(m.id) }
                                .padding(horizontal = 8.dp, vertical = 4.dp)
                        ) {
                            Text(text = "@${m.handle}", fontSize = 12.sp, color = colors.ink, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }

            // Error Banner on 409 Move Failure or Error
            state.bannerNotice?.let { notice ->
                RaisedCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = notice.message,
                            color = colors.danger,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.weight(1f)
                        )
                        TextButton(onClick = { boardVm.dismissBanner() }) {
                            Text("Dismiss", color = colors.danger, fontSize = 12.sp)
                        }
                    }
                }
            }

            HairlineDivider()

            // Status Jump Tabs
            ScrollableTabRow(
                selectedTabIndex = pagerState.currentPage,
                containerColor = colors.surface,
                contentColor = colors.brand,
                edgePadding = 16.dp,
                divider = { HairlineDivider() }
            ) {
                BOARD_COLUMNS.forEachIndexed { index, status ->
                    val count = state.columnTasks[status]?.size ?: 0
                    Tab(
                        selected = pagerState.currentPage == index,
                        onClick = {
                            coroutineScope.launch { pagerState.animateScrollToPage(index) }
                        },
                        text = {
                            Text(
                                text = "${statusLabel(status)} ($count)",
                                fontSize = 13.sp,
                                fontWeight = if (pagerState.currentPage == index) FontWeight.Bold else FontWeight.Normal,
                                color = if (pagerState.currentPage == index) colors.brand else colors.inkMuted
                            )
                        }
                    )
                }
            }

            // HorizontalPager across Columns
            HorizontalPager(
                state = pagerState,
                modifier = Modifier.fillMaxSize()
            ) { page ->
                val status = BOARD_COLUMNS[page]
                val tasksInCol = state.columnTasks[status] ?: emptyList()

                if (tasksInCol.isEmpty()) {
                    Box(
                        modifier = Modifier.fillMaxSize().padding(32.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "No tasks in ${statusLabel(status)}",
                            color = colors.inkMuted,
                            fontSize = 14.sp
                        )
                    }
                } else {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = PaddingValues(vertical = 12.dp)
                    ) {
                        items(tasksInCol, key = { it.id }) { task ->
                            val subCount = state.subtaskCounts[task.id] ?: 0
                            val depCount = state.depCounts[task.id] ?: 0
                            val notice = if (state.bannerNotice?.taskId == task.id) state.bannerNotice?.message else null

                            TaskCard(
                                task = task,
                                subtaskCount = subCount,
                                depCount = depCount,
                                noticeMessage = notice,
                                onClick = { boardVm.openTaskDetail(task.id) },
                                onMove = { toStatus -> boardVm.moveTask(task.id, toStatus) }
                            )
                        }
                    }
                }
            }
        }

        // New Task Dialog
        if (showNewTaskDialog) {
            NewTaskDialog(
                members = state.members,
                onDismiss = { showNewTaskDialog = false },
                onCreate = { t, d, a, est ->
                    boardVm.createTask(title = t, description = d, assigneeId = a, estimateMinutes = est)
                    showNewTaskDialog = false
                }
            )
        }

        // Task Detail Bottom Sheet
        state.selectedTaskDetail?.let { detail ->
            TaskDetailBottomSheet(
                detail = detail,
                members = state.members,
                projectTasks = state.tasks,
                errorMessage = state.detailError,
                onDismiss = { boardVm.closeTaskDetail() },
                onSave = { t, d, est, a ->
                    boardVm.patchTask(detail.task.id, title = t, description = d, estimateMinutes = est, assigneeId = a)
                },
                onCheckout = { boardVm.checkoutTask(detail.task.id) },
                onRelease = { boardVm.releaseTask(detail.task.id) },
                onWake = { agentId -> boardVm.wakeMember(agentId, detail.task.id) },
                onAddDep = { depId -> boardVm.addDependency(detail.task.id, depId) },
                onRemoveDep = { depId -> boardVm.removeDependency(detail.task.id, depId) },
                onAddSubtask = { subTitle ->
                    boardVm.createTask(title = subTitle, parentId = detail.task.id)
                },
                onAddComment = { body -> boardVm.addComment(detail.task.id, body) }
            )
        }
    }
}
