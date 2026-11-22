package dev.harness.mobile.features.board

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.TaskView
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StatusBadge
import dev.harness.mobile.theme.StudioNorthTheme

fun formatEstimate(minutes: Int): String {
    return if (minutes >= 60) {
        val hours = minutes / 60
        val rem = minutes % 60
        if (rem == 0) "${hours}h" else "${hours}h ${rem}m"
    } else {
        "${minutes}m"
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TaskCard(
    task: TaskView,
    subtaskCount: Int,
    depCount: Int,
    noticeMessage: String?,
    onClick: () -> Unit,
    onMove: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    var showMoveMenu by remember { mutableStateOf(false) }

    RaisedCard(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onClick,
                onLongClick = { showMoveMenu = true }
            )
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "#${task.number}",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.inkMuted
                )
                Spacer(modifier = Modifier.width(6.dp))
                StatusBadge(status = task.status)
            }

            Box {
                OutlinedButton(
                    onClick = { showMoveMenu = true },
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                    modifier = Modifier.height(28.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, colors.border)
                ) {
                    Text(
                        text = "Move to…",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.link
                    )
                }

                DropdownMenu(
                    expanded = showMoveMenu,
                    onDismissRequest = { showMoveMenu = false }
                ) {
                    BOARD_COLUMNS.forEach { col ->
                        if (col != task.status) {
                            DropdownMenuItem(
                                text = { Text(statusLabel(col), fontSize = 13.sp) },
                                onClick = {
                                    showMoveMenu = false
                                    onMove(col)
                                }
                            )
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = task.title,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.ink
        )

        if (task.description.isNotBlank()) {
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = task.description,
                fontSize = 13.sp,
                color = colors.inkMuted,
                maxLines = 2
            )
        }

        Spacer(modifier = Modifier.height(10.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            task.assignee?.let { a ->
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = "@${a.handle}",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.ink
                    )
                }
            }

            task.estimateMinutes?.let { est ->
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = formatEstimate(est),
                        fontSize = 11.sp,
                        color = colors.inkMuted
                    )
                }
            }

            task.holder?.let { h ->
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.accent.copy(alpha = 0.2f))
                        .border(1.dp, colors.accent, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = "held by @${h.handle}",
                        fontSize = 11.sp,
                        color = colors.brand,
                        fontWeight = FontWeight.Medium
                    )
                }
            }

            if (depCount > 0) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = "$depCount dep",
                        fontSize = 11.sp,
                        color = colors.inkMuted
                    )
                }
            }

            if (subtaskCount > 0) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        text = "$subtaskCount sub",
                        fontSize = 11.sp,
                        color = colors.inkMuted
                    )
                }
            }
        }

        if (noticeMessage != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                    .background(colors.danger.copy(alpha = 0.15f))
                    .border(1.dp, colors.danger, RoundedCornerShape(StudioNorthTheme.radius12))
                    .padding(8.dp)
            ) {
                Text(
                    text = noticeMessage,
                    fontSize = 12.sp,
                    color = colors.danger,
                    fontWeight = FontWeight.Medium
                )
            }
        }
    }
}
