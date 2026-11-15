package dev.harness.mobile.features.board

import dev.harness.mobile.core.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

interface BoardRepository {
    suspend fun getOrgDetail(slug: String): OrgDetailResponse
    suspend fun getProjectTasks(projectId: String, status: String? = null, assigneeId: String? = null): List<TaskView>
    suspend fun getProjectDeps(projectId: String): List<TaskDepRef>
    suspend fun createTask(projectId: String, body: CreateTaskBody): TaskView
    suspend fun moveTask(taskId: String, to: String, beforeId: String? = null): MoveTaskResult
    suspend fun getTaskDetail(taskId: String): TaskDetail
    suspend fun patchTask(taskId: String, body: TaskPatchBody): TaskView
    suspend fun checkoutTask(taskId: String): MoveTaskResult
    suspend fun releaseTask(taskId: String): MoveTaskResult
    suspend fun wakeMember(memberId: String, taskId: String): Boolean
    suspend fun addDep(taskId: String, dependsOn: String): Boolean
    suspend fun removeDep(taskId: String, dependsOn: String): Boolean
    suspend fun addComment(taskId: String, body: String): CommentView
}

class BoardHttpRepository(
    private val baseUrlProvider: () -> String,
    private val tokenProvider: () -> String?,
    private val client: OkHttpClient = OkHttpClient(),
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }
) : BoardRepository {

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private fun buildRequest(path: String, method: String, body: RequestBody? = null): Request {
        val base = baseUrlProvider().trimEnd('/')
        val builder = Request.Builder()
            .url("$base$path")
            .header("Origin", base)
            .header("X-Harness-Mobile", "1")
        val token = tokenProvider()
        if (!token.isNullOrBlank()) {
            builder.header("Authorization", "Bearer $token")
        }
        when (method.uppercase()) {
            "GET" -> builder.get()
            "POST" -> builder.post(body ?: "{}".toRequestBody(jsonMediaType))
            "PATCH" -> builder.patch(body ?: "{}".toRequestBody(jsonMediaType))
            "DELETE" -> builder.delete(body)
        }
        return builder.build()
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

    private fun parseMoveFailure(rawJson: String): MoveFailureParsed {
        return try {
            val element = json.parseToJsonElement(rawJson).jsonObject
            val reason = element["reason"]?.jsonPrimitive?.content ?: ""
            when (reason) {
                "held" -> {
                    val held = json.decodeFromString<MoveFailureHeld>(rawJson)
                    MoveFailureParsed.Held(held.holderId)
                }
                "deps_open" -> {
                    val deps = json.decodeFromString<MoveFailureDepsOpen>(rawJson)
                    MoveFailureParsed.DepsOpen(deps.open)
                }
                "children_open" -> {
                    val children = json.decodeFromString<MoveFailureChildrenOpen>(rawJson)
                    MoveFailureParsed.ChildrenOpen(children.open)
                }
                else -> MoveFailureParsed.Generic(element["error"]?.jsonPrimitive?.content ?: rawJson)
            }
        } catch (_: Exception) {
            MoveFailureParsed.Generic(rawJson)
        }
    }

    override suspend fun getOrgDetail(slug: String): OrgDetailResponse = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/orgs/$slug", "GET")
        execute(req)
    }

    override suspend fun getProjectTasks(projectId: String, status: String?, assigneeId: String?): List<TaskView> = withContext(Dispatchers.IO) {
        val queryParams = mutableListOf<String>()
        if (!status.isNullOrBlank()) queryParams.add("status=$status")
        if (!assigneeId.isNullOrBlank()) queryParams.add("assigneeId=$assigneeId")
        val queryString = if (queryParams.isEmpty()) "" else "?${queryParams.joinToString("&")}"
        val req = buildRequest("/api/projects/$projectId/tasks$queryString", "GET")
        execute(req)
    }

    override suspend fun getProjectDeps(projectId: String): List<TaskDepRef> = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/projects/$projectId/deps", "GET")
        execute(req)
    }

    override suspend fun createTask(projectId: String, body: CreateTaskBody): TaskView = withContext(Dispatchers.IO) {
        val jsonBody = json.encodeToString(body).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/projects/$projectId/tasks", "POST", jsonBody)
        execute(req)
    }

    override suspend fun moveTask(taskId: String, to: String, beforeId: String?): MoveTaskResult = withContext(Dispatchers.IO) {
        val body = json.encodeToString(MoveBody(to = to, beforeId = beforeId)).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/tasks/$taskId/move", "POST", body)
        val resp = client.newCall(req).execute()
        val text = resp.body?.string() ?: ""
        if (resp.isSuccessful) {
            MoveTaskResult.Success(json.decodeFromString<TaskView>(text))
        } else {
            val failure = parseMoveFailure(text)
            MoveTaskResult.Failure(failure, formatMoveFailureMessage(failure))
        }
    }

    override suspend fun getTaskDetail(taskId: String): TaskDetail = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/tasks/$taskId", "GET")
        execute(req)
    }

    override suspend fun patchTask(taskId: String, body: TaskPatchBody): TaskView = withContext(Dispatchers.IO) {
        val jsonBody = json.encodeToString(body).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/tasks/$taskId", "PATCH", jsonBody)
        execute(req)
    }

    override suspend fun checkoutTask(taskId: String): MoveTaskResult = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/tasks/$taskId/checkout", "POST", "{}".toRequestBody(jsonMediaType))
        val resp = client.newCall(req).execute()
        val text = resp.body?.string() ?: ""
        if (resp.isSuccessful) {
            MoveTaskResult.Success(json.decodeFromString<TaskView>(text))
        } else {
            val failure = parseMoveFailure(text)
            MoveTaskResult.Failure(failure, formatMoveFailureMessage(failure))
        }
    }

    override suspend fun releaseTask(taskId: String): MoveTaskResult = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/tasks/$taskId/release", "POST", "{}".toRequestBody(jsonMediaType))
        val resp = client.newCall(req).execute()
        val text = resp.body?.string() ?: ""
        if (resp.isSuccessful) {
            MoveTaskResult.Success(json.decodeFromString<TaskView>(text))
        } else {
            val failure = parseMoveFailure(text)
            MoveTaskResult.Failure(failure, formatMoveFailureMessage(failure))
        }
    }

    override suspend fun wakeMember(memberId: String, taskId: String): Boolean = withContext(Dispatchers.IO) {
        val body = """{"taskId":"$taskId"}""".toRequestBody(jsonMediaType)
        val req = buildRequest("/api/members/$memberId/wake", "POST", body)
        val resp = client.newCall(req).execute()
        val ok = resp.isSuccessful
        resp.close()
        ok
    }

    override suspend fun addDep(taskId: String, dependsOn: String): Boolean = withContext(Dispatchers.IO) {
        val body = json.encodeToString(DepBody(dependsOn)).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/tasks/$taskId/deps", "POST", body)
        val resp = client.newCall(req).execute()
        val ok = resp.isSuccessful
        resp.close()
        ok
    }

    override suspend fun removeDep(taskId: String, dependsOn: String): Boolean = withContext(Dispatchers.IO) {
        val body = json.encodeToString(DepBody(dependsOn)).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/tasks/$taskId/deps", "DELETE", body)
        val resp = client.newCall(req).execute()
        val ok = resp.isSuccessful
        resp.close()
        ok
    }

    override suspend fun addComment(taskId: String, body: String): CommentView = withContext(Dispatchers.IO) {
        val jsonBody = json.encodeToString(CommentBody(body)).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/tasks/$taskId/comments", "POST", jsonBody)
        execute(req)
    }
}
