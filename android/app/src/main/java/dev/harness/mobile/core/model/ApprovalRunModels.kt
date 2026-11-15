package dev.harness.mobile.core.model

import kotlinx.serialization.Serializable

@Serializable
data class ApprovalView(
    val id: String,
    val runId: String,
    val command: String,
    val reason: String? = null,
    val status: String,
    val decidedBy: String? = null,
    val createdAt: Long,
    val expiresAt: Long,
    val decidedAt: Long? = null
)

@Serializable
data class DecisionBody(
    val decision: String
)

@Serializable
data class RunView(
    val id: String,
    val memberId: String? = null,
    val agentId: String,
    val model: String? = null,
    val repo: String,
    val branch: String? = null,
    val prompt: String,
    val state: String,
    val reason: String? = null,
    val createdAt: Long,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val inputTokens: Long = 0L,
    val outputTokens: Long = 0L
)

@Serializable
data class EventView(
    val rowid: Long,
    val ts: Long,
    val kind: String,
    val toolName: String? = null,
    val command: String? = null,
    val exitCode: Int? = null,
    val guardLayer: String? = null,
    val guardVerdict: String? = null,
    val guardRule: String? = null,
    val body: String? = null
)

@Serializable
data class RunDetail(
    val run: RunView,
    val events: List<EventView> = emptyList()
)

@Serializable
data class StartRunBody(
    val agentId: String,
    val repo: String,
    val prompt: String,
    val model: String? = null
)
