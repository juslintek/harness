package dev.harness.mobile.features.workspace

import dev.harness.mobile.core.model.*
import kotlinx.serialization.Serializable

val NOTIFY_CHANNELS = listOf("push", "email", "slack", "telegram", "webhook")
val NOTIFY_KINDS = listOf(
    "approval_requested",
    "approval_resolved",
    "mention",
    "dm",
    "run_blocked"
)

val CHANNEL_LABELS = mapOf(
    "push" to "Push",
    "email" to "Email",
    "slack" to "Slack",
    "telegram" to "Telegram",
    "webhook" to "Webhook"
)

val KIND_LABELS = mapOf(
    "approval_requested" to "Approval needed",
    "approval_resolved" to "Approval decided",
    "mention" to "Mentioned in chat",
    "dm" to "Direct message",
    "run_blocked" to "Run blocked"
)

@Serializable
data class PrefView(
    val channel: String,
    val kind: String,
    val enabled: Boolean
)

@Serializable
data class TargetView(
    val id: String,
    val channel: String,
    val label: String
)

@Serializable
data class TargetIdResponse(val id: String)

@Serializable
data class SimpleOkResponse(val ok: Boolean = true)

@Serializable
data class CreateNoteRequest(
    val scope: String,
    val rel: String,
    val body: String,
    val type: String? = null,
    val tags: List<String>? = null,
    val projectId: String? = null
)

@Serializable
data class UpdateNoteRequest(
    val baseHash: String,
    val body: String,
    val type: String? = null,
    val tags: List<String>? = null
)

@Serializable
data class DecideLessonRequest(
    val decision: String,
    val reason: String,
    val body: String? = null
)

sealed interface SaveNoteResult {
    data class Success(val note: NoteView) : SaveNoteResult
    data class Conflict(val currentHash: String, val message: String = "Conflict") : SaveNoteResult
    data class Failure(val error: String) : SaveNoteResult
}

data class ConflictState(
    val remoteHash: String,
    val remoteBody: String,
    val localDraftBody: String,
    val noteId: String
)

data class MemoryState(
    val orgSlug: String = "",
    val facets: MemoryFacetCounts = MemoryFacetCounts(),
    val notes: List<NoteSummary> = emptyList(),
    val searchQuery: String = "",
    val selectedScopeFilter: String? = null,
    val selectedTypeFilter: String? = null,
    val selectedTagFilter: String? = null,
    val isLoadingNotes: Boolean = false,
    val selectedNote: NoteView? = null,
    val backlinks: List<NoteSummary> = emptyList(),
    val wikilinkResult: NoteSummary? = null,
    val isEditorOpen: Boolean = false,
    val editorNoteId: String? = null,
    val editorRelPath: String = "",
    val editorTitle: String = "",
    val editorDraftBody: String = "",
    val editorBaseHash: String = "",
    val editorScope: String = "org",
    val editorType: String = "decision",
    val editorTags: List<String> = emptyList(),
    val isSavingNote: Boolean = false,
    val conflictState: ConflictState? = null,
    val writes: List<NoteWriteFeedItem> = emptyList(),
    val isLoadingWrites: Boolean = false,
    val lessons: List<LessonView> = emptyList(),
    val lessonStatusFilter: String? = null,
    val isLoadingLessons: Boolean = false,
    val bannerNotice: String? = null,
    val error: String? = null
)

enum class DashboardTimeRange(val label: String, val durationMs: Long) {
    HOURS_24("24h", 24 * 3600 * 1000L),
    DAYS_7("7d", 7 * 24 * 3600 * 1000L),
    DAYS_30("30d", 30 * 24 * 3600 * 1000L);

    fun computeSinceMs(now: Long = System.currentTimeMillis()): Long = now - durationMs
}
