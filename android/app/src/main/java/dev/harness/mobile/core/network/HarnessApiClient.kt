package dev.harness.mobile.core.network

import dev.harness.mobile.core.crypto.DeviceKeySigner
import dev.harness.mobile.core.model.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class HarnessApiClient(
    val baseUrl: String,
    private val tokenProvider: () -> String?,
    private val signerProvider: (() -> DeviceKeySigner)? = null,
    private val customClient: OkHttpClient? = null
) {
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    val stepUpCoordinator = SingleFlightStepUpCoordinator {
        performStepUp()
    }

    val client: OkHttpClient = customClient ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            val original = chain.request()
            val builder = original.newBuilder()
                .header("Origin", baseUrl)
                .header("X-Harness-Mobile", "1")

            val token = tokenProvider()
            if (!token.isNullOrBlank()) {
                builder.header("Authorization", "Bearer $token")
            }
            chain.proceed(builder.build())
        }
        .addInterceptor(StepUpInterceptor(stepUpCoordinator))
        .build()

    private fun performStepUp(): Boolean {
        val signer = signerProvider?.invoke() ?: return false
        val token = tokenProvider() ?: return false
        return try {
            val meReq = Request.Builder()
                .url("$baseUrl/api/auth/me")
                .get()
                .header("Origin", baseUrl)
                .header("X-Harness-Mobile", "1")
                .header("Authorization", "Bearer $token")
                .build()
            val meResp = client.newCall(meReq).execute()
            if (!meResp.isSuccessful) {
                meResp.close()
                return false
            }
            val meBody = meResp.body?.string() ?: return false
            val me = json.decodeFromString<MeResponse>(meBody)

            val optionsReq = Request.Builder()
                .url("$baseUrl/api/auth/mobile/step-up/options")
                .post("{}".toRequestBody(jsonMediaType))
                .header("Origin", baseUrl)
                .header("X-Harness-Mobile", "1")
                .header("Authorization", "Bearer $token")
                .build()

            val optionsResp = client.newCall(optionsReq).execute()
            if (!optionsResp.isSuccessful) {
                optionsResp.close()
                return false
            }
            val optionsBody = optionsResp.body?.string() ?: return false
            val options = json.decodeFromString<MobileStepUpOptionsResponse>(optionsBody)

            val canonical = DeviceKeySigner.buildStepUpPayload(
                rpOrigin = baseUrl,
                sessionId = me.session.id,
                challengeId = options.challengeId,
                nonce = options.nonce
            )
            val signature = signer.sign(canonical)
            val verifyBody = json.encodeToString(MobileStepUpVerifyBody(options.challengeId, signature))

            val verifyReq = Request.Builder()
                .url("$baseUrl/api/auth/mobile/step-up/verify")
                .post(verifyBody.toRequestBody(jsonMediaType))
                .header("Origin", baseUrl)
                .header("X-Harness-Mobile", "1")
                .header("Authorization", "Bearer $token")
                .build()

            val verifyResp = client.newCall(verifyReq).execute()
            val isOk = verifyResp.isSuccessful
            verifyResp.close()
            isOk
        } catch (_: Exception) {
            false
        }
    }

    fun getMe(): MeResponse {
        val req = Request.Builder().url("$baseUrl/api/auth/me").get().build()
        return execute(req)
    }

    fun postHalt(halted: Boolean): HaltResponse {
        val body = json.encodeToString(HaltBody(halted)).toRequestBody(jsonMediaType)
        val req = Request.Builder().url("$baseUrl/api/halt").post(body).build()
        return execute(req)
    }

    fun pairStart(): MobilePairStartResult {
        val req = Request.Builder()
            .url("$baseUrl/api/auth/mobile/pair/start")
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        return execute(req)
    }

    fun pairOptions(code: String, deviceName: String): MobilePairOptionsResponse {
        val body = json.encodeToString(MobilePairOptionsBody(code, deviceName)).toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url("$baseUrl/api/auth/mobile/pair/options")
            .post(body)
            .build()
        return execute(req)
    }

    fun pairVerify(verifyBody: MobilePairVerifyBody): MobilePairVerifyResponse {
        val body = json.encodeToString(verifyBody).toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url("$baseUrl/api/auth/mobile/pair/verify")
            .post(body)
            .build()
        return execute(req)
    }

    fun enrollOptions(code: String, body: MobileEnrollOptionsBody): MobileEnrollOptionsResponse {
        val reqBody = json.encodeToString(body).toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url("$baseUrl/api/auth/mobile/enroll/$code/options")
            .post(reqBody)
            .build()
        return execute(req)
    }

    fun enrollVerify(code: String, body: MobileEnrollVerifyBody): MobileEnrollVerifyResponse {
        val reqBody = json.encodeToString(body).toRequestBody(jsonMediaType)
        val req = Request.Builder()
            .url("$baseUrl/api/auth/mobile/enroll/$code/verify")
            .post(reqBody)
            .build()
        return execute(req)
    }

    fun getApprovals(): List<ApprovalView> {
        val req = Request.Builder().url("$baseUrl/api/approvals").get().build()
        return execute(req)
    }

    fun decideApproval(id: String, decision: String): ApprovalView {
        val body = json.encodeToString(DecisionBody(decision)).toRequestBody(jsonMediaType)
        val req = Request.Builder().url("$baseUrl/api/approvals/$id").post(body).build()
        return execute(req)
    }

    fun getTasks(): List<TaskView> {
        val req = Request.Builder().url("$baseUrl/api/tasks").get().build()
        return execute(req)
    }

    fun getRuns(): List<RunView> {
        val req = Request.Builder().url("$baseUrl/api/runs").get().build()
        return execute(req)
    }

    fun getChatMessages(channelId: String): List<MessageView> {
        val req = Request.Builder().url("$baseUrl/api/chat/channels/$channelId/messages").get().build()
        return execute(req)
    }

    private inline fun <reified T> execute(request: Request): T {
        val resp = client.newCall(request).execute()
        val text = resp.body?.string() ?: ""
        if (!resp.isSuccessful) {
            resp.close()
            throw IOException("HTTP ${resp.code}: $text")
        }
        return json.decodeFromString(text)
    }
}
