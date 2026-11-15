package dev.harness.mobile.features.approvals

import dev.harness.mobile.core.crypto.TokenStore
import dev.harness.mobile.core.model.MeResponse
import dev.harness.mobile.core.model.OrgView
import dev.harness.mobile.core.model.SessionView
import dev.harness.mobile.core.model.UserView
import dev.harness.mobile.core.store.SessionRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
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
class ApprovalsViewModelTest {

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
                        slug = "test-org",
                        name = "Test Org",
                        role = orgRole
                    )
                )
            )
        )
    }

    @Test
    fun testNonAdminRoleGatingDoesNotFetchApprovals() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = false, orgRole = "member")
        val requestCount = AtomicInteger(0)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requestCount.incrementAndGet()
                return MockResponse().setResponseCode(403)
            }
        }

        val viewModel = ApprovalsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.loadApprovals()
        testScheduler.advanceUntilIdle()

        assertFalse("Non-admin role must not have canManageApprovals", viewModel.uiState.value.canManageApprovals)
        assertEquals("Server must not be contacted when role gate prevents access", 0, requestCount.get())
        assertTrue("Pending list must remain empty", viewModel.uiState.value.pendingApprovals.isEmpty())
    }

    @Test
    fun testPendingApprovalsLoad() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = true, orgRole = "member")
        val pendingJson = """[{"id":"app_01","runId":"run_01","command":"rm -rf /tmp/scratch","reason":"Clean temporary artifacts","status":"pending","createdAt":1700000000000,"expiresAt":1700000300000}]"""

        val allJson = """[
            {"id":"app_01","runId":"run_01","command":"rm -rf /tmp/scratch","reason":"Clean temporary artifacts","status":"pending","createdAt":1700000000000,"expiresAt":1700000300000},
            {"id":"app_02","runId":"run_01","command":"git push origin main","reason":"Push release tag","status":"approved","decidedBy":"usr_01","createdAt":1700000000000,"expiresAt":1700000300000,"decidedAt":1700000050000}
        ]"""

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.contains("status=pending") -> MockResponse().setResponseCode(200).setBody(pendingJson)
                    path.endsWith("/api/approvals") -> MockResponse().setResponseCode(200).setBody(allJson)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val viewModel = ApprovalsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.loadApprovals()
        testScheduler.advanceUntilIdle()

        assertTrue(viewModel.uiState.value.canManageApprovals)
        assertEquals(1, viewModel.uiState.value.pendingApprovals.size)
        assertEquals("app_01", viewModel.uiState.value.pendingApprovals.first().id)
        assertEquals(1, viewModel.uiState.value.resolvedApprovals.size)
        assertEquals("app_02", viewModel.uiState.value.resolvedApprovals.first().id)
    }

    @Test
    fun testApproveAndDeny() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = true, orgRole = "admin")
        var recordedBody = ""
        var recordedPath = ""

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                if (request.method == "POST") {
                    recordedPath = path
                    recordedBody = request.body.readUtf8()
                }
                return when {
                    path.endsWith("/api/approvals/app_01") -> {
                        MockResponse().setResponseCode(200).setBody("""{"id":"app_01","runId":"run_01","command":"rm -rf /tmp/scratch","status":"approved","decidedBy":"usr_01","createdAt":1700000000000,"expiresAt":1700000300000,"decidedAt":1700000050000}""")
                    }
                    path.contains("/api/approvals?status=pending") -> {
                        MockResponse().setResponseCode(200).setBody("[]")
                    }
                    path.endsWith("/api/approvals") -> {
                        MockResponse().setResponseCode(200).setBody("""[{"id":"app_01","runId":"run_01","command":"rm -rf /tmp/scratch","status":"approved","decidedBy":"usr_01","createdAt":1700000000000,"expiresAt":1700000300000,"decidedAt":1700000050000}]""")
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val viewModel = ApprovalsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.decide("app_01", "approve")
        testScheduler.advanceUntilIdle()

        assertTrue(recordedPath.endsWith("/api/approvals/app_01"))
        assertTrue(recordedBody.contains("approve"))
        assertTrue(viewModel.uiState.value.conflictBanner == null)
        assertTrue(viewModel.uiState.value.adminRequiredBanner == null)
    }

    @Test
    fun test409ConflictBanner() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = true, orgRole = "owner")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (request.method == "POST") {
                    MockResponse().setResponseCode(409).setBody("""{"error":"not pending"}""")
                } else {
                    MockResponse().setResponseCode(200).setBody("[]")
                }
            }
        }

        val viewModel = ApprovalsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.decide("app_01", "approve")
        testScheduler.advanceUntilIdle()

        assertNotNull("Conflict banner must be populated on 409", viewModel.uiState.value.conflictBanner)
        assertTrue(viewModel.uiState.value.conflictBanner!!.contains("not pending") || viewModel.uiState.value.conflictBanner!!.contains("already decided"))
    }

    @Test
    fun test403InstanceAdminRequiredBanner() = runTest(testDispatcher) {
        authenticateUser(instanceAdmin = false, orgRole = "admin")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (request.method == "POST") {
                    MockResponse().setResponseCode(403).setBody("""{"error":"instance_admin_required","reason":"root command"}""")
                } else {
                    MockResponse().setResponseCode(200).setBody("[]")
                }
            }
        }

        val viewModel = ApprovalsViewModel(
            session = session,
            baseUrl = server.url("/").toString().trimEnd('/'),
            coroutineScope = this
        )

        viewModel.decide("app_01", "approve")
        testScheduler.advanceUntilIdle()

        assertNotNull("Admin required banner must be populated on 403 instance_admin_required", viewModel.uiState.value.adminRequiredBanner)
        assertTrue(viewModel.uiState.value.adminRequiredBanner!!.contains("Instance admin required"))
    }

    @Test
    fun testCountdownCalculation() {
        val now = 1700000000000L
        val viewModel = ApprovalsViewModel(session = session)

        val expiresFar = now + 120_000L // 120s
        assertEquals(120L, viewModel.remainingSeconds(expiresFar, now))
        assertFalse(viewModel.isDangerCountdown(120L))
        assertFalse(viewModel.isExpired(120L))
        assertEquals("02:00", viewModel.formatCountdown(120L))

        val expiresDanger = now + 25_000L // 25s
        assertEquals(25L, viewModel.remainingSeconds(expiresDanger, now))
        assertTrue(viewModel.isDangerCountdown(25L))
        assertFalse(viewModel.isExpired(25L))
        assertEquals("00:25", viewModel.formatCountdown(25L))

        val expiresZero = now
        assertEquals(0L, viewModel.remainingSeconds(expiresZero, now))
        assertFalse(viewModel.isDangerCountdown(0L))
        assertTrue(viewModel.isExpired(0L))
        assertEquals("Expired", viewModel.formatCountdown(0L))

        val expiredPast = now - 5_000L
        assertEquals(0L, viewModel.remainingSeconds(expiredPast, now))
        assertTrue(viewModel.isExpired(0L))
    }
}
