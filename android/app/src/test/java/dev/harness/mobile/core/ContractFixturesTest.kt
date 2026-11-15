package dev.harness.mobile.core

import dev.harness.mobile.core.crypto.DeviceKeySigner
import dev.harness.mobile.core.crypto.JvmSoftwareSigner
import dev.harness.mobile.core.model.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.Base64

class ContractFixturesTest {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        prettyPrint = false
    }

    private fun getFixturesDir(): File {
        val candidates = listOf(
            File("../../contract/mobile-fixtures"),
            File("../contract/mobile-fixtures"),
            File("contract/mobile-fixtures"),
            File("../../../contract/mobile-fixtures")
        )
        return candidates.firstOrNull { it.exists() && it.isDirectory }
            ?: error("Could not find contract/mobile-fixtures directory. Searched: ${candidates.map { it.absolutePath }}")
    }

    private fun readFixture(fileName: String): String {
        val file = File(getFixturesDir(), fileName)
        assertTrue("Fixture file must exist: ${file.absolutePath}", file.exists())
        return file.readText()
    }

    @Test
    fun testApprovalsFixture() {
        val raw = readFixture("approvals.json")
        val approvals = json.decodeFromString<List<ApprovalView>>(raw)
        assertEquals(2, approvals.size)

        val first = approvals[0]
        assertEquals("app_019318894978701388bb69b7f5256011", first.id)
        assertEquals("run_019318894978701388bb69b7f5256010", first.runId)
        assertEquals("rm -rf /tmp/scratch", first.command)
        assertEquals("pending", first.status)
        assertNull(first.decidedBy)

        val second = approvals[1]
        assertEquals("approved", second.status)
        assertEquals("usr_019318894978701388bb69b7f5256001", second.decidedBy)

        val encoded = json.encodeToString(approvals)
        val roundtrip = json.decodeFromString<List<ApprovalView>>(encoded)
        assertEquals(approvals, roundtrip)
    }

    @Test
    fun testBoardTasksFixture() {
        val raw = readFixture("board-tasks.json")
        val board = json.decodeFromString<BoardTasksFixture>(raw)
        assertEquals(1, board.tasks.size)
        assertEquals("tsk_019318894978701388bb69b7f5256020", board.tasks[0].id)
        assertEquals("Setup Mobile Fixtures", board.tasks[0].title)
        assertEquals("Alice Cooper", board.tasks[0].assignee?.displayName)

        assertEquals(1, board.deps.size)
        assertEquals("tsk_019318894978701388bb69b7f5256019", board.deps[0].dependsOn)

        assertNotNull(board.detail)
        assertEquals(1, board.detail?.comments?.size)
        assertEquals("Work started on fixtures", board.detail?.comments?.get(0)?.body)

        val roundtrip = json.decodeFromString<BoardTasksFixture>(json.encodeToString(board))
        assertEquals(board, roundtrip)
    }

    @Test
    fun testChatMessagesFixture() {
        val raw = readFixture("chat-messages.json")
        val chat = json.decodeFromString<ChatMessagesFixture>(raw)
        assertEquals(1, chat.channels.size)
        assertEquals("general", chat.channels[0].name)

        assertEquals(1, chat.members.size)
        assertEquals("alice", chat.members[0].handle)

        assertEquals(1, chat.messages.size)
        assertTrue(chat.messages[0].body.contains("Wave M0 mobile client"))
        assertEquals(1, chat.messages[0].tasks.size)
        assertEquals(1, chat.messages[0].tasks[0].number)

        val roundtrip = json.decodeFromString<ChatMessagesFixture>(json.encodeToString(chat))
        assertEquals(chat, roundtrip)
    }

    @Test
    fun testCryptoP256VectorFixture() {
        val raw = readFixture("crypto-p256-vector.json")
        val vector = json.decodeFromString<CryptoP256Vector>(raw)

        assertEquals("http://localhost:4100", vector.rpOrigin)
        assertEquals("01931889-4978-7013-88bb-69b7f5256e65", vector.sessionId)
        assertEquals("ch_019318894978701388bb69b7f5256e65", vector.challengeId)
        assertEquals("test_nonce_123456789012345678901234567890", vector.nonce)

        val expectedPayload = DeviceKeySigner.buildStepUpPayload(
            vector.rpOrigin,
            vector.sessionId,
            vector.challengeId,
            vector.nonce
        )
        assertEquals(expectedPayload, vector.canonicalPayload)

        val verified = DeviceKeySigner.verifySignature(
            vector.canonicalPayload,
            vector.signature,
            vector.publicKeySpki
        )
        assertTrue("Golden P-256 vector signature verification must succeed", verified)

        val sigBytes = Base64.getUrlDecoder().decode(vector.signature)
        assertEquals(64, sigBytes.size)

        // Generate and verify a fresh signature
        val signer = JvmSoftwareSigner()
        val freshSig = signer.sign(vector.canonicalPayload)
        val freshSigBytes = Base64.getUrlDecoder().decode(freshSig)
        assertEquals(64, freshSigBytes.size)
        assertTrue(signer.verify(vector.canonicalPayload, freshSig))
    }

    @Test
    fun testDashboardFixture() {
        val raw = readFixture("dashboard.json")
        val dash = json.decodeFromString<DashboardFixture>(raw)
        assertEquals(1, dash.members.size)
        assertEquals("alice", dash.members[0].handle)
        assertEquals(0.45, dash.members[0].costUsd, 0.001)

        assertEquals(1, dash.quota.size)
        assertEquals("anthropic", dash.quota[0].provider)
        assertEquals(42.5, dash.quota[0].usedPercent!!, 0.001)

        assertEquals(1, dash.tasks.size)
        assertEquals("Setup Mobile Fixtures", dash.tasks[0].title)

        val roundtrip = json.decodeFromString<DashboardFixture>(json.encodeToString(dash))
        assertEquals(dash, roundtrip)
    }

    @Test
    fun testMeFixture() {
        val raw = readFixture("me.json")
        val me = json.decodeFromString<MeResponse>(raw)
        assertEquals("usr_019318894978701388bb69b7f5256001", me.user.id)
        assertEquals("alice@example.com", me.user.email)
        assertTrue(me.user.instanceAdmin)

        assertEquals("mobile", me.session.method)
        assertTrue(me.session.stepUpFresh)

        assertEquals(1, me.orgs.size)
        assertEquals("alice", me.orgs[0].slug)

        assertEquals(1, me.devices.size)
        assertEquals("Alice iPhone", me.devices[0].name)
        assertTrue(me.devices[0].current)

        val roundtrip = json.decodeFromString<MeResponse>(json.encodeToString(me))
        assertEquals(me, roundtrip)
    }

    @Test
    fun testMemoryFixture() {
        val raw = readFixture("memory.json")
        val memory = json.decodeFromString<MemoryFixture>(raw)

        assertEquals(2, memory.facets.scopes["global"])
        assertEquals(5, memory.facets.scopes["org"])
        assertEquals(2, memory.facets.tags["mobile"])

        assertEquals(1, memory.notes.size)
        assertEquals("architecture/mobile-auth.md", memory.notes[0].path)

        assertNotNull(memory.note)
        assertTrue(memory.note?.canWrite == true)
        assertTrue(memory.note?.body?.contains("IEEE P1363") == true)

        assertEquals("conflict", memory.conflict409?.error)
        assertEquals(1, memory.writes.size)
        assertEquals("create", memory.writes[0].op)

        assertEquals(1, memory.lessons.size)
        assertEquals("accepted", memory.lessons[0].status)

        val roundtrip = json.decodeFromString<MemoryFixture>(json.encodeToString(memory))
        assertEquals(memory, roundtrip)
    }

    @Test
    fun testMove409Fixture() {
        val raw = readFixture("move-409.json")
        val move409 = json.decodeFromString<Move409Fixture>(raw)

        assertFalse(move409.held.ok)
        assertEquals("held", move409.held.reason)
        assertEquals("mem_019318894978701388bb69b7f5256005", move409.held.holderId)

        assertFalse(move409.depsOpen.ok)
        assertEquals(listOf(42, 43), move409.depsOpen.open)

        assertFalse(move409.childrenOpen.ok)
        assertEquals(listOf(44), move409.childrenOpen.open)

        val roundtrip = json.decodeFromString<Move409Fixture>(json.encodeToString(move409))
        assertEquals(move409, roundtrip)
    }

    @Test
    fun testRunDetailFixture() {
        val raw = readFixture("run-detail.json")
        val detail = json.decodeFromString<RunDetail>(raw)

        assertEquals("run_019318894978701388bb69b7f5256010", detail.run.id)
        assertEquals("claude-code", detail.run.agentId)
        assertEquals("running", detail.run.state)

        assertEquals(3, detail.events.size)
        assertEquals("tool_call", detail.events[0].kind)
        assertEquals("command", detail.events[1].kind)
        assertEquals("guard", detail.events[2].kind)
        assertEquals("exfiltration_prevented", detail.events[2].guardRule)

        val roundtrip = json.decodeFromString<RunDetail>(json.encodeToString(detail))
        assertEquals(detail, roundtrip)
    }

    @Test
    fun testWsFramesFixture() {
        val raw = readFixture("ws-frames.json")
        val frames = json.decodeFromString<List<WsMessage>>(raw)
        assertEquals(7, frames.size)

        assertTrue(frames[0] is WsMessage.Event)
        assertEquals("run_019318894978701388bb69b7f5256010", (frames[0] as WsMessage.Event).runId)

        assertTrue(frames[1] is WsMessage.Run)
        assertEquals("run_019318894978701388bb69b7f5256010", (frames[1] as WsMessage.Run).run.id)

        assertTrue(frames[2] is WsMessage.Approval)
        assertEquals("app_019318894978701388bb69b7f5256011", (frames[2] as WsMessage.Approval).approval.id)

        assertTrue(frames[3] is WsMessage.Task)
        assertEquals("updated", (frames[3] as WsMessage.Task).kind)

        assertTrue(frames[4] is WsMessage.Chat)
        assertEquals("chn_019318894978701388bb69b7f5256030", (frames[4] as WsMessage.Chat).channelId)

        assertTrue(frames[5] is WsMessage.Dashboard)

        assertTrue(frames[6] is WsMessage.Memory)
        assertEquals("org_019318894978701388bb69b7f5256003", (frames[6] as WsMessage.Memory).orgId)

        val roundtrip = json.decodeFromString<List<WsMessage>>(json.encodeToString(frames))
        assertEquals(frames, roundtrip)
    }
}
