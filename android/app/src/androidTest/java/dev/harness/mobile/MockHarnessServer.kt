package dev.harness.mobile

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

class MockHarnessServer {
    private val server = MockWebServer()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private var devicePublicKeySpki: String? = null
    private var stepUpVerified = false
    private var approvalDecided = false
    private val extraChatMessages = mutableListOf<JsonObject>()

    private lateinit var meRaw: String
    private lateinit var approvalsArr: JsonArray
    private lateinit var boardObj: JsonObject
    private lateinit var runDetailObj: JsonObject
    private lateinit var chatObj: JsonObject
    private lateinit var dashboardRaw: String
    private lateinit var memoryObj: JsonObject

    val baseUrl: String get() = server.url("").toString().trimEnd('/')

    fun start(): String {
        loadFixtures()
        server.dispatcher = createDispatcher()
        server.start()
        return baseUrl
    }

    fun shutdown() {
        server.shutdown()
    }

    private fun loadAsset(name: String): String {
        val ctx = InstrumentationRegistry.getInstrumentation().context
        return ctx.assets.open(name).bufferedReader().use { it.readText() }
    }

    private fun loadFixtures() {
        meRaw = loadAsset("me.json")
        approvalsArr = json.parseToJsonElement(loadAsset("approvals.json")).jsonArray
        boardObj = json.parseToJsonElement(loadAsset("board-tasks.json")).jsonObject
        runDetailObj = json.parseToJsonElement(loadAsset("run-detail.json")).jsonObject
        chatObj = json.parseToJsonElement(loadAsset("chat-messages.json")).jsonObject
        dashboardRaw = loadAsset("dashboard.json")
        memoryObj = json.parseToJsonElement(loadAsset("memory.json")).jsonObject
    }

