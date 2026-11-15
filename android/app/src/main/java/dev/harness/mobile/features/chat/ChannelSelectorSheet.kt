package dev.harness.mobile.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.ChannelView
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun ChatHeader(
    activeChannel: ChannelView?,
    myHandle: String?,
    onOpenChannelSelector: () -> Unit,
    onNewDm: () -> Unit,
    onNewGroup: () -> Unit
) {
    val colors = StudioNorthTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.surfaceRaised)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.clickable { onOpenChannelSelector() }) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val title = if (activeChannel != null) {
                    val prefix = if (activeChannel.kind == "dm") "@" else "#"
                    "$prefix${channelDisplayName(activeChannel, myHandle)}"
                } else {
                    "Select Channel"
                }
                Text(
                    text = title,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(text = "▼", fontSize = 12.sp, color = colors.inkMuted)
            }
            if (activeChannel != null) {
                Text(
                    text = "${activeChannel.kind.replaceFirstChar { it.uppercase() }} channel",
                    fontSize = 12.sp,
                    color = colors.inkMuted
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            SecondaryLinkButton(text = "+ DM", onClick = onNewDm)
            Spacer(modifier = Modifier.width(6.dp))
            SecondaryLinkButton(text = "+ Group", onClick = onNewGroup)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelSelectorSheet(
    channels: List<ChannelView>,
    directMessages: List<ChannelView>,
    selectedChannelId: String?,
    myHandle: String?,
    onSelectChannel: (String) -> Unit,
    onDismiss: () -> Unit,
    onNewDm: () -> Unit,
    onNewGroup: () -> Unit
) {
    val colors = StudioNorthTheme.colors
    var activeTab by remember { mutableStateOf(0) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.surfaceRaised,
        tonalElevation = 0.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.7f)
                .padding(horizontal = 16.dp, vertical = 8.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text("Conversations", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = colors.ink)
                Row {
                    TextButton(onClick = onNewDm) { Text("+ DM", color = colors.link, fontSize = 13.sp) }
                    TextButton(onClick = onNewGroup) { Text("+ Group", color = colors.link, fontSize = 13.sp) }
                }
            }
            Spacer(modifier = Modifier.height(8.dp))

            // Tab selector: Channels vs Direct Messages
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                    .background(colors.surface)
                    .padding(4.dp)
            ) {
                val tabs = listOf("Channels (${channels.size})", "Direct Messages (${directMessages.size})")
                tabs.forEachIndexed { index, title ->
                    val isSelected = activeTab == index
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                            .background(if (isSelected) colors.surfaceRaised else colors.surface)
                            .clickable { activeTab = index }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = title,
                            fontSize = 13.sp,
                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                            color = if (isSelected) colors.ink else colors.inkMuted
                        )
                    }
                }
            }
            Spacer(modifier = Modifier.height(12.dp))

            val currentList = if (activeTab == 0) channels else directMessages
            LazyColumn(
                modifier = Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                if (currentList.isEmpty()) {
                    item {
                        Text(
                            text = if (activeTab == 0) "No channels found." else "No direct messages yet.",
                            color = colors.inkMuted,
                            fontSize = 13.sp,
                            modifier = Modifier.padding(vertical = 16.dp)
                        )
                    }
                }
                items(currentList, key = { it.id }) { ch ->
                    val isSelected = ch.id == selectedChannelId
                    val prefix = if (ch.kind == "dm") "@" else "#"
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (isSelected) colors.surface else colors.surfaceRaised)
                            .clickable { onSelectChannel(ch.id) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = "$prefix${channelDisplayName(ch, myHandle)}",
                                fontWeight = if (isSelected || ch.unread > 0) FontWeight.Bold else FontWeight.Normal,
                                fontSize = 15.sp,
                                color = colors.ink
                            )
                            if (ch.unread > 0) {
                                Spacer(modifier = Modifier.width(8.dp))
                                // Studio North accent unread dot
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(colors.accent)
                                )
                            }
                        }
                        if (ch.unread > 0) {
                            Text(
                                text = "${ch.unread}",
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                color = colors.brand
                            )
                        }
                    }
                }
            }
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

fun channelDisplayName(channel: ChannelView, myHandle: String? = null): String {
    if (channel.kind != "dm") return channel.name
    if (myHandle.isNullOrBlank()) return channel.name
    return channel.name
        .split(", ")
        .filter { it.trim().lowercase() != myHandle.trim().lowercase() }
        .joinToString(", ")
        .ifBlank { channel.name }
}
