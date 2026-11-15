package dev.harness.mobile.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.MessageView
import dev.harness.mobile.theme.StudioNorthTheme
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun MessageItemView(
    message: MessageView,
    onOpenThread: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    val authorName = message.author?.displayName?.takeIf { it.isNotBlank() }
        ?: message.author?.handle
        ?: message.authorId
        ?: "Unknown"
    val authorKind = message.author?.kind ?: "human"
    val timeStr = formatMessageTime(message.createdAt)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(StudioNorthTheme.radius12))
            .background(colors.surfaceRaised)
            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
            .padding(12.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = authorName,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 14.sp,
                        color = colors.ink
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    MemberKindBadge(kind = authorKind)
                }
                Text(
                    text = timeStr,
                    fontSize = 11.sp,
                    color = colors.inkMuted
                )
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = message.body,
                fontSize = 14.sp,
                color = colors.ink,
                lineHeight = 20.sp
            )
            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                val threadLabel = if (message.replyCount > 0) {
                    "${message.replyCount} ${if (message.replyCount == 1) "reply" else "replies"}"
                } else {
                    "Reply"
                }
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                        .clickable { onOpenThread() }
                        .padding(horizontal = 10.dp, vertical = 4.dp)
                ) {
                    Text(
                        text = "💬 $threadLabel",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = colors.link
                    )
                }
            }
        }
    }
}

fun formatMessageTime(timestamp: Long): String {
    if (timestamp <= 0L) return ""
    val sdf = SimpleDateFormat("HH:mm", Locale.getDefault())
    return sdf.format(Date(timestamp))
}
