package dev.harness.mobile.core.model

import kotlinx.serialization.Serializable

@Serializable
data class ChannelView(
    val id: String,
    val orgId: String,
    val kind: String,
    val name: String,
    val teamId: String? = null,
    val projectId: String? = null,
    val createdAt: Long = 0L,
    val unread: Int = 0
)

@Serializable
data class MessageTaskRef(
    val number: Int,
    val projectId: String
)

@Serializable
data class MessageView(
    val id: String,
    val channelId: String,
    val threadRootId: String? = null,
    val authorId: String? = null,
    val author: PersonRef? = null,
    val body: String,
    val createdAt: Long = 0L,
    val editedAt: Long? = null,
    val replyCount: Int = 0,
    val mentions: List<String> = emptyList(),
    val taskIds: List<String> = emptyList(),
    val tasks: List<MessageTaskRef> = emptyList()
)

@Serializable
data class ChatMember(
    val id: String,
    val kind: String,
    val handle: String,
    val displayName: String,
    val orgName: String? = null
)

@Serializable
data class ChatMessagesFixture(
    val channels: List<ChannelView> = emptyList(),
    val members: List<ChatMember> = emptyList(),
    val messages: List<MessageView> = emptyList()
)

@Serializable
data class PostMessageBody(
    val body: String,
    val threadRootId: String? = null
)

@Serializable
data class GroupBody(
    val name: String,
    val memberIds: List<String>
)

@Serializable
data class DmBody(
    val memberId: String
)
