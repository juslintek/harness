package dev.harness.mobile.features.runs

import dev.harness.mobile.core.model.ApprovalView
import dev.harness.mobile.core.model.DecisionBody
import dev.harness.mobile.core.model.RunDetail
import dev.harness.mobile.core.model.RunView
import dev.harness.mobile.core.model.StartRunBody
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.core.store.SessionState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

class RunsRepository(
    private val baseUrl: String,
    private val httpClient: OkHttpClient,
    private val session: SessionRepository,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val json: Json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }
) {
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private fun token(): String? = (session.sessionState.value as? SessionState.Authenticated)?.token

    private fun authRequestBuilder(url: String): Request.Builder {
        val builder = Request.Builder().url(url).header("Origin", baseUrl).header("X-Harness-Mobile", "1")
        val tok = token()
        if (!tok.isNullOrBlank()) builder.header("Authorization", "Bearer $tok")
        return builder
    }

    suspend fun fetchRuns(): List<RunView> = withContext(ioDispatcher) {
        val req = authRequestBuilder("$baseUrl/api/runs").get().build()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}: ${resp.message}")
            json.decodeFromString<List<RunView>>(resp.body?.string() ?: "[]")
        }
    }

    suspend fun fetchWakeups(orgSlug: String): List<WakeupView> = withContext(ioDispatcher) {
        val req = authRequestBuilder("$baseUrl/api/orgs/$orgSlug/wakeups?limit=50").get().build()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}: ${resp.message}")
            json.decodeFromString<List<WakeupView>>(resp.body?.string() ?: "[]")
        }
    }

    suspend fun wakeMember(memberId: String, taskId: String?): Int = withContext(ioDispatcher) {
        val payload = json.encodeToString(WakeMemberBody(taskId))
        val req = authRequestBuilder("$baseUrl/api/members/$memberId/wake")
            .post(payload.toRequestBody(jsonMediaType))
            .build()
        httpClient.newCall(req).execute().use { it.code }
    }

    suspend fun startRun(agentId: String, repo: String, prompt: String, model: String?): Pair<Int, String> =
        withContext(ioDispatcher) {
            val payload = json.encodeToString(StartRunBody(agentId, repo, prompt, model))
            val req = authRequestBuilder("$baseUrl/api/runs")
                .post(payload.toRequestBody(jsonMediaType))
                .build()
            httpClient.newCall(req).execute().use { resp ->
                resp.code to (resp.body?.string() ?: "")
            }
        }

    suspend fun killRun(id: String) = withContext(ioDispatcher) {
        val req = authRequestBuilder("$baseUrl/api/runs/$id/kill")
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        httpClient.newCall(req).execute().use { }
    }

    suspend fun fetchRunDetail(runId: String, after: Long): RunDetail = withContext(ioDispatcher) {
        val req = authRequestBuilder("$baseUrl/api/runs/$runId?after=$after").get().build()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}: ${resp.message}")
            json.decodeFromString<RunDetail>(resp.body?.string() ?: "")
        }
    }

    suspend fun fetchPendingApprovals(): List<ApprovalView> = withContext(ioDispatcher) {
        val req = authRequestBuilder("$baseUrl/api/approvals?status=pending").get().build()
        httpClient.newCall(req).execute().use { resp ->
            if (resp.isSuccessful) {
                json.decodeFromString<List<ApprovalView>>(resp.body?.string() ?: "[]")
            } else emptyList()
        }
    }

    suspend fun decideApproval(approvalId: String, decision: String) = withContext(ioDispatcher) {
        val payload = json.encodeToString(DecisionBody(decision))
        val req = authRequestBuilder("$baseUrl/api/approvals/$approvalId")
            .post(payload.toRequestBody(jsonMediaType))
            .build()
        httpClient.newCall(req).execute().use { }
    }
}
