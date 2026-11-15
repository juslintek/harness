package dev.harness.mobile.features.runs

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class WakeupView(
    val id: String,
    val memberId: String,
    val reason: String,
    val taskId: String? = null,
    val taskNumber: Int? = null,
    val channelId: String? = null,
    val channelName: String? = null,
    val messageId: String? = null,
    val detail: JsonElement? = null,
    val causedBy: String? = null,
    val status: String,
    val runId: String? = null,
    val createdAt: Long,
    val startedAt: Long? = null,
    val endedAt: Long? = null
)

@Serializable
data class WakeMemberBody(
    val taskId: String? = null
)

@Serializable
data class WakeMemberResponse(
    val id: String
)
