package dev.harness.mobile.core.model

import kotlinx.serialization.Serializable

@Serializable
data class DashboardToolCount(
    val name: String,
    val count: Int
)

@Serializable
data class DashboardMember(
    val memberId: String,
    val handle: String,
    val runs: Int = 0,
    val completed: Int = 0,
    val inputTokens: Long = 0L,
    val outputTokens: Long = 0L,
    val cacheReadTokens: Long = 0L,
    val costUsd: Double = 0.0,
    val costEstimated: Boolean = false,
    val unpricedEvents: Int = 0,
    val wallMs: Long = 0L,
    val activeMs: Long = 0L,
    val waitingMs: Long = 0L,
    val plannerMinutes: Int = 0,
    val reviewerMinutes: Int = 0,
    val tasksDone: Int = 0,
    val tools: List<DashboardToolCount> = emptyList(),
    val stack: List<String> = emptyList()
)

@Serializable
data class DashboardQuota(
    val provider: String,
    val window: String,
    val usedPercent: Double? = null,
    val resetsAt: Long? = null,
    val source: String,
    val ts: Long
)

@Serializable
data class DashboardTask(
    val number: Int,
    val title: String,
    val status: String,
    val assignee: String? = null,
    val plannerMinutes: Int? = null,
    val reviewerMinutes: Int? = null,
    val agentActiveMinutes: Int? = null
)

@Serializable
data class DashboardFixture(
    val members: List<DashboardMember> = emptyList(),
    val budgets: List<String> = emptyList(),
    val quota: List<DashboardQuota> = emptyList(),
    val tasks: List<DashboardTask> = emptyList()
)

@Serializable
data class MemoryFacetCounts(
    val scopes: Map<String, Int> = emptyMap(),
    val types: Map<String, Int> = emptyMap(),
    val tags: Map<String, Int> = emptyMap(),
    val sources: Map<String, Int> = emptyMap()
)

@Serializable
data class NoteSummary(
    val id: String,
    val path: String,
    val scope: String,
    val orgId: String? = null,
    val projectId: String? = null,
    val memberId: String? = null,
    val type: String,
    val title: String,
    val tags: List<String> = emptyList(),
    val sourceAgent: String = "",
    val confidence: Double = 1.0,
    val created: String = "",
    val updated: String = "",
    val hash: String = "",
    val snippet: String? = null
)

@Serializable
data class NoteView(
    val id: String,
    val path: String,
    val scope: String,
    val orgId: String? = null,
    val projectId: String? = null,
    val memberId: String? = null,
    val type: String,
    val title: String,
    val tags: List<String> = emptyList(),
    val sourceAgent: String = "",
    val confidence: Double = 1.0,
    val created: String = "",
    val updated: String = "",
    val hash: String = "",
    val body: String = "",
    val canWrite: Boolean = false
)

@Serializable
data class MemoryConflict409(
    val error: String,
    val hash: String
)

@Serializable
data class NoteWriteFeedItem(
    val id: String,
    val noteId: String,
    val path: String,
    val op: String,
    val actor: String,
    val runId: String? = null,
    val at: Long = 0L,
    val beforeHash: String? = null,
    val afterHash: String? = null,
    val before: String? = null,
    val after: String? = null,
    val canRevert: Boolean = false
)

@Serializable
data class LessonTaskRef(
    val number: Int,
    val projectId: String,
    val title: String
)

@Serializable
data class LessonView(
    val id: String,
    val taskId: String,
    val orgId: String,
    val projectId: String? = null,
    val authorId: String? = null,
    val authorHandle: String = "",
    val body: String,
    val scope: String,
    val type: String,
    val status: String,
    val reviewerId: String? = null,
    val reason: String? = null,
    val noteId: String? = null,
    val createdAt: Long = 0L,
    val decidedAt: Long? = null,
    val task: LessonTaskRef? = null
)

@Serializable
data class MemoryFixture(
    val facets: MemoryFacetCounts,
    val notes: List<NoteSummary> = emptyList(),
    val note: NoteView? = null,
    val conflict409: MemoryConflict409? = null,
    val writes: List<NoteWriteFeedItem> = emptyList(),
    val lessons: List<LessonView> = emptyList()
)
