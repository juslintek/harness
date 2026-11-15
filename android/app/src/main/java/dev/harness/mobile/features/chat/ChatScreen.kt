package dev.harness.mobile.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun ChatScreen(
    session: SessionRepository,
    modifier: Modifier = Modifier,
    baseUrl: String = "http://127.0.0.1:4100",
    focusedChannelId: String? = null,
    viewModel: ChatViewModel? = null
) {
    val colors = StudioNorthTheme.colors
    val activeOrg by session.activeOrg.collectAsState()
    var storedToken by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        storedToken = session.getStoredToken()
    }

    val chatVm = viewModel ?: remember(activeOrg?.id, storedToken) {
        val repo = ChatHttpRepository(
            baseUrlProvider = { baseUrl },
            tokenProvider = { storedToken }
        )
        ChatViewModel(repository = repo, session = session)
    }

    val state by chatVm.state.collectAsState()

    LaunchedEffect(activeOrg?.slug, storedToken) {
        val slug = activeOrg?.slug
        if (!slug.isNullOrBlank() && (viewModel != null || !storedToken.isNullOrBlank())) {
            chatVm.load(slug)
        }
    }

    LaunchedEffect(focusedChannelId) {
        if (!focusedChannelId.isNullOrBlank()) {
            chatVm.selectChannel(focusedChannelId)
        }
    }

    var showChannelSelector by remember { mutableStateOf(false) }
    var showNewDmDialog by remember { mutableStateOf(false) }
    var showNewGroupDialog by remember { mutableStateOf(false) }
    var composerText by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    val lastMessageId = state.messages.lastOrNull()?.id
    val selectedChannelId = state.selectedChannelId

    LaunchedEffect(selectedChannelId, lastMessageId) {
        if (state.messages.isNotEmpty()) {
            listState.animateScrollToItem(state.messages.size - 1)
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            ChatHeader(
                activeChannel = state.activeChannel,
                myHandle = state.myHandle,
                onOpenChannelSelector = { showChannelSelector = true },
                onNewDm = { showNewDmDialog = true },
                onNewGroup = { showNewGroupDialog = true }
            )
            HairlineDivider()

            state.errorMessage?.let { errorText ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.danger.copy(alpha = 0.15f))
                        .border(1.dp, colors.danger.copy(alpha = 0.3f))
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = errorText,
                            color = colors.danger,
                            fontSize = 13.sp,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            text = "✕",
                            color = colors.danger,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier
                                .clickable { chatVm.dismissError() }
                                .padding(4.dp)
                        )
                    }
                }
            }

            if (state.isLoading) {
                Box(modifier = Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.brand, strokeWidth = 2.dp)
                }
            } else if (state.activeChannel == null) {
                Box(modifier = Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No channel selected", color = colors.inkMuted, fontSize = 16.sp)
                        Spacer(modifier = Modifier.height(12.dp))
                        ActionPill(text = "Browse Channels", onClick = { showChannelSelector = true })
                    }
                }
            } else {
                Box(modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 16.dp)) {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize().padding(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        if (state.hasMoreOlder) {
                            item {
                                Box(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                                    contentAlignment = Alignment.Center
                                ) {
                                    if (state.isLoadingOlder) {
                                        CircularProgressIndicator(modifier = Modifier.size(20.dp), color = colors.brand, strokeWidth = 2.dp)
                                    } else {
                                        SecondaryLinkButton(text = "Load earlier messages", onClick = { chatVm.loadOlderMessages() })
                                    }
                                }
                            }
                        }
                        if (state.messages.isEmpty()) {
                            item {
                                Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                                    Text("No messages yet. Send the first message!", color = colors.inkMuted, fontSize = 14.sp)
                                }
                            }
                        }
                        items(state.messages, key = { it.id }) { msg ->
                            MessageItemView(
                                message = msg,
                                onOpenThread = { chatVm.openThread(msg) }
                            )
                        }
                    }
                }

                if (state.mentionSuggestions.isNotEmpty()) {
                    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                        MentionAutocompleteBar(
                            suggestions = state.mentionSuggestions,
                            onSelect = { member ->
                                val (newText, _) = MentionUtils.insertMention(composerText, composerText.length, member)
                                composerText = newText
                                chatVm.dismissMentionSuggestions()
                            }
                        )
                    }
                }

                HairlineDivider()
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.surfaceRaised)
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedTextField(
                        value = composerText,
                        onValueChange = { newText ->
                            composerText = newText
                            chatVm.onInputTextChanged(newText, newText.length)
                        },
                        modifier = Modifier
                            .weight(1f)
                            .testTag("input.chat_composer")
                            .semantics { contentDescription = "Message composer" },
                        placeholder = { Text("Message ${state.activeChannel?.let { channelDisplayName(it, state.myHandle) } ?: ""}…", fontSize = 14.sp, color = colors.inkMuted) },
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
                        text = "Send",
                        enabled = composerText.isNotBlank(),
                        modifier = Modifier
                            .testTag("button.chat_send")
                            .semantics { contentDescription = "Send message" },
                        onClick = {
                            chatVm.sendMessage(composerText)
                            composerText = ""
                            chatVm.dismissMentionSuggestions()
                        }
                    )
                }
            }
        }

        if (showChannelSelector) {
            ChannelSelectorSheet(
                channels = state.nonDmChannels,
                directMessages = state.directMessages,
                selectedChannelId = state.selectedChannelId,
                myHandle = state.myHandle,
                onSelectChannel = { channelId ->
                    chatVm.selectChannel(channelId)
                    showChannelSelector = false
                },
                onDismiss = { showChannelSelector = false },
                onNewDm = {
                    showChannelSelector = false
                    showNewDmDialog = true
                },
                onNewGroup = {
                    showChannelSelector = false
                    showNewGroupDialog = true
                }
            )
        }

        state.activeThreadRoot?.let { rootMsg ->
            ThreadBottomSheet(
                rootMessage = rootMsg,
                threadMessages = state.threadMessages,
                isLoading = state.isThreadLoading,
                members = state.members.ifEmpty { state.orgMembers },
                onDismiss = { chatVm.closeThread() },
                onSendReply = { replyBody -> chatVm.sendMessage(replyBody, threadRootId = rootMsg.id) }
            )
        }

        if (showNewDmDialog) {
            NewDmDialog(
                members = state.orgMembers,
                onDismiss = { showNewDmDialog = false },
                onConfirm = { memberId ->
                    chatVm.createDm(memberId)
                    showNewDmDialog = false
                }
            )
        }

        if (showNewGroupDialog) {
            NewGroupDialog(
                members = state.orgMembers,
                onDismiss = { showNewGroupDialog = false },
                onConfirm = { name, memberIds ->
                    chatVm.createGroup(name, memberIds)
                    showNewGroupDialog = false
                }
            )
        }
    }
}
