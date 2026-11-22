package dev.harness.mobile.features.chat

import dev.harness.mobile.core.model.*
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

interface ChatRepository {
    suspend fun getChannels(orgSlug: String): List<ChannelView>
    suspend fun createDm(orgSlug: String, memberId: String): ChannelView
    suspend fun createGroup(orgSlug: String, name: String, memberIds: List<String>): ChannelView
    suspend fun getChannelMembers(channelId: String): List<ChatMember>
    suspend fun getOrgMembers(orgSlug: String): List<ChatMember>
    suspend fun getMessages(
        channelId: String,
        limit: Int = 50,
        before: String? = null,
        threadRootId: String? = null
    ): List<MessageView>
    suspend fun postMessage(channelId: String, body: String, threadRootId: String? = null): MessageView
    suspend fun markRead(channelId: String): Boolean
}

class ChatHttpRepository(
    private val baseUrlProvider: () -> String,
    private val tokenProvider: () -> String?,
    private val client: OkHttpClient = OkHttpClient(),
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = false
    }
) : ChatRepository {

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
            "PUT" -> builder.put(body ?: "{}".toRequestBody(jsonMediaType))
            "DELETE" -> builder.delete(body)
        }
        return builder.build()
    }

    private inline fun <reified T> execute(request: Request): T {
        return client.newCall(request).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw IOException("HTTP ${resp.code}: $text")
            }
            json.decodeFromString(text)
        }
    }

    override suspend fun getChannels(orgSlug: String): List<ChannelView> = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/orgs/$orgSlug/channels", "GET")
        execute(req)
    }

    override suspend fun createDm(orgSlug: String, memberId: String): ChannelView = withContext(Dispatchers.IO) {
        val body = json.encodeToString(DmBody(memberId)).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/orgs/$orgSlug/dms", "POST", body)
        execute(req)
    }

    override suspend fun createGroup(orgSlug: String, name: String, memberIds: List<String>): ChannelView = withContext(Dispatchers.IO) {
        val body = json.encodeToString(GroupBody(name, memberIds)).toRequestBody(jsonMediaType)
        val req = buildRequest("/api/orgs/$orgSlug/groups", "POST", body)
        execute(req)
    }

    override suspend fun getChannelMembers(channelId: String): List<ChatMember> = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/channels/$channelId/members", "GET")
        execute(req)
    }

    override suspend fun getOrgMembers(orgSlug: String): List<ChatMember> = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/orgs/$orgSlug", "GET")
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                throw IOException("HTTP ${resp.code}: $text")
            }
            val orgDetail = json.decodeFromString<ChatOrgDetailResponse>(text)
            orgDetail.members
        }
    }

    override suspend fun getMessages(
        channelId: String,
        limit: Int,
        before: String?,
        threadRootId: String?
    ): List<MessageView> = withContext(Dispatchers.IO) {
        val params = mutableListOf("limit=$limit")
        if (!before.isNullOrBlank()) params.add("before=$before")
        if (!threadRootId.isNullOrBlank()) params.add("thread=$threadRootId")
        val qs = params.joinToString("&")
        val req = buildRequest("/api/channels/$channelId/messages?$qs", "GET")
        execute(req)
    }

    override suspend fun postMessage(
        channelId: String,
        body: String,
        threadRootId: String?
    ): MessageView = withContext(Dispatchers.IO) {
        val postBody = json.encodeToString(PostMessageBody(body = body, threadRootId = threadRootId))
            .toRequestBody(jsonMediaType)
        val req = buildRequest("/api/channels/$channelId/messages", "POST", postBody)
        execute(req)
    }

    override suspend fun markRead(channelId: String): Boolean = withContext(Dispatchers.IO) {
        val req = buildRequest("/api/channels/$channelId/read", "POST")
        client.newCall(req).execute().use { resp ->
            resp.isSuccessful
        }
    }
}

@kotlinx.serialization.Serializable
private data class ChatOrgDetailResponse(
    val members: List<ChatMember> = emptyList()
)
