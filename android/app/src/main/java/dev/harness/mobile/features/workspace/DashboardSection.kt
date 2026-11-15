package dev.harness.mobile.features.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.DashboardMember
import dev.harness.mobile.core.model.DashboardQuota
import dev.harness.mobile.core.model.DashboardTask
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StatusBadge
import dev.harness.mobile.theme.StudioNorthTheme
import java.util.Locale

@Composable
fun DashboardSection(
    state: DashboardState,
    onSelectRange: (DashboardTimeRange) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 12.dp)
    ) {
        // Range Selector Row
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DashboardTimeRange.entries.forEach { range ->
                        val isSelected = state.selectedRange == range
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                                .background(if (isSelected) colors.brand else colors.surfaceRaised)
                                .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                                .clickable { onSelectRange(range) }
                                .padding(horizontal = 16.dp, vertical = 6.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = range.label,
                                fontSize = 13.sp,
                                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                                color = if (isSelected) colors.onBrand else colors.ink
                            )
                        }
                    }
                }
                Text(
                    text = "Refresh",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.link,
                    modifier = Modifier
                        .clickable { onRefresh() }
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                )
            }
        }

        if (state.isLoading) {
            item {
                Box(modifier = Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.brand, strokeWidth = 2.dp)
                }
            }
        }

        state.error?.let { err ->
            item {
                RaisedCard(modifier = Modifier.fillMaxWidth()) {
                    Text(text = err, color = colors.danger, fontSize = 13.sp)
                }
            }
        }

        // Summary Card
        val dash = state.dashboard
        if (dash != null) {
            item {
                RaisedCard(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = "Compute & Spend Overview",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.ink
                    )
                    Spacer(modifier = Modifier.height(10.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column {
                            Text(text = "Total Spend", fontSize = 12.sp, color = colors.inkMuted)
                            Text(
                                text = String.format(Locale.US, "$%.2f", state.totalSpendUsd),
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Bold,
                                color = colors.ink
                            )
                        }
                        Column {
                            Text(text = "Runs Completed", fontSize = 12.sp, color = colors.inkMuted)
                            Text(
                                text = "${state.totalCompleted} / ${state.totalRuns}",
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Bold,
                                color = colors.ink
                            )
                        }
                        Column {
                            Text(text = "Tokens In/Out", fontSize = 12.sp, color = colors.inkMuted)
                            Text(
                                text = "${state.totalInputTokens / 1000}k / ${state.totalOutputTokens / 1000}k",
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.ink
                            )
                        }
                    }
                }
            }

            // Quotas
            if (dash.quota.isNotEmpty()) {
                item {
                    Text(
                        text = "Provider Quotas",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.inkMuted
                    )
                }
                items(dash.quota) { quota ->
                    QuotaCard(quota = quota)
                }
            }

            // Member Stats
            if (dash.members.isNotEmpty()) {
                item {
                    Text(
                        text = "Team Members (${dash.members.size})",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.inkMuted
                    )
                }
                items(dash.members) { member ->
                    MemberStatCard(member = member)
                }
            }

            // Active Tasks
            if (dash.tasks.isNotEmpty()) {
                item {
                    Text(
                        text = "Active Tasks (${dash.tasks.size})",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.inkMuted
                    )
                }
                items(dash.tasks) { task ->
                    DashboardTaskCard(task = task)
                }
            }
        }
    }
}

@Composable
private fun QuotaCard(quota: DashboardQuota) {
    val colors = StudioNorthTheme.colors
    val used = quota.usedPercent ?: 0.0
    val pct = (used.coerceIn(0.0, 100.0) / 100.0).toFloat()

    RaisedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "${quota.provider.uppercase()} (${quota.window})",
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.ink
            )
            Text(
                text = quota.usedPercent?.let { "$it% used" } ?: "N/A",
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                color = if (pct > 0.85f) colors.danger else colors.ink
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(CircleShape)
                .background(colors.border)
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(pct)
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(if (pct > 0.85f) colors.danger else colors.brand)
            )
        }
    }
}

@Composable
private fun MemberStatCard(member: DashboardMember) {
    val colors = StudioNorthTheme.colors

    RaisedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "@${member.handle}",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            Text(
                text = String.format(Locale.US, "$%.2f", member.costUsd),
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.ink
            )
        }
        Spacer(modifier = Modifier.height(6.dp))
        Text(
            text = "Runs: ${member.runs} (completed ${member.completed}) • Tasks done: ${member.tasksDone}",
            fontSize = 12.sp,
            color = colors.inkMuted
        )
        Text(
            text = "Tokens: ${member.inputTokens} in / ${member.outputTokens} out (${member.cacheReadTokens} cached)",
            fontSize = 12.sp,
            color = colors.inkMuted
        )
        if (member.tools.isNotEmpty()) {
            Spacer(modifier = Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                member.tools.forEach { tool ->
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                            .background(colors.surface)
                            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                            .padding(horizontal = 8.dp, vertical = 2.dp)
                    ) {
                        Text(text = "${tool.name} (${tool.count})", fontSize = 11.sp, color = colors.ink)
                    }
                }
            }
        }
        if (member.stack.isNotEmpty()) {
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "Stack: " + member.stack.joinToString(", "),
                fontSize = 11.sp,
                color = colors.inkMuted
            )
        }
    }
}

@Composable
private fun DashboardTaskCard(task: DashboardTask) {
    val colors = StudioNorthTheme.colors

    RaisedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "#${task.number} ${task.title}",
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                color = colors.ink,
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(8.dp))
            StatusBadge(status = task.status)
        }
        Spacer(modifier = Modifier.height(6.dp))
        HairlineDivider()
        Spacer(modifier = Modifier.height(6.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(text = "Assignee: ${task.assignee?.let { "@$it" } ?: "unassigned"}", fontSize = 12.sp, color = colors.inkMuted)
            Text(
                text = "Active: ${task.agentActiveMinutes ?: 0}m (P: ${task.plannerMinutes ?: 0}m, R: ${task.reviewerMinutes ?: 0}m)",
                fontSize = 12.sp,
                color = colors.inkMuted
            )
        }
    }
}
