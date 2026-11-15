package dev.harness.mobile.features.approvals

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
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.ApprovalView
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StatusBadge
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun ApprovalCard(
    approval: ApprovalView,
    isDeciding: Boolean,
    remainingSeconds: Long,
    formatCountdown: (Long) -> String,
    isDangerCountdown: (Long) -> Boolean,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onSelectRun: (String) -> Unit,
    modifier: Modifier = Modifier,
    isFocused: Boolean = false
) {
    val colors = StudioNorthTheme.colors
    val borderModifier = if (isFocused) {
        modifier.border(2.dp, colors.accent, RoundedCornerShape(StudioNorthTheme.radius12))
    } else modifier

    RaisedCard(modifier = borderModifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(status = approval.status)
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = "Run: ${approval.runId.takeLast(8)} ↗",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = colors.link,
                    modifier = Modifier.clickable { onSelectRun(approval.runId) }
                )
            }
            if (approval.status == "pending") {
                val isDanger = isDangerCountdown(remainingSeconds)
                Text(
                    text = formatCountdown(remainingSeconds),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (isDanger) colors.danger else colors.inkMuted
                )
            }
        }

        Spacer(modifier = Modifier.height(10.dp))

        // Monospace command box
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                .background(colors.surface)
                .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                .padding(12.dp)
        ) {
            Text(
                text = approval.command,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                color = colors.ink
            )
        }

        if (!approval.reason.isNullOrBlank()) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = approval.reason,
                fontSize = 13.sp,
                color = colors.inkMuted
            )
        }

        if (approval.status == "pending" && remainingSeconds > 0) {
            Spacer(modifier = Modifier.height(14.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(
                    onClick = onDeny,
                    enabled = !isDeciding,
                    modifier = Modifier
                        .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                        .testTag("button.deny_${approval.id}")
                        .semantics { contentDescription = "Deny command ${approval.command}" },
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    border = BorderStroke(1.dp, colors.danger),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = colors.danger,
                        disabledContentColor = colors.inkMuted
                    ),
                    elevation = ButtonDefaults.buttonElevation(defaultElevation = 0.dp),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
                ) {
                    Text(
                        text = "Deny",
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 14.sp
                    )
                }

                Spacer(modifier = Modifier.width(10.dp))

                ActionPill(
                    text = "Approve",
                    onClick = onApprove,
                    enabled = !isDeciding,
                    modifier = Modifier
                        .testTag("button.approve_${approval.id}")
                        .semantics { contentDescription = "Approve command ${approval.command}" }
                )
            }
        }
    }
}
