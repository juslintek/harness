package dev.harness.mobile.core

import dev.harness.mobile.core.model.WsMessage
import dev.harness.mobile.core.network.HarnessWsClient
import dev.harness.mobile.core.network.WsConnectionState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class HarnessWsClientTest {

    private lateinit var server: MockWebServer

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun testPolymorphicTypeDecoding() {
        val client = HarnessWsClient(
            wsUrl = "ws://localhost:4100/ws",
            tokenProvider = { "test_token" },
            originProvider = { "http://localhost:4100" }
        )

        val eventJson = """{"type":"event","runId":"run_123","event":{"kind":"command","ts":1700000005000}}"""
        val eventMsg = client.decodeMessage(eventJson)
        assertTrue(eventMsg is WsMessage.Event)
        assertEquals("run_123", (eventMsg as WsMessage.Event).runId)
        assertEquals("command", eventMsg.event.kind)

        val taskJson = """{"type":"task","projectId":"prj_1","taskId":"tsk_2","kind":"updated"}"""
        val taskMsg = client.decodeMessage(taskJson)
        assertTrue(taskMsg is WsMessage.Task)
        assertEquals("updated", (taskMsg as WsMessage.Task).kind)

        val chatJson = """{"type":"chat","channelId":"chn_1","messageId":"msg_2","threadRootId":null}"""
        val chatMsg = client.decodeMessage(chatJson)
        assertTrue(chatMsg is WsMessage.Chat)
        assertEquals("chn_1", (chatMsg as WsMessage.Chat).channelId)

        val dashJson = """{"type":"dashboard"}"""
        val dashMsg = client.decodeMessage(dashJson)
        assertTrue(dashMsg is WsMessage.Dashboard)

        val memoryJson = """{"type":"memory","orgId":"org_99"}"""
        val memoryMsg = client.decodeMessage(memoryJson)
        assertTrue(memoryMsg is WsMessage.Memory)
        assertEquals("org_99", (memoryMsg as WsMessage.Memory).orgId)

        val unknownJson = """{"type":"completely_unknown_event"}"""
        val unknownMsg = client.decodeMessage(unknownJson)
        assertNull(unknownMsg)
    }

    @Test
    fun testBackoffProgressionAndCap() {
        val client = HarnessWsClient(
            wsUrl = "ws://localhost:4100/ws",
            tokenProvider = { "token" },
            originProvider = { "origin" }
        )

        assertEquals(1000L, client.calculateBackoff(0))
        assertEquals(2000L, client.calculateBackoff(1))
        assertEquals(4000L, client.calculateBackoff(2))
        assertEquals(8000L, client.calculateBackoff(3))
        assertEquals(16000L, client.calculateBackoff(4))
        assertEquals(30000L, client.calculateBackoff(5))
        assertEquals(30000L, client.calculateBackoff(10))
        assertEquals(30000L, client.calculateBackoff(100))
    }

    @Test
    fun test4401ImmediateStopAndRevokedState() {
        val client = HarnessWsClient(
            wsUrl = "ws://localhost:4100/ws",
            tokenProvider = { "token" },
            originProvider = { "origin" }
        )

        // Simulate close code 4401 (token revoked)
        client.handleClose(4401)
        assertEquals(WsConnectionState.Revoked, client.connectionState.value)

        // Attempting to connect when revoked must be a no-op
        client.connect()
        assertEquals(WsConnectionState.Revoked, client.connectionState.value)
    }
}
