package dev.harness.mobile.features.chat

import dev.harness.mobile.core.model.ChannelView
import dev.harness.mobile.core.model.ChatMember
import dev.harness.mobile.core.model.MessageView

data class ChatUiState(
    val isLoading: Boolean = false,
    val orgSlug: String? = null,
    val channels: List<ChannelView> = emptyList(),
    val selectedChannelId: String? = null,
    val members: List<ChatMember> = emptyList(),
    val orgMembers: List<ChatMember> = emptyList(),
    val messages: List<MessageView> = emptyList(),
    val isLoadingOlder: Boolean = false,
    val hasMoreOlder: Boolean = true,
    val activeThreadRoot: MessageView? = null,
    val threadMessages: List<MessageView> = emptyList(),
    val isThreadLoading: Boolean = false,
    val mentionQuery: String? = null,
    val mentionSuggestions: List<ChatMember> = emptyList(),
    val errorMessage: String? = null,
    val myHandle: String? = null
) {
    val nonDmChannels: List<ChannelView>
        get() = channels.filter { it.kind != "dm" }

    val directMessages: List<ChannelView>
        get() = channels.filter { it.kind == "dm" }

    val activeChannel: ChannelView?
        get() = channels.firstOrNull { it.id == selectedChannelId }
}

fun mergeMessages(existing: List<MessageView>, incoming: List<MessageView>): List<MessageView> {
    val map = LinkedHashMap<String, MessageView>()
    for (m in existing) map[m.id] = m
    for (m in incoming) map[m.id] = m
    return map.values.sortedWith(compareBy<MessageView> { it.createdAt }.thenBy { it.id })
}

private val CHAT_DEEP_LINK_REGEX = Regex("""^harness://chat/([^/]+)/([^/?#]+)""")

fun parseChatDeepLink(uri: String): Pair<String, String>? {
    val match = CHAT_DEEP_LINK_REGEX.find(uri) ?: return null
    return Pair(match.groupValues[1], match.groupValues[2])
}
