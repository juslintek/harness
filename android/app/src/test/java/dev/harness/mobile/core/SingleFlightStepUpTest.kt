package dev.harness.mobile.core

import dev.harness.mobile.core.crypto.JvmSoftwareSigner
import dev.harness.mobile.core.network.HarnessApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class SingleFlightStepUpTest {
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
    fun testThreeConcurrentStepUpCallsCoalesceToOne() = runBlocking {
        val optionsCount = AtomicInteger(0)
        val verifyCount = AtomicInteger(0)
        val initial403Count = AtomicInteger(0)
        val success200Count = AtomicInteger(0)
        val stepUpDone = AtomicBoolean(false)

        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.endsWith("/api/auth/me") -> {
                        MockResponse()
                            .setResponseCode(200)
                            .setHeader("Content-Type", "application/json")
                            .setBody("""{"user":{"id":"usr_1","email":"a@b.c","name":"A","instanceAdmin":true,"createdAt":1},"session":{"id":"ses_test_1","method":"mobile","stepUpAt":1,"stepUpFresh":true},"orgs":[],"devices":[]}""")
                    }
                    path.endsWith("/api/auth/mobile/step-up/options") -> {
                        optionsCount.incrementAndGet()
                        Thread.sleep(100) // Simulate network latency so peers arrive during flight
                        MockResponse()
                            .setResponseCode(200)
                            .setHeader("Content-Type", "application/json")
                            .setBody("""{"challengeId":"ch_test123","nonce":"nonce_test456"}""")
                    }
                    path.endsWith("/api/auth/mobile/step-up/verify") -> {
                        verifyCount.incrementAndGet()
                        stepUpDone.set(true)
                        MockResponse()
                            .setResponseCode(200)
                            .setHeader("Content-Type", "application/json")
                            .setBody("""{"ok":true,"stepUpAt":1700000000000}""")
                    }
                    path.endsWith("/api/protected") -> {
                        if (!stepUpDone.get()) {
                            initial403Count.incrementAndGet()
                            MockResponse()
                                .setResponseCode(403)
                                .setHeader("Content-Type", "application/json")
                                .setBody("""{"error":"step_up_required"}""")
                        } else {
                            success200Count.incrementAndGet()
                            MockResponse()
                                .setResponseCode(200)
                                .setHeader("Content-Type", "application/json")
                                .setBody("""{"status":"ok"}""")
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }

        val baseUrl = server.url("").toString().trimEnd('/')
        val signer = JvmSoftwareSigner()

        val apiClient = HarnessApiClient(
            baseUrl = baseUrl,
            tokenProvider = { "hmob_test_token" },
            signerProvider = { signer }
        )

        // Launch 3 concurrent requests hitting the protected endpoint
        val deferredResponses = (1..3).map {
            async(Dispatchers.IO) {
                val req = Request.Builder()
                    .url("$baseUrl/api/protected")
                    .get()
                    .build()
                val resp = apiClient.client.newCall(req).execute()
                val code = resp.code
                val body = resp.body?.string() ?: ""
                resp.close()
                code to body
            }
        }

        val results = deferredResponses.awaitAll()

        // Verify that all 3 returned HTTP 200 with ok status
        assertEquals(3, results.size)
        results.forEach { (code, body) ->
            assertEquals("Response should be 200 OK after automatic step-up", 200, code)
            assertTrue("Body should contain ok", body.contains("\"status\":\"ok\""))
        }

        // Verify that only 1 step-up/options and 1 step-up/verify call was performed!
        assertEquals("Exactly 1 step-up options call must be made across all 3 concurrent requests", 1, optionsCount.get())
        assertEquals("Exactly 1 step-up verify call must be made across all 3 concurrent requests", 1, verifyCount.get())
        assertEquals("All 3 requests replayed to 200", 3, success200Count.get())
    }
}
