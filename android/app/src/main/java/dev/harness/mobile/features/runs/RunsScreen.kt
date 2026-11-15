package dev.harness.mobile.features.runs

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.harness.mobile.core.model.RunView
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StatusBadge
import dev.harness.mobile.theme.StudioNorthTheme
import okhttp3.OkHttpClient

@Composable
fun RunsScreen(
    session: SessionRepository,
    modifier: Modifier = Modifier,
    baseUrl: String = "http://127.0.0.1:4100",
    customClient: OkHttpClient? = null,
    focusedRunId: String? = null,
    viewModel: RunsViewModel? = null
) {
    val vm = viewModel ?: viewModel(key = baseUrl) {
        RunsViewModel(session = session, baseUrl = baseUrl, customClient = customClient)
    }
    val uiState by vm.uiState.collectAsState()
    val colors = StudioNorthTheme.colors
    var showStartSheet by remember { mutableStateOf(false) }

    LaunchedEffect(focusedRunId) {
        if (!focusedRunId.isNullOrBlank()) {
            vm.selectRun(focusedRunId)
        }
    }
    LaunchedEffect(Unit) {
        vm.loadData()
    }

    if (uiState.selectedRunId != null && uiState.selectedRunDetail != null) {
        RunTranscriptView(
            runDetail = uiState.selectedRunDetail!!,
            inlineApprovals = uiState.inlineApprovals,
            isAutoScroll = uiState.isAutoScroll,
            onToggleAutoScroll = { vm.toggleAutoScroll() },
            onBack = { vm.selectRun(null) },
            onKillRun = { vm.killRun(it) },
            onDecideApproval = { id, dec -> vm.decideInlineApproval(id, dec) },
            isKilling = uiState.isKillingRun,
            modifier = modifier
        )
        return
    }

    if (showStartSheet) {
        StartRunBottomSheet(
            onDismiss = { showStartSheet = false },
            onSubmit = { agentId, repo, prompt, model ->
                vm.startRun(agentId, repo, prompt, model)
                showStartSheet = false
            },
            isLoading = uiState.isStartingRun,
            haltedError = uiState.startRunHaltedError
        )
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
            .padding(16.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = if (uiState.isInstanceAdmin) "Agent Runs" else "Org Wakeups",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )

                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (uiState.isLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.width(18.dp).height(18.dp),
                            strokeWidth = 2.dp,
                            color = colors.brand
                        )
                        Spacer(modifier = Modifier.width(10.dp))
                    }
                    if (uiState.isInstanceAdmin) {
                        ActionPill(
                            text = "+ New Run",
                            onClick = { showStartSheet = true }
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Non-instance admin fallback explanation banner
            if (!uiState.isInstanceAdmin) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.surfaceRaised)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(14.dp)
                ) {
                    Column {
                        Text(
                            text = "Instance Admin Restricted",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            color = colors.ink
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "Agent runs and live execution transcripts require Instance Admin privileges. Showing organization wakeups for active workspace.",
                            fontSize = 13.sp,
                            color = colors.inkMuted
                        )
                    }
                }
                Spacer(modifier = Modifier.height(12.dp))

                if (uiState.wakeups.isEmpty()) {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(top = 32.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(text = "No wakeups recorded for this organization.", color = colors.inkMuted, fontSize = 14.sp)
                    }
                } else {
                    LazyColumn(modifier = Modifier.fillMaxWidth()) {
                        items(uiState.wakeups, key = { it.id }) { wakeup ->
                            WakeupCard(
                                wakeup = wakeup,
                                canWake = uiState.canWakeMembers,
                                onWake = { vm.wakeMember(wakeup.memberId, wakeup.taskId) }
                            )
                            Spacer(modifier = Modifier.height(10.dp))
                        }
                    }
                }
                return@Box
            }

            // Filter Tab: Active vs All
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                    .background(colors.surfaceRaised)
                    .padding(4.dp)
            ) {
                val isActive = uiState.filter == RunsFilter.ACTIVE
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(if (isActive) colors.surface else colors.surfaceRaised)
                        .clickable { vm.setFilter(RunsFilter.ACTIVE) }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "Active",
                        fontSize = 14.sp,
                        fontWeight = if (isActive) FontWeight.Bold else FontWeight.Medium,
                        color = colors.ink
                    )
                }

                val isAll = uiState.filter == RunsFilter.ALL
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(if (isAll) colors.surface else colors.surfaceRaised)
                        .clickable { vm.setFilter(RunsFilter.ALL) }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "All Runs",
                        fontSize = 14.sp,
                        fontWeight = if (isAll) FontWeight.Bold else FontWeight.Medium,
                        color = colors.ink
                    )
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            val displayedRuns = if (uiState.filter == RunsFilter.ACTIVE) {
                uiState.runs.filter { it.state in listOf("running", "starting", "queued") }
            } else {
                uiState.runs
            }

            if (displayedRuns.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(top = 32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (uiState.filter == RunsFilter.ACTIVE) "No active runs currently executing." else "No runs found.",
                        color = colors.inkMuted,
                        fontSize = 14.sp
                    )
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(displayedRuns, key = { it.id }) { run ->
                        RunCard(run = run, onClick = { vm.selectRun(run.id) })
                        Spacer(modifier = Modifier.height(10.dp))
                    }
                }
            }
        }
    }
}

@Composable
fun RunCard(run: RunView, onClick: () -> Unit) {
    val colors = StudioNorthTheme.colors
    RaisedCard(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() }
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "${run.agentId}${run.model?.let { " : $it" } ?: ""}",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            StatusBadge(status = run.state)
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "${run.repo.substringAfterLast('/')}${run.branch?.let { " ($it)" } ?: ""}",
            fontSize = 13.sp,
            color = colors.link,
            fontWeight = FontWeight.Medium
        )
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = run.prompt,
            fontSize = 13.sp,
            color = colors.inkMuted,
            maxLines = 2
        )
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "Tokens: ${run.inputTokens} in / ${run.outputTokens} out",
                fontSize = 11.sp,
                color = colors.inkMuted
            )
            Text(
                text = "View Transcript ↗",
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.brand
            )
        }
    }
}

@Composable
fun WakeupCard(wakeup: WakeupView, canWake: Boolean, onWake: () -> Unit) {
    val colors = StudioNorthTheme.colors
    RaisedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Reason: ${wakeup.reason}",
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            StatusBadge(status = wakeup.status)
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "Member: ${wakeup.memberId}${wakeup.taskNumber?.let { " • Task #$it" } ?: ""}",
            fontSize = 13.sp,
            color = colors.inkMuted
        )
        if (canWake && wakeup.status == "pending") {
            Spacer(modifier = Modifier.height(8.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                ActionPill(
                    text = "Wake Now",
                    onClick = onWake,
                    modifier = Modifier.height(36.dp)
                )
            }
        }
    }
}
