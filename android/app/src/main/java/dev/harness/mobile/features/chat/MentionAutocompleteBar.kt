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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.ChatMember
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun MentionAutocompleteBar(
    suggestions: List<ChatMember>,
    onSelect: (ChatMember) -> Unit,
    modifier: Modifier = Modifier
) {
    if (suggestions.isEmpty()) return
    val colors = StudioNorthTheme.colors

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(StudioNorthTheme.radius12))
            .background(colors.surfaceRaised)
            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
            .heightIn(max = 200.dp)
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
        ) {
            items(suggestions, key = { it.id }) { member ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelect(member) }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "@${member.handle}",
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.ink
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            MemberKindBadge(kind = member.kind)
                        }
                        if (member.displayName.isNotBlank()) {
                            Text(
                                text = member.displayName,
                                fontSize = 12.sp,
                                color = colors.inkMuted
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun MemberKindBadge(
    kind: String,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    val isAgent = kind.lowercase() == "agent"
    val (bgColor, textColor) = if (isAgent) {
        colors.accent.copy(alpha = 0.25f) to colors.brand
    } else {
        colors.surface to colors.inkMuted
    }

    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(bgColor)
            .border(1.dp, colors.border, CircleShape)
            .padding(horizontal = 8.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = if (isAgent) "agent" else "human",
            color = textColor,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium
        )
    }
}
