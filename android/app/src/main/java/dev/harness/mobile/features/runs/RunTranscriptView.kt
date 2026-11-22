package dev.harness.mobile.features.runs

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.ApprovalView
import dev.harness.mobile.core.model.EventView
import dev.harness.mobile.core.model.RunDetail
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StatusBadge
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun RunTranscriptView(
    runDetail: RunDetail,
    inlineApprovals: List<ApprovalView>,
    isAutoScroll: Boolean,
    onToggleAutoScroll: () -> Unit,
    onBack: () -> Unit,
    onKillRun: (String) -> Unit,
    onDecideApproval: (id: String, decision: String) -> Unit,
    isKilling: Boolean,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    val listState = rememberLazyListState()
    val run = runDetail.run
    val events = runDetail.events

    LaunchedEffect(events.size, isAutoScroll) {
        if (isAutoScroll && events.isNotEmpty()) {
            listState.animateScrollToItem(events.size - 1)
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
            .padding(16.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            // Header Row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                SecondaryLinkButton(
                    text = "← Back to Runs",
                    onClick = onBack
                )

                if (run.state == "running" || run.state == "starting") {
                    OutlinedButton(
                        onClick = { onKillRun(run.id) },
                        enabled = !isKilling,
                        modifier = Modifier.height(40.dp),
                        shape = RoundedCornerShape(StudioNorthTheme.radius24),
                        border = BorderStroke(1.dp, colors.danger),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = colors.danger,
                            disabledContentColor = colors.inkMuted
                        ),
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp)
                    ) {
                        Text(text = "Kill Run", fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            // Run Summary Card
            RaisedCard(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "${run.agentId}${run.model?.let { " ($it)" } ?: ""}",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.ink
                    )
                    StatusBadge(status = run.state)
                }
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "${run.repo.substringAfterLast('/')}${run.branch?.let { " : $it" } ?: ""}",
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
                Text(
                    text = "Tokens: ${run.inputTokens} in / ${run.outputTokens} out",
                    fontSize = 12.sp,
                    color = colors.inkMuted
                )
            }

            // Inline Pending Guard Approvals
            if (inlineApprovals.isNotEmpty()) {
                Spacer(modifier = Modifier.height(12.dp))
                inlineApprovals.forEach { app ->
                    InlineApprovalCard(
                        approval = app,
                        onApprove = { onDecideApproval(app.id, "approve") },
                        onDeny = { onDecideApproval(app.id, "deny") }
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }
            }

            Spacer(modifier = Modifier.height(10.dp))

            // Auto-scroll toggle bar
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Transcript (${events.size} events)",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.ink
                )
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(if (isAutoScroll) colors.brand else colors.surfaceRaised)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                        .clickable { onToggleAutoScroll() }
                        .padding(horizontal = 10.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = if (isAutoScroll) "Auto-scroll ON" else "Auto-scroll OFF",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (isAutoScroll) colors.onBrand else colors.inkMuted
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Events List
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxWidth().weight(1f)
            ) {
                items(events, key = { it.rowid }) { event ->
                    EventRow(event = event)
                    Spacer(modifier = Modifier.height(8.dp))
                }
            }
        }
    }
}

@Composable
fun InlineApprovalCard(
    approval: ApprovalView,
    onApprove: () -> Unit,
    onDeny: () -> Unit
) {
    val colors = StudioNorthTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(StudioNorthTheme.radius12))
            .background(colors.accent.copy(alpha = 0.2f))
            .border(1.dp, colors.accent, RoundedCornerShape(StudioNorthTheme.radius12))
            .padding(12.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Pending Guard Approval Required",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                StatusBadge(status = "pending")
            }
            Spacer(modifier = Modifier.height(6.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(colors.surface)
                    .border(1.dp, colors.border, RoundedCornerShape(8.dp))
                    .padding(8.dp)
            ) {
                Text(
                    text = approval.command,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = colors.ink
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End
            ) {
                OutlinedButton(
                    onClick = onDeny,
                    modifier = Modifier.height(36.dp),
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    border = BorderStroke(1.dp, colors.danger),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.danger),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)
                ) {
                    Text(text = "Deny", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
                Spacer(modifier = Modifier.width(8.dp))
                ActionPill(
                    text = "Approve",
                    onClick = onApprove,
                    modifier = Modifier.height(36.dp)
                )
            }
        }
    }
}
