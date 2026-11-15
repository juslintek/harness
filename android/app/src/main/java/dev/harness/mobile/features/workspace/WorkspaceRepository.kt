package dev.harness.mobile.features.workspace

import dev.harness.mobile.core.model.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

interface WorkspaceRepository {
    suspend fun getDashboard(orgSlug: String, sinceMs: Long): DashboardFixture
    suspend fun getFacets(orgSlug: String): MemoryFacetCounts
    suspend fun getNotes(
        orgSlug: String,
        query: String? = null,
        scope: String? = null,
        type: String? = null,
        tag: String? = null
    ): List<NoteSummary>
    suspend fun getNote(orgSlug: String, noteId: String): NoteView
    suspend fun getBacklinks(orgSlug: String, noteId: String): List<NoteSummary>
    suspend fun resolveWikilink(orgSlug: String, noteId: String, target: String): NoteSummary?
    suspend fun createNote(orgSlug: String, request: CreateNoteRequest): NoteView
    suspend fun saveNote(orgSlug: String, noteId: String, request: UpdateNoteRequest): SaveNoteResult
    suspend fun deleteNote(orgSlug: String, noteId: String, baseHash: String): Boolean
    suspend fun getWrites(orgSlug: String, limit: Int = 50, agentsOnly: Boolean = false): List<NoteWriteFeedItem>
    suspend fun revertWrite(orgSlug: String, writeId: String): Boolean
    suspend fun getLessons(orgSlug: String, status: String? = null): List<LessonView>
    suspend fun decideLesson(orgSlug: String, lessonId: String, decision: String, reason: String): LessonView
    suspend fun getNotifyPrefs(orgSlug: String): List<PrefView>
    suspend fun updateNotifyPref(orgSlug: String, pref: PrefView): List<PrefView>
    suspend fun getTargets(orgSlug: String): List<TargetView>
    suspend fun registerMobilePush(orgSlug: String, body: MobilePushSubscribeBody): String
    suspend fun getDevices(): List<DeviceView>
    suspend fun revokeDevice(deviceId: String): Boolean
}

