package dev.harness.mobile.features.chat

import dev.harness.mobile.core.model.ChannelView
import dev.harness.mobile.core.model.ChatMember
import dev.harness.mobile.core.model.MessageView

class FakeChatRepository(
    initialChannels: List<ChannelView> = emptyList(),
    initialMembers: List<ChatMember> = emptyList(),
    initialMessages: List<MessageView> = emptyList()
) : ChatRepository {

    val channels = initialChannels.toMutableList()
    val members = initialMembers.toMutableList()
    val messages = initialMessages.toMutableList()
    val readChannelCalls = mutableListOf<String>()

    override suspend fun getChannels(orgSlug: String): List<ChannelView> {
        return channels.toList()
    }

    override suspend fun createDm(orgSlug: String, memberId: String): ChannelView {
        val dm = ChannelView(
            id = "chn_dm_$memberId",
            orgId = "org_1",
            kind = "dm",
            name = "dm-$memberId",
            unread = 0
        )
        channels.add(dm)
        return dm
    }

    override suspend fun createGroup(orgSlug: String, name: String, memberIds: List<String>): ChannelView {
        val group = ChannelView(
            id = "chn_group_${System.currentTimeMillis()}",
            orgId = "org_1",
            kind = "group",
            name = name,
            unread = 0
        )
        channels.add(group)
        return group
    }

    override suspend fun getChannelMembers(channelId: String): List<ChatMember> {
        return members.toList()
    }

    override suspend fun getOrgMembers(orgSlug: String): List<ChatMember> {
        return members.toList()
    }

    override suspend fun getMessages(
        channelId: String,
        limit: Int,
        before: String?,
        threadRootId: String?
    ): List<MessageView> {
        var filtered = messages.filter {
            it.channelId == channelId && it.threadRootId == threadRootId
        }

        if (before != null && before.contains(":")) {
            val parts = before.split(":", limit = 2)
            val ts = parts[0].toLongOrNull() ?: Long.MAX_VALUE
            val beforeId = parts[1]
            filtered = filtered.filter {
                it.createdAt < ts || (it.createdAt == ts && it.id < beforeId)
            }
        }

        // Like SQLite SELECT ... ORDER BY created_at DESC, id DESC LIMIT limit, reversed
        val page = filtered
            .sortedWith(compareByDescending<MessageView> { it.createdAt }.thenByDescending { it.id })
            .take(limit)
            .reversed()

        return page
    }

    override suspend fun postMessage(channelId: String, body: String, threadRootId: String?): MessageView {
        val created = MessageView(
            id = "msg_${System.currentTimeMillis()}_${messages.size + 1}",
            channelId = channelId,
            threadRootId = threadRootId,
            body = body,
            createdAt = System.currentTimeMillis()
        )
        messages.add(created)
        return created
    }

    override suspend fun markRead(channelId: String): Boolean {
        readChannelCalls.add(channelId)
        val idx = channels.indexOfFirst { it.id == channelId }
        if (idx != -1) {
            channels[idx] = channels[idx].copy(unread = 0)
        }
        return true
    }
}
