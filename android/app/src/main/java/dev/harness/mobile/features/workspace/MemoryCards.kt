package dev.harness.mobile.features.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.*
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StatusBadge
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = StudioNorthTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(StudioNorthTheme.radius24))
            .background(if (selected) colors.brand else colors.surfaceRaised)
            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
            .clickable { onClick() }
            .padding(horizontal = 10.dp, vertical = 4.dp)
    ) {
        Text(
            text = label,
            fontSize = 11.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
            color = if (selected) colors.onBrand else colors.ink
        )
    }
}

@Composable
fun NoteCard(note: NoteSummary, onClick: () -> Unit) {
    val colors = StudioNorthTheme.colors
    val isRedacted = note.tags.contains("redacted") || note.confidence < 1.0

    RaisedCard(modifier = Modifier.fillMaxWidth().clickable { onClick() }) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = note.title,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink,
                modifier = Modifier.weight(1f)
            )
            if (isRedacted) {
                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(colors.danger.copy(alpha = 0.2f))
                        .padding(horizontal = 8.dp, vertical = 2.dp)
                ) {
                    Text(text = "redacted", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = colors.danger)
                }
            }
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(text = note.path, fontSize = 12.sp, color = colors.inkMuted)
        Spacer(modifier = Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusBadge(status = note.type)
            note.tags.forEach { tag ->
                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(colors.surface)
                        .border(1.dp, colors.border, CircleShape)
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(text = "#$tag", fontSize = 10.sp, color = colors.inkMuted)
                }
            }
        }
    }
}

@Composable
fun WriteFeedCard(write: NoteWriteFeedItem, onRevert: () -> Unit) {
    val colors = StudioNorthTheme.colors

    RaisedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(status = write.op)
                Text(text = "@${write.actor}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.ink)
            }
            if (write.canRevert) {
                Text(
                    text = "Revert",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.danger,
                    modifier = Modifier.clickable { onRevert() }.padding(4.dp)
                )
            }
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(text = write.path, fontSize = 12.sp, color = colors.inkMuted)

        write.before?.let { beforeText ->
            Spacer(modifier = Modifier.height(6.dp))
            Text(text = "Before:", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = colors.danger)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.danger.copy(alpha = 0.1f))
                    .padding(6.dp)
            ) {
                Text(text = "- ${beforeText.take(120)}", fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = colors.danger)
            }
        }

        write.after?.let { afterText ->
            Spacer(modifier = Modifier.height(4.dp))
            Text(text = "After:", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = colors.link)
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.link.copy(alpha = 0.1f))
                    .padding(6.dp)
            ) {
                Text(text = "+ ${afterText.take(120)}", fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = colors.ink)
            }
        }
    }
}

@Composable
fun LessonCard(
    lesson: LessonView,
    isAdmin: Boolean,
    onAccept: () -> Unit,
    onReject: () -> Unit
) {
    val colors = StudioNorthTheme.colors

    RaisedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = "Lesson by @${lesson.authorHandle}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = colors.ink)
            StatusBadge(status = lesson.status)
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(text = lesson.body, fontSize = 13.sp, color = colors.ink)
        lesson.task?.let { t ->
            Spacer(modifier = Modifier.height(4.dp))
            Text(text = "Task #${t.number}: ${t.title}", fontSize = 11.sp, color = colors.inkMuted)
        }
        lesson.reason?.let { r ->
            Spacer(modifier = Modifier.height(4.dp))
            Text(text = "Review reason: $r", fontSize = 11.sp, color = colors.inkMuted)
        }
        if (lesson.status == "pending" && isAdmin) {
            Spacer(modifier = Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Accept",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.link,
                    modifier = Modifier.clickable { onAccept() }.padding(4.dp)
                )
                Text(
                    text = "Reject",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.danger,
                    modifier = Modifier.clickable { onReject() }.padding(4.dp)
                )
            }
        }
    }
}