class WorkspaceHttpRepository(
    private val baseUrlProvider: () -> String,
    private val tokenProvider: () -> String?,
    private val client: OkHttpClient = OkHttpClient(),
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }
) : WorkspaceRepository {

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
            "POST" -> builder.post(body ?: "".toRequestBody(jsonMediaType))
            "PUT" -> builder.put(body ?: "".toRequestBody(jsonMediaType))
            "DELETE" -> if (body != null) builder.delete(body) else builder.delete()
            else -> builder.method(method, body)
        }
        return builder.build()
    }

    private inline fun <reified T> execute(request: Request): T {
        return client.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IOException("HTTP ${resp.code}: $text")
            }
            json.decodeFromString(text)
        }
    }

    override suspend fun getDashboard(orgSlug: String, sinceMs: Long): DashboardFixture =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/orgs/$orgSlug/dashboard?since=$sinceMs", "GET")
            execute(req)
        }

    override suspend fun getFacets(orgSlug: String): MemoryFacetCounts =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/orgs/$orgSlug/memory/facets", "GET")
            execute(req)
        }

    override suspend fun getNotes(
        orgSlug: String,
        query: String?,
        scope: String?,
        type: String?,
        tag: String?
    ): List<NoteSummary> = withContext(Dispatchers.IO) {
        val params = mutableListOf<String>()
        if (!query.isNullOrBlank()) params.add("q=${java.net.URLEncoder.encode(query, "UTF-8")}")
        if (!scope.isNullOrBlank()) params.add("scope=${java.net.URLEncoder.encode(scope, "UTF-8")}")
        if (!type.isNullOrBlank()) params.add("type=${java.net.URLEncoder.encode(type, "UTF-8")}")
        if (!tag.isNullOrBlank()) params.add("tag=${java.net.URLEncoder.encode(tag, "UTF-8")}")
        val queryStr = if (params.isNotEmpty()) "?" + params.joinToString("&") else ""
        val req = buildRequest("/api/orgs/$orgSlug/memory/notes$queryStr", "GET")
        execute(req)
    }

    override suspend fun getNote(orgSlug: String, noteId: String): NoteView =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/orgs/$orgSlug/memory/notes/$noteId", "GET")
            execute(req)
        }

    override suspend fun getBacklinks(orgSlug: String, noteId: String): List<NoteSummary> =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/orgs/$orgSlug/memory/notes/$noteId/backlinks", "GET")
            execute(req)
        }

    override suspend fun resolveWikilink(orgSlug: String, noteId: String, target: String): NoteSummary? =
        withContext(Dispatchers.IO) {
            val encodedTarget = java.net.URLEncoder.encode(target, "UTF-8")
            val req = buildRequest("/api/orgs/$orgSlug/memory/notes/$noteId/link?target=$encodedTarget", "GET")
            try {
                execute<NoteSummary>(req)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                null
            }
        }

    override suspend fun createNote(orgSlug: String, request: CreateNoteRequest): NoteView =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(request).toRequestBody(jsonMediaType)
            val req = buildRequest("/api/orgs/$orgSlug/memory/notes", "POST", body)
            execute(req)
        }

    override suspend fun saveNote(orgSlug: String, noteId: String, request: UpdateNoteRequest): SaveNoteResult =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(request).toRequestBody(jsonMediaType)
            val req = buildRequest("/api/orgs/$orgSlug/memory/notes/$noteId", "PUT", body)
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (resp.code == 409) {
                    return@withContext try {
                        val conflict = json.decodeFromString<MemoryConflict409>(text)
                        SaveNoteResult.Conflict(conflict.hash)
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        SaveNoteResult.Conflict("", "409 Conflict")
                    }
                }
                if (!resp.isSuccessful) {
                    return@withContext SaveNoteResult.Failure("HTTP ${resp.code}: $text")
                }
                try {
                    val note = json.decodeFromString<NoteView>(text)
                    SaveNoteResult.Success(note)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    SaveNoteResult.Failure(e.message ?: "Failed to parse note")
                }
            }
        }

    override suspend fun deleteNote(orgSlug: String, noteId: String, baseHash: String): Boolean =
        withContext(Dispatchers.IO) {
            val encodedHash = java.net.URLEncoder.encode(baseHash, "UTF-8")
            val req = buildRequest("/api/orgs/$orgSlug/memory/notes/$noteId?baseHash=$encodedHash", "DELETE")
            client.newCall(req).execute().use { resp -> resp.isSuccessful }
        }

    override suspend fun getWrites(orgSlug: String, limit: Int, agentsOnly: Boolean): List<NoteWriteFeedItem> =
        withContext(Dispatchers.IO) {
            val agentsFlag = if (agentsOnly) "1" else "0"
            val req = buildRequest("/api/orgs/$orgSlug/memory/writes?limit=$limit&agentsOnly=$agentsFlag", "GET")
            execute(req)
        }

    override suspend fun revertWrite(orgSlug: String, writeId: String): Boolean =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/orgs/$orgSlug/memory/writes/$writeId/revert", "POST")
            client.newCall(req).execute().use { resp -> resp.isSuccessful }
        }

    override suspend fun getLessons(orgSlug: String, status: String?): List<LessonView> =
        withContext(Dispatchers.IO) {
            val query = if (!status.isNullOrBlank()) "?status=${java.net.URLEncoder.encode(status, "UTF-8")}" else ""
            val req = buildRequest("/api/orgs/$orgSlug/memory/lessons$query", "GET")
            execute(req)
        }

    override suspend fun decideLesson(
        orgSlug: String,
        lessonId: String,
        decision: String,
        reason: String
    ): LessonView = withContext(Dispatchers.IO) {
        val body = json.encodeToString(DecideLessonRequest(decision, reason)).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/orgs/$orgSlug/memory/lessons/$lessonId", "POST", body)
        execute(req)
    }

    override suspend fun getNotifyPrefs(orgSlug: String): List<PrefView> =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/notify/prefs?org=$orgSlug", "GET")
            execute(req)
        }

    override suspend fun updateNotifyPref(orgSlug: String, pref: PrefView): List<PrefView> =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(pref).toRequestBody(jsonMediaType)
            val req = buildRequest("/api/notify/prefs?org=$orgSlug", "PUT", body)
            execute(req)
        }

    override suspend fun getTargets(orgSlug: String): List<TargetView> =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/notify/targets?org=$orgSlug", "GET")
            execute(req)
        }

    override suspend fun registerMobilePush(orgSlug: String, body: MobilePushSubscribeBody): String =
        withContext(Dispatchers.IO) {
            val reqBody = json.encodeToString(body).toRequestBody(jsonMediaType)
            val req = buildRequest("/api/notify/push/mobile?org=$orgSlug", "POST", reqBody)
            val res = execute<TargetIdResponse>(req)
            res.id
        }

    override suspend fun getDevices(): List<DeviceView> =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/auth/mobile/devices", "GET")
            execute(req)
        }

    override suspend fun revokeDevice(deviceId: String): Boolean =
        withContext(Dispatchers.IO) {
            val req = buildRequest("/api/auth/mobile/devices/$deviceId", "DELETE")
            client.newCall(req).execute().use { resp -> resp.isSuccessful }
        }
}
