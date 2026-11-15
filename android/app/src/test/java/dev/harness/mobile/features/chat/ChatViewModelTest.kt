package dev.harness.mobile.features.chat

import dev.harness.mobile.core.model.ChannelView
import dev.harness.mobile.core.model.ChatMember
import dev.harness.mobile.core.model.ChatMessagesFixture
import dev.harness.mobile.core.model.MessageView
import dev.harness.mobile.core.model.WsMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun readFixture(fileName: String): String {
        val candidates = listOf(File("../../contract/mobile-fixtures"), File("../contract/mobile-fixtures"), File("contract/mobile-fixtures"))
        val dir = candidates.firstOrNull { it.exists() && it.isDirectory } ?: error("Fixtures dir not found")
        return File(dir, fileName).readText()
    }

    @Before
    fun setUp() = Dispatchers.setMain(testDispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun testChannelAndDmGroupingAndUnreadClearOnMarkRead() = runTest(testDispatcher) {
        val fixture = json.decodeFromString<ChatMessagesFixture>(readFixture("chat-messages.json"))
        val chOrg = fixture.channels[0].copy(id = "chn_general", kind = "org", name = "general", unread = 2)
        val chProject = ChannelView("chn_proj", "org_1", "project", "mobile-app", unread = 0)
        val chDm = ChannelView("chn_dm_1", "org_1", "dm", "alice, bob", unread = 5)

        val fakeRepo = FakeChatRepository(listOf(chOrg, chProject, chDm), fixture.members, fixture.messages)
        val viewModel = ChatViewModel(repository = fakeRepo)
        viewModel.load("acme-org", initialChannelId = "chn_general")
        testDispatcher.scheduler.advanceUntilIdle()

        val state = viewModel.state.value
        assertEquals(2, state.nonDmChannels.size)
        assertEquals("chn_general", state.nonDmChannels[0].id)
        assertEquals("chn_proj", state.nonDmChannels[1].id)
        assertEquals(1, state.directMessages.size)
        assertEquals("chn_dm_1", state.directMessages[0].id)

        // Loading initial channel chn_general marks it read
        assertEquals(0, state.channels.first { it.id == "chn_general" }.unread)
        assertTrue(fakeRepo.readChannelCalls.contains("chn_general"))
        assertEquals(5, state.channels.first { it.id == "chn_dm_1" }.unread)

        // Select DM channel -> marks it read and clears unread
        viewModel.selectChannel("chn_dm_1")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("chn_dm_1", viewModel.state.value.selectedChannelId)
        assertEquals(0, viewModel.state.value.channels.first { it.id == "chn_dm_1" }.unread)
        assertTrue(fakeRepo.readChannelCalls.contains("chn_dm_1"))
    }

    @Test
    fun testCursorPaginationOrderingAndDeduplication() = runTest(testDispatcher) {
        val channelId = "chn_paginated"
        val testMessages = (1..65).map { i ->
            MessageView(id = "msg_$i", channelId = channelId, body = "Msg $i", createdAt = 1700000000000L + (i * 1000L))
        }

        val fakeRepo = FakeChatRepository(listOf(ChannelView(channelId, "org_1", "org", "general")), initialMessages = testMessages)
        val viewModel = ChatViewModel(repository = fakeRepo)
        viewModel.load("acme-org", initialChannelId = channelId)
        testDispatcher.scheduler.advanceUntilIdle()

        // Page limit is 50. Latest 50 are msg_16 to msg_65
        val initialMessages = viewModel.state.value.messages
        assertEquals(50, initialMessages.size)
        assertEquals("msg_16", initialMessages.first().id)
        assertEquals("msg_65", initialMessages.last().id)
        assertTrue(viewModel.state.value.hasMoreOlder)

        for (i in 0 until initialMessages.size - 1) {
            assertTrue(initialMessages[i].createdAt <= initialMessages[i + 1].createdAt)
        }

        // Load older page with cursor: ?before=<createdAt>:<id>
        viewModel.loadOlderMessages()
        testDispatcher.scheduler.advanceUntilIdle()

        val allPagedMessages = viewModel.state.value.messages
        assertEquals(65, allPagedMessages.size)
        assertEquals("msg_1", allPagedMessages.first().id)
        assertEquals("msg_65", allPagedMessages.last().id)
        assertFalse(viewModel.state.value.hasMoreOlder)

        // Duplicate insertion should deduplicate
        fakeRepo.messages.add(testMessages[0])
        viewModel.loadOlderMessages()
        testDispatcher.scheduler.advanceUntilIdle()
        assertEquals(65, viewModel.state.value.messages.size)
    }

    @Test
    fun testMentionTokenExtractionAndMemberFiltering() = runTest(testDispatcher) {
        val members = listOf(
            ChatMember(id = "mem_1", kind = "human", handle = "alice", displayName = "Alice Cooper"),
            ChatMember(id = "mem_2", kind = "agent", handle = "architect-agent", displayName = "Architect Agent"),
            ChatMember(id = "mem_3", kind = "human", handle = "bob", displayName = "Bob Marley")
        )

        val fakeRepo = FakeChatRepository(listOf(ChannelView("chn_1", "org_1", "org", "general")), members)
        val viewModel = ChatViewModel(repository = fakeRepo)
        viewModel.load("acme-org", initialChannelId = "chn_1")
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.onInputTextChanged("@", 1)
        assertEquals("", viewModel.state.value.mentionQuery)
        assertEquals(3, viewModel.state.value.mentionSuggestions.size)

        viewModel.onInputTextChanged("Hello @al", 9)
        assertEquals("al", viewModel.state.value.mentionQuery)
        assertEquals(1, viewModel.state.value.mentionSuggestions.size)
        assertEquals("alice", viewModel.state.value.mentionSuggestions.first().handle)
        assertEquals("human", viewModel.state.value.mentionSuggestions.first().kind)

        viewModel.onInputTextChanged("Assign to @arch", 15)
        assertEquals("arch", viewModel.state.value.mentionQuery)
        assertEquals(1, viewModel.state.value.mentionSuggestions.size)
        assertEquals("architect-agent", viewModel.state.value.mentionSuggestions.first().handle)
        assertEquals("agent", viewModel.state.value.mentionSuggestions.first().kind)

        // Email address should NOT trigger mention autocomplete
        viewModel.onInputTextChanged("Contact support@acme.com", 24)
        assertNull(viewModel.state.value.mentionQuery)
        assertTrue(viewModel.state.value.mentionSuggestions.isEmpty())

        val inserted = MentionUtils.insertMention("Hello @al", 9, members[0])
        assertEquals("Hello @alice ", inserted.first)
        assertEquals(13, inserted.second)

        viewModel.dismissMentionSuggestions()
        assertNull(viewModel.state.value.mentionQuery)
    }

    @Test
    fun testThreadLoadingReplyPostingAndWsChatNudge() = runTest(testDispatcher) {
        val channelId = "chn_chat"
        val rootMessage = MessageView(id = "msg_root", channelId = channelId, body = "Root", createdAt = 1700000000000L)
        val reply1 = MessageView(id = "msg_rep1", channelId = channelId, threadRootId = "msg_root", body = "Reply 1", createdAt = 1700000001000L)

        val wsFlow = MutableSharedFlow<WsMessage>()
        val fakeRepo = FakeChatRepository(listOf(ChannelView(channelId, "org_1", "org", "general")), initialMessages = listOf(rootMessage, reply1))
        val viewModel = ChatViewModel(repository = fakeRepo, wsFlow = wsFlow)
        viewModel.load("acme-org", initialChannelId = channelId)
        testDispatcher.scheduler.advanceUntilIdle()

        viewModel.openThread(rootMessage)
        testDispatcher.scheduler.advanceUntilIdle()

        var state = viewModel.state.value
        assertEquals("msg_root", state.activeThreadRoot?.id)
        assertEquals(1, state.threadMessages.size)
        assertEquals("msg_rep1", state.threadMessages.first().id)

        // Post reply
        viewModel.sendMessage("Reply 2", threadRootId = "msg_root")
        testDispatcher.scheduler.advanceUntilIdle()

        state = viewModel.state.value
        assertEquals(2, state.threadMessages.size)
        assertEquals("Reply 2", state.threadMessages[1].body)
        assertEquals(1, state.messages.first { it.id == "msg_root" }.replyCount)

        viewModel.closeThread()
        assertNull(viewModel.state.value.activeThreadRoot)
        assertTrue(viewModel.state.value.threadMessages.isEmpty())

        // Receive WS nudge for new message in current channel
        val newIncoming = MessageView(id = "msg_live", channelId = channelId, body = "Live", createdAt = 1700000005000L)
        fakeRepo.messages.add(newIncoming)
        wsFlow.emit(WsMessage.Chat(channelId = channelId, messageId = "msg_live"))
        testDispatcher.scheduler.advanceUntilIdle()

        assertTrue(viewModel.state.value.messages.any { it.id == "msg_live" })
    }

    @Test
    fun testDeepLinkAndChannelCreation() = runTest(testDispatcher) {
        val fakeRepo = FakeChatRepository(listOf(
            ChannelView("chn_general", "acme", "org", "general"),
            ChannelView("chn_other", "acme", "team", "backend")
        ))
        val viewModel = ChatViewModel(repository = fakeRepo)
        viewModel.load("acme", initialChannelId = "chn_general")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("chn_general", viewModel.state.value.selectedChannelId)

        // Deep link to backend channel
        val handled = viewModel.handleDeepLink("harness://chat/acme/chn_other")
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(handled)
        assertEquals("chn_other", viewModel.state.value.selectedChannelId)

        assertFalse(viewModel.handleDeepLink("https://example.com/other"))

        viewModel.createDm("mem_target")
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.state.value.channels.any { it.kind == "dm" && it.id == "chn_dm_mem_target" })
        assertEquals("chn_dm_mem_target", viewModel.state.value.selectedChannelId)

        viewModel.createGroup("Dev Team", listOf("mem_1", "mem_2"))
        testDispatcher.scheduler.advanceUntilIdle()
        assertTrue(viewModel.state.value.channels.any { it.kind == "group" && it.name == "Dev Team" })
    }

    @Test
    fun testErrorHandlingAndDismiss() = runTest(testDispatcher) {
        val failingRepo = object : ChatRepository by FakeChatRepository() {
            override suspend fun getChannels(orgSlug: String): List<ChannelView> {
                throw java.io.IOException("Network offline")
            }
        }
        val viewModel = ChatViewModel(repository = failingRepo)
        viewModel.load("acme")
        testDispatcher.scheduler.advanceUntilIdle()

        assertEquals("Network offline", viewModel.state.value.errorMessage)
        assertFalse(viewModel.state.value.isLoading)

        viewModel.dismissError()
        assertNull(viewModel.state.value.errorMessage)
    }
}
