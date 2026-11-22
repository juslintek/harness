package dev.harness.mobile.features.runs

import dev.harness.mobile.core.crypto.TokenStore
import dev.harness.mobile.core.model.MeResponse
import dev.harness.mobile.core.model.OrgView
import dev.harness.mobile.core.model.SessionView
import dev.harness.mobile.core.model.UserView
import dev.harness.mobile.core.model.WsEventPayload
import dev.harness.mobile.core.model.WsMessage
import dev.harness.mobile.core.store.SessionRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

private class FakeTokenStore : TokenStore {
    private val tokens = mutableMapOf<String, String>()
    override suspend fun saveToken(key: String, token: String) { tokens[key] = token }
    override suspend fun getToken(key: String): String? = tokens[key]
    override suspend fun removeToken(key: String) { tokens.remove(key) }
    override suspend fun clear() { tokens.clear() }
}

@OptIn(ExperimentalCoroutinesApi::class)
class RunsViewModelTest {

    private lateinit var server: MockWebServer
    private lateinit var session: SessionRepository
    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        session = SessionRepository(FakeTokenStore())
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private suspend fun authenticateUser(instanceAdmin: Boolean, orgRole: String) {
        session.authenticate(
            token = "bearer_token_123",
            meResponse = MeResponse(
                user = UserView(
                    id = "usr_01",
                    email = "test@example.com",
                    name = "Test User",
                    instanceAdmin = instanceAdmin
                ),
                session = SessionView(id = "sess_01", method = "mobile"),
                orgs = listOf(
                    OrgView(
                        id = "org_01",
                        slug = "acme",
                        name = "Acme",
                        role = orgRole
                    )
                )
            )
        )
    }

    @Test
    fun testNonInstanceAdminWakeupFallback() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = false, orgRole = "admin")
        val runsHitCount = AtomicInteger(0)
        val wakeupsHitCount = AtomicInteger(0)

        val wakeupsJson = """
            [
              {
                "id": "wk_01",
                "memberId": "mem_01",
                "reason": "schedule",
                "status": "pending",
                "createdAt": 1700000000000
              }
            ]
        """.trimIndent()

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.endsWith("/api/runs") -> {
                        runsHitCount.incrementAndGet()
                        MockResponse().setResponseCode(403)
                    }
                    path.contains("/api/orgs/acme/wakeups") -> {
                        wakeupsHitCount.incrementAndGet()
                        MockResponse().setResponseCode(200).setBody(wakeupsJson)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val viewModel = RunsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.loadData()
        testScheduler.advanceUntilIdle()

        assertFalse("ViewModel must reflect !instanceAdmin", viewModel.uiState.value.isInstanceAdmin)
        assertEquals("Must not hit /api/runs when not instance admin", 0, runsHitCount.get())
        assertEquals("Must hit /api/orgs/:slug/wakeups", 1, wakeupsHitCount.get())
        assertEquals(1, viewModel.uiState.value.wakeups.size)
        assertEquals("wk_01", viewModel.uiState.value.wakeups.first().id)
        assertTrue(viewModel.uiState.value.canWakeMembers)
    }

    @Test
    fun testIncrementalAfterAppendAndDeduplicationOnWsNudge() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = true, orgRole = "owner")

        val initialDetailJson = """
            {
              "run": {
                "id": "run_01",
                "agentId": "claude-code",
                "repo": "harness",
                "prompt": "test",
                "state": "running",
                "createdAt": 1700000000000
              },
              "events": [
                {
                  "rowid": 1,
                  "ts": 1700000001000,
                  "kind": "tool_call",
                  "toolName": "read_file",
                  "body": "path/file.kt"
                },
                {
                  "rowid": 2,
                  "ts": 1700000002000,
                  "kind": "command",
                  "command": "git status",
                  "exitCode": 0
                }
              ]
            }
        """.trimIndent()

        val incrementalJson = """
            {
              "run": {
                "id": "run_01",
                "agentId": "claude-code",
                "repo": "harness",
                "prompt": "test",
                "state": "running",
                "createdAt": 1700000000000
              },
              "events": [
                {
                  "rowid": 2,
                  "ts": 1700000002000,
                  "kind": "command",
                  "command": "git status",
                  "exitCode": 0
                },
                {
                  "rowid": 3,
                  "ts": 1700000003000,
                  "kind": "command",
                  "command": "git diff",
                  "exitCode": 0
                }
              ]
            }
        """.trimIndent()

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.contains("/api/runs/run_01?after=0") -> {
                        MockResponse().setResponseCode(200).setBody(initialDetailJson)
                    }
                    path.contains("/api/runs/run_01?after=2") -> {
                        MockResponse().setResponseCode(200).setBody(incrementalJson)
                    }
                    path.contains("/api/approvals?status=pending") -> {
                        MockResponse().setResponseCode(200).setBody("[]")
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val viewModel = RunsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.selectRun("run_01")
        testScheduler.advanceUntilIdle()

        val initialEvents = viewModel.uiState.value.selectedRunDetail?.events ?: emptyList()
        assertEquals(2, initialEvents.size)
        assertEquals(listOf(1L, 2L), initialEvents.map { it.rowid })

        // Trigger incremental fetch via WS nudge
        viewModel.onRunWsNudge("run_01", WsMessage.Event("run_01", WsEventPayload("command", 1700000003000L)))
        testScheduler.advanceUntilIdle()

        val updatedEvents = viewModel.uiState.value.selectedRunDetail?.events ?: emptyList()
        assertEquals("Events must be deduplicated by rowid", 3, updatedEvents.size)
        assertEquals(listOf(1L, 2L, 3L), updatedEvents.map { it.rowid })
    }

    @Test
    fun test409HaltedStartError() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = true, orgRole = "owner")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (request.method == "POST" && (request.path ?: "").endsWith("/api/runs")) {
                    MockResponse().setResponseCode(409).setBody("""{"error":"instance is halted"}""")
                } else {
                    MockResponse().setResponseCode(200).setBody("[]")
                }
            }
        }

        val viewModel = RunsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.startRun(
            agentId = "claude-code",
            repo = "/Users/alice/projects/harness",
            prompt = "Do something",
            model = null
        )
        testScheduler.advanceUntilIdle()

        assertNotNull(viewModel.uiState.value.startRunHaltedError)
        assertTrue(viewModel.uiState.value.startRunHaltedError!!.contains("halted"))
    }

    @Test
    fun testKillRun() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = true, orgRole = "owner")
        var killedPath = ""
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.endsWith("/api/runs/run_01/kill") -> {
                        killedPath = path
                        MockResponse().setResponseCode(200).setBody("""{"ok":true}""")
                    }
                    path.endsWith("/api/runs") -> {
                        MockResponse().setResponseCode(200).setBody("[]")
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val viewModel = RunsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.killRun("run_01")
        testScheduler.advanceUntilIdle()

        assertTrue(killedPath.endsWith("/api/runs/run_01/kill"))
        assertFalse(viewModel.uiState.value.isKillingRun)
    }
}
