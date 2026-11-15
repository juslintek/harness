package dev.harness.mobile.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.ChatMember
import dev.harness.mobile.core.model.MessageView
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.StudioNorthTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadBottomSheet(
    rootMessage: MessageView,
    threadMessages: List<MessageView>,
    isLoading: Boolean,
    members: List<ChatMember>,
    onDismiss: () -> Unit,
    onSendReply: (String) -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val colors = StudioNorthTheme.colors
    var replyText by remember { mutableStateOf("") }
    var mentionSuggestions by remember { mutableStateOf<List<ChatMember>>(emptyList()) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surfaceRaised,
        tonalElevation = 0.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.85f)
                .padding(horizontal = 16.dp, vertical = 8.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Thread",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                TextButton(onClick = onDismiss) {
                    Text("Close", color = colors.link, fontSize = 14.sp)
                }
            }
            Spacer(modifier = Modifier.height(8.dp))

            // Root message preview
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                    .background(colors.surface)
                    .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                    .padding(12.dp)
            ) {
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = rootMessage.author?.displayName ?: rootMessage.author?.handle ?: "Unknown",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.ink
                        )
                        MemberKindBadge(kind = rootMessage.author?.kind ?: "human")
                    }
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(text = rootMessage.body, fontSize = 14.sp, color = colors.ink)
                }
            }

            Spacer(modifier = Modifier.height(12.dp))
            HairlineDivider()
            Spacer(modifier = Modifier.height(8.dp))

            if (isLoading) {
                Box(modifier = Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.brand, strokeWidth = 2.dp)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    if (threadMessages.isEmpty()) {
                        item {
                            Text(
                                text = "No replies yet. Start the thread!",
                                fontSize = 13.sp,
                                color = colors.inkMuted,
                                modifier = Modifier.padding(vertical = 16.dp)
                            )
                        }
                    }
                    items(threadMessages, key = { it.id }) { reply ->
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                                .background(colors.surface)
                                .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                                .padding(10.dp)
                        ) {
                            Column {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(
                                        text = reply.author?.displayName ?: reply.author?.handle ?: "Unknown",
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = colors.ink
                                    )
                                    MemberKindBadge(kind = reply.author?.kind ?: "human")
                                }
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(text = reply.body, fontSize = 13.sp, color = colors.ink)
                            }
                        }
                    }
                }
            }

            // Autocomplete bar
            MentionAutocompleteBar(
                suggestions = mentionSuggestions,
                onSelect = { member ->
                    val (newText, _) = MentionUtils.insertMention(replyText, replyText.length, member)
                    replyText = newText
                    mentionSuggestions = emptyList()
                }
            )

            Spacer(modifier = Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = replyText,
                    onValueChange = { newText ->
                        replyText = newText
                        val q = MentionUtils.extractMentionQuery(newText, newText.length)
                        mentionSuggestions = if (q != null) MentionUtils.filterMembers(members, q) else emptyList()
                    },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Reply to thread…", fontSize = 14.sp, color = colors.inkMuted) },
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = colors.brand,
                        unfocusedBorderColor = colors.border,
                        focusedContainerColor = colors.surface,
                        unfocusedContainerColor = colors.surface,
                        focusedTextColor = colors.ink,
                        unfocusedTextColor = colors.ink
                    ),
                    singleLine = true
                )
                Spacer(modifier = Modifier.width(8.dp))
                ActionPill(
                    text = "Reply",
                    enabled = replyText.isNotBlank(),
                    onClick = {
                        onSendReply(replyText.trim())
                        replyText = ""
                        mentionSuggestions = emptyList()
                    }
                )
            }
            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
