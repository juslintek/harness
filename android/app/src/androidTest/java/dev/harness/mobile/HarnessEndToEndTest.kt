package dev.harness.mobile

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.printToString
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.harness.mobile.core.crypto.DeviceKeySigner
import dev.harness.mobile.core.crypto.TokenStore
import dev.harness.mobile.core.store.InstanceConfig
import dev.harness.mobile.core.store.InstanceRepository
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.StudioNorthTheme
import dev.harness.mobile.ui.shell.HarnessAppShell
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private class InMemoryTokenStore : TokenStore {
    private val map = mutableMapOf<String, String>()
    override suspend fun saveToken(key: String, token: String) {
        map[key] = token
    }
    override suspend fun getToken(key: String): String? = map[key]
    override suspend fun removeToken(key: String) {
        map.remove(key)
    }
    override suspend fun clear() {
        map.clear()
    }
}

@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class HarnessEndToEndTest {

    @get:Rule
    val composeRule = createComposeRule()

    private var mockServer: MockHarnessServer? = null
    private lateinit var targetOrigin: String
    private lateinit var pairCode: String
    private lateinit var pairCodeDark: String
    private var isLiveServer: Boolean = false

    @Before
    fun setUp() {
        val args = InstrumentationRegistry.getArguments()
        val liveOrigin = args.getString("harnessOrigin")?.trim()
        val livePairCode = args.getString("harnessPairCode")?.trim()
        val livePairCodeDark = args.getString("harnessPairCodeDark")?.trim()
        val liveEnrollCode = args.getString("harnessEnrollCode")?.trim()

        if (!liveOrigin.isNullOrBlank()) {
            targetOrigin = liveOrigin.trimEnd('/')
            pairCode = livePairCode?.takeIf { it.isNotBlank() }
                ?: liveEnrollCode?.takeIf { it.isNotBlank() }
                ?: "PAIR-LIVE"
            pairCodeDark = livePairCodeDark?.takeIf { it.isNotBlank() } ?: pairCode
            isLiveServer = true
        } else {
            val server = MockHarnessServer()
            targetOrigin = server.start()
            mockServer = server
            pairCode = "PAIR-E2E"
            pairCodeDark = "PAIR-E2E"
            isLiveServer = false
        }
    }

    @After
    fun tearDown() {
        mockServer?.shutdown()
        mockServer = null
    }

    @Test
    fun fullFlow_lightTheme() {
        runFullFlow(darkTheme = false)
    }

    @Test
    fun fullFlow_darkTheme() {
        runFullFlow(darkTheme = true)
    }

    private fun runFullFlow(darkTheme: Boolean) {
        val instanceRepo = InstanceRepository(
            listOf(InstanceConfig("e2e", "E2E Instance", targetOrigin))
        )
        val sessionRepo = SessionRepository(InMemoryTokenStore())
        val signer = DeviceKeySigner.create(alias = "harness_e2e_key_$darkTheme")

        composeRule.setContent {
            StudioNorthTheme(darkTheme = darkTheme) {
                HarnessAppShell(
                    instanceRepo = instanceRepo,
                    sessionRepo = sessionRepo,
                    deviceKeySigner = signer
                )
            }
        }

        // 1. Pair / Enroll
        composeRule.onNodeWithTag("input.origin_url").performTextReplacement(targetOrigin)
        composeRule.onNodeWithTag("input.pair_code")
            .performTextReplacement(if (darkTheme) pairCodeDark else pairCode)
        composeRule.onNodeWithTag("button.connect").performClick()

        // Wait for authenticated shell
        composeRule.waitUntil(timeoutMillis = 10_000) {
            runCatching {
                composeRule.onNodeWithTag("tab.approvals").assertIsDisplayed()
            }.isSuccess
        }

        // 2. Approvals step-up
        if (isLiveServer && darkTheme) {
            composeRule.onNodeWithText("Resolved").performClick()
            composeRule.waitUntilExactlyOneExists(
                hasText("Allow outbound APNs push relay test request"),
                timeoutMillis = 8_000
            )
        } else if (isLiveServer) {
            composeRule.waitUntilExactlyOneExists(
                hasText("Allow outbound APNs push relay test request"),
                timeoutMillis = 8_000
            )
            composeRule.onAllNodesWithText("Approve").onFirst().performClick()
            composeRule.waitUntilExactlyOneExists(
                hasText("No pending approvals requiring review."),
                timeoutMillis = 5_000
            )
        } else {
            composeRule.waitUntilExactlyOneExists(hasText("rm -rf /tmp/scratch"), timeoutMillis = 5_000)
            composeRule.onNodeWithTag("button.approve_app_019318894978701388bb69b7f5256011").performClick()
            composeRule.waitUntilExactlyOneExists(
                hasText("No pending approvals requiring review."),
                timeoutMillis = 5_000
            )
        }

        // 3. Board columns & task sheet
        composeRule.onNodeWithTag("tab.board").performClick()
        val boardTitle = if (isLiveServer) "Verify offline approval banner" else "Setup Mobile Fixtures"
        val boardDesc = if (isLiveServer) "Show expiry countdown for Guard approvals." else "Create deterministic fixtures for mobile client"
        composeRule.waitUntilExactlyOneExists(hasText(boardTitle), timeoutMillis = 8_000)
        composeRule.onNodeWithText(boardTitle).performClick()
        composeRule.waitUntilAtLeastOneExists(hasText(boardDesc), timeoutMillis = 5_000)
        composeRule.waitUntilExactlyOneExists(hasContentDescription("Close"), timeoutMillis = 5_000)
        composeRule.onNodeWithContentDescription("Close").performClick()

        // 4. Runs transcript
        composeRule.onNodeWithTag("tab.runs").performClick()
        val runPrompt = if (isLiveServer) "Wire push relay endpoints and tests" else "Fix bug in mobile auth"
        val runCmd = if (isLiveServer) "bun test tools/push-relay/relay.test.ts" else "bun test src/server/features/auth/mobile.test.ts"
        composeRule.waitUntilExactlyOneExists(hasText(runPrompt), timeoutMillis = 8_000)
        composeRule.onNodeWithText(runPrompt).performClick()
        composeRule.waitUntilExactlyOneExists(hasText(runCmd), timeoutMillis = 5_000)

        // 5. Chat send
        composeRule.onNodeWithTag("tab.chat").performClick()
        if (isLiveServer) {
            composeRule.waitUntilExactlyOneExists(hasText("#general"), timeoutMillis = 8_000)
            composeRule.onNodeWithText("#general").performClick()
            composeRule.waitUntilExactlyOneExists(hasText("Mobile App", substring = true), timeoutMillis = 5_000)
            composeRule.onNodeWithText("Mobile App", substring = true).performClick()
        }
        val chatSeedMsg = if (isLiveServer) "Kicked off mobile release checklist for Studio North." else "Wave M0 mobile client is ready for testing #1"
        composeRule.waitUntilExactlyOneExists(hasText(chatSeedMsg), timeoutMillis = 8_000)
        val chatOutgoing = if (darkTheme) "Hello from E2E dark" else "Hello from E2E"
        composeRule.onNodeWithTag("input.chat_composer").performTextInput(chatOutgoing)
        composeRule.onNodeWithTag("button.chat_send").performClick()
        composeRule.waitUntilExactlyOneExists(hasText(chatOutgoing), timeoutMillis = 5_000)
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            .uiAutomation.executeShellCommand("input keyevent 111").close()

        // 6. Workspace Dashboard & Memory
        composeRule.onNodeWithTag("tab.workspace").performClick()
        composeRule.waitUntilExactlyOneExists(hasText("Workspace Hub"), timeoutMillis = 5_000)
        composeRule.onNodeWithTag("workspace.tab.memory").performClick()
        val memTitle = if (isLiveServer) "Mobile Architecture" else "Mobile Device Authentication"
        try {
            composeRule.waitUntil(timeoutMillis = 8_000) {
                composeRule.onAllNodesWithText("Notes (0)").fetchSemanticsNodes().isEmpty()
            }
        } catch (t: Throwable) {
            throw AssertionError("Memory notes stayed 0. Tree:\n${composeRule.onRoot().printToString()}", t)
        }
        composeRule.onNodeWithTag("memory.notes.list").performScrollToNode(hasText(memTitle))
        composeRule.waitUntilExactlyOneExists(hasText(memTitle), timeoutMillis = 5_000)
    }
}
