package dev.harness.mobile.features.workspace

import dev.harness.mobile.core.model.*

class FakeWorkspaceRepository(
    initialDashboard: DashboardFixture? = null,
    initialFacets: MemoryFacetCounts = MemoryFacetCounts(),
    initialNotes: List<NoteSummary> = emptyList(),
    initialNoteViews: Map<String, NoteView> = emptyMap(),
    initialWrites: List<NoteWriteFeedItem> = emptyList(),
    initialLessons: List<LessonView> = emptyList(),
    initialPrefs: List<PrefView> = emptyList(),
    initialTargets: List<TargetView> = emptyList(),
    initialDevices: List<DeviceView> = emptyList(),
    var saveNoteOverride: ((String, String, UpdateNoteRequest) -> SaveNoteResult)? = null
) : WorkspaceRepository {

    var dashboard: DashboardFixture = initialDashboard ?: DashboardFixture()
    var facets: MemoryFacetCounts = initialFacets
    val notes = initialNotes.toMutableList()
    val noteViews = initialNoteViews.toMutableMap()
    val writes = initialWrites.toMutableList()
    val lessons = initialLessons.toMutableList()
    val prefs = initialPrefs.toMutableList()
    val targets = initialTargets.toMutableList()
    val devices = initialDevices.toMutableList()

    var lastSinceMsQueried: Long? = null

    override suspend fun getDashboard(orgSlug: String, sinceMs: Long): DashboardFixture {
        lastSinceMsQueried = sinceMs
        return dashboard
    }

    override suspend fun getFacets(orgSlug: String): MemoryFacetCounts = facets

    override suspend fun getNotes(
        orgSlug: String,
        query: String?,
        scope: String?,
        type: String?,
        tag: String?
    ): List<NoteSummary> {
        var list = notes.toList()
        if (!query.isNullOrBlank()) {
            list = list.filter { it.title.contains(query, ignoreCase = true) || it.path.contains(query, ignoreCase = true) }
        }
        if (!scope.isNullOrBlank()) {
            list = list.filter { it.scope == scope }
        }
        if (!type.isNullOrBlank()) {
            list = list.filter { it.type == type }
        }
        if (!tag.isNullOrBlank()) {
            list = list.filter { it.tags.contains(tag) }
        }
        return list
    }

    override suspend fun getNote(orgSlug: String, noteId: String): NoteView {
        return noteViews[noteId] ?: error("Note not found: $noteId")
    }

    override suspend fun getBacklinks(orgSlug: String, noteId: String): List<NoteSummary> {
        return notes.filter { it.id != noteId }
    }

    override suspend fun resolveWikilink(orgSlug: String, noteId: String, target: String): NoteSummary? {
        return notes.find { it.title.equals(target, ignoreCase = true) || it.path.contains(target) }
    }

    override suspend fun createNote(orgSlug: String, request: CreateNoteRequest): NoteView {
        val id = "not_${System.currentTimeMillis()}"
        val created = NoteView(
            id = id,
            path = request.rel,
            scope = request.scope,
            type = request.type ?: "decision",
            title = request.rel.substringAfterLast('/'),
            tags = request.tags ?: emptyList(),
            body = request.body,
            hash = "fresh_hash_${System.currentTimeMillis()}",
            canWrite = true
        )
        noteViews[id] = created
        notes.add(
            NoteSummary(
                id = id,
                path = request.rel,
                scope = request.scope,
                type = request.type ?: "decision",
                title = created.title,
                tags = created.tags,
                hash = created.hash
            )
        )
        return created
    }

    override suspend fun saveNote(orgSlug: String, noteId: String, request: UpdateNoteRequest): SaveNoteResult {
        saveNoteOverride?.let { override ->
            return override.invoke(orgSlug, noteId, request)
        }
        val current = noteViews[noteId] ?: return SaveNoteResult.Failure("Note not found")
        if (request.baseHash.isNotBlank() && current.hash != request.baseHash) {
            return SaveNoteResult.Conflict(current.hash)
        }
        val updated = current.copy(
            body = request.body,
            hash = "updated_hash_${System.currentTimeMillis()}",
            type = request.type ?: current.type,
            tags = request.tags ?: current.tags
        )
        noteViews[noteId] = updated
        val idx = notes.indexOfFirst { it.id == noteId }
        if (idx != -1) {
            notes[idx] = notes[idx].copy(
                hash = updated.hash,
                type = updated.type,
                tags = updated.tags
            )
        }
        return SaveNoteResult.Success(updated)
    }

    override suspend fun deleteNote(orgSlug: String, noteId: String, baseHash: String): Boolean {
        noteViews.remove(noteId)
        notes.removeAll { it.id == noteId }
        return true
    }

    override suspend fun getWrites(orgSlug: String, limit: Int, agentsOnly: Boolean): List<NoteWriteFeedItem> =
        writes.take(limit)

    override suspend fun revertWrite(orgSlug: String, writeId: String): Boolean {
        val write = writes.find { it.id == writeId } ?: return false
        if (write.before != null && write.beforeHash != null) {
            val note = noteViews[write.noteId]
            if (note != null) {
                noteViews[write.noteId] = note.copy(body = write.before, hash = write.beforeHash)
            }
        }
        writes.removeAll { it.id == writeId }
        return true
    }

    override suspend fun getLessons(orgSlug: String, status: String?): List<LessonView> {
        return if (status.isNullOrBlank()) lessons else lessons.filter { it.status == status }
    }

    override suspend fun decideLesson(
        orgSlug: String,
        lessonId: String,
        decision: String,
        reason: String
    ): LessonView {
        val idx = lessons.indexOfFirst { it.id == lessonId }
        val curr = if (idx != -1) lessons[idx] else error("Lesson not found: $lessonId")
        val updated = curr.copy(
            status = if (decision == "accept") "accepted" else "rejected",
            reason = reason,
            decidedAt = System.currentTimeMillis()
        )
        lessons[idx] = updated
        return updated
    }

    override suspend fun getNotifyPrefs(orgSlug: String): List<PrefView> = prefs

    override suspend fun updateNotifyPref(orgSlug: String, pref: PrefView): List<PrefView> {
        val idx = prefs.indexOfFirst { it.channel == pref.channel && it.kind == pref.kind }
        if (idx != -1) {
            prefs[idx] = pref
        } else {
            prefs.add(pref)
        }
        return prefs.toList()
    }

    override suspend fun getTargets(orgSlug: String): List<TargetView> = targets

    override suspend fun registerMobilePush(orgSlug: String, body: MobilePushSubscribeBody): String {
        val id = "tgt_${System.currentTimeMillis()}"
        targets.add(TargetView(id, "push", "Push Target (${body.pushToken.take(8)})"))
        return id
    }

    override suspend fun getDevices(): List<DeviceView> = devices

    override suspend fun revokeDevice(deviceId: String): Boolean {
        return devices.removeAll { it.id == deviceId }
    }
}