    private fun verifyEcdsaP256(spkiBase64: String, canonicalPayload: String, signatureBase64: String): Boolean {
        return try {
            val spkiBytes = Base64.getDecoder().decode(spkiBase64)
            val pubKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spkiBytes))
            val sigBytes = Base64.getDecoder().decode(signatureBase64)
            val sig = Signature.getInstance("SHA256withECDSA")
            sig.initVerify(pubKey)
            sig.update(canonicalPayload.toByteArray(Charsets.UTF_8))
            sig.verify(sigBytes)
        } catch (_: Exception) {
            false
        }
    }

    private fun okJson(body: String) = MockResponse()
        .setResponseCode(200)
        .addHeader("Content-Type", "application/json")
        .setBody(body)

    private fun createDispatcher(): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl?.encodedPath ?: "/"
            val method = request.method ?: "GET"
            val bodyStr = request.body.readUtf8()

            return when {
                path == "/api/auth/mobile/pair/options" && method == "POST" -> okJson(
                    """{"challengeId":"chg_pair_1","nonce":"nonce_pair_1","rpOrigin":"$baseUrl"}"""
                )
                path == "/api/auth/mobile/pair/verify" && method == "POST" -> handlePairVerify(bodyStr)
                path == "/api/auth/mobile/step-up/options" && method == "POST" -> okJson(
                    """{"challengeId":"chg_step_1","nonce":"nonce_step_1"}"""
                )
                path == "/api/auth/mobile/step-up/verify" && method == "POST" -> handleStepUpVerify(bodyStr)
                path == "/api/auth/me" -> okJson(meRaw)
                path == "/api/halt" -> okJson("""{"halted":true}""")
                path == "/api/approvals" -> okJson(buildLiveApprovals())
                path.startsWith("/api/approvals/") && method == "POST" ->
                    handleApprovalDecision()
                path == "/api/orgs/alice" -> okJson(buildOrgDetail())
                path.startsWith("/api/projects/") && path.endsWith("/tasks") ->
                    okJson(boardObj["tasks"]!!.toString())
                path.startsWith("/api/projects/") && path.endsWith("/deps") ->
                    okJson(boardObj["deps"]!!.toString())
                path.startsWith("/api/tasks/") -> okJson(boardObj["detail"]!!.toString())
                path == "/api/runs" -> okJson(buildJsonArray { add(runDetailObj["run"]!!) }.toString())
                path.startsWith("/api/runs/") -> okJson(runDetailObj.toString())
                path == "/api/orgs/alice/channels" -> okJson(chatObj["channels"]!!.toString())
                path.startsWith("/api/channels/") && path.endsWith("/messages") && method == "GET" ->
                    okJson(buildChatMessages())
                path.startsWith("/api/channels/") && path.endsWith("/messages") && method == "POST" ->
                    handlePostChatMessage(bodyStr)
                path.startsWith("/api/channels/") && path.endsWith("/read") -> okJson("{}")
                path == "/api/orgs/alice/dashboard" -> okJson(dashboardRaw)
                path == "/api/orgs/alice/memory/facets" -> okJson(memoryObj["facets"]!!.toString())
                path == "/api/orgs/alice/memory/notes" -> okJson(memoryObj["notes"]!!.toString())
                path == "/api/orgs/alice/memory/writes" -> okJson("[]")
                path == "/api/orgs/alice/memory/lessons" -> okJson("[]")
                path == "/api/notify/prefs" -> okJson("""{"prefs":{}}""")
                path == "/api/notify/targets" -> okJson("[]")
                path == "/api/auth/mobile/devices" -> okJson("[]")
                else -> MockResponse().setResponseCode(404).setBody("""{"error":"not_found"}""")
            }
        }
    }

    private fun handlePairVerify(bodyStr: String): MockResponse {
        val obj = json.parseToJsonElement(bodyStr).jsonObject
        val spki = obj["publicKeySpki"]?.jsonPrimitive?.content ?: ""
        val sig = obj["signature"]?.jsonPrimitive?.content ?: ""
        val challengeId = obj["challengeId"]?.jsonPrimitive?.content ?: ""
        val payload = "Harness|pair|1|$baseUrl|$challengeId|nonce_pair_1"
        if (!verifyEcdsaP256(spki, payload, sig)) {
            return MockResponse().setResponseCode(401).setBody("""{"error":"invalid_signature"}""")
        }
        devicePublicKeySpki = spki
        return okJson("""{"token":"tok_e2e_mobile"}""")
    }

    private fun handleStepUpVerify(bodyStr: String): MockResponse {
        val obj = json.parseToJsonElement(bodyStr).jsonObject
        val sig = obj["signature"]?.jsonPrimitive?.content ?: ""
        val challengeId = obj["challengeId"]?.jsonPrimitive?.content ?: ""
        val spki = devicePublicKeySpki ?: ""
        val payload = "Harness|step-up|1|$baseUrl|tok_e2e_mobile|$challengeId|nonce_step_1"
        if (!verifyEcdsaP256(spki, payload, sig)) {
            return MockResponse().setResponseCode(401).setBody("""{"error":"invalid_step_up_signature"}""")
        }
        stepUpVerified = true
        return okJson("{}")
    }

    private fun handleApprovalDecision(): MockResponse {
        if (!stepUpVerified) {
            return MockResponse()
                .setResponseCode(403)
                .addHeader("Content-Type", "application/json")
                .setBody("""{"error":"step_up_required"}""")
        }
        approvalDecided = true
        return okJson("""{"ok":true}""")
    }

    private fun buildLiveApprovals(): String {
        val futureExpiry = System.currentTimeMillis() + 300_000L
        val updated = buildJsonArray {
            approvalsArr.forEach { el ->
                val obj = el.jsonObject
                val id = obj["id"]?.jsonPrimitive?.content
                val nextMap = obj.toMutableMap()
                nextMap["expiresAt"] = JsonPrimitive(futureExpiry)
                if (approvalDecided && id == "app_019318894978701388bb69b7f5256011") {
                    nextMap["status"] = JsonPrimitive("approved")
                }
                add(JsonObject(nextMap))
            }
        }
        return updated.toString()
    }

    private fun buildOrgDetail(): String = buildJsonObject {
        put("org", json.parseToJsonElement(meRaw).jsonObject["orgs"]!!.jsonArray[0])
        put("projects", buildJsonArray {
            add(buildJsonObject {
                put("id", "prj_019318894978701388bb69b7f5256006")
                put("orgId", "org_019318894978701388bb69b7f5256003")
                put("slug", "mobile")
                put("name", "Mobile Harness")
            })
        })
        put("members", chatObj["members"]!!)
    }.toString()

    private fun buildChatMessages(): String {
        val base = chatObj["messages"]!!.jsonArray
        return buildJsonArray {
            base.forEach { add(it) }
            extraChatMessages.forEach { add(it) }
        }.toString()
    }

    private fun handlePostChatMessage(bodyStr: String): MockResponse {
        val reqObj = json.parseToJsonElement(bodyStr).jsonObject
        val text = reqObj["body"]?.jsonPrimitive?.content ?: ""
        val msg = buildJsonObject {
            put("id", "msg_e2e_${extraChatMessages.size + 1}")
            put("channelId", "chn_019318894978701388bb69b7f5256030")
            put("authorId", "mem_019318894978701388bb69b7f5256005")
            put("author", chatObj["members"]!!.jsonArray[0])
            put("body", text)
            put("createdAt", System.currentTimeMillis())
            put("replyCount", 0)
            put("mentions", buildJsonArray {})
            put("taskIds", buildJsonArray {})
            put("tasks", buildJsonArray {})
        }
        extraChatMessages.add(msg)
        return okJson(msg.toString())
    }
}
