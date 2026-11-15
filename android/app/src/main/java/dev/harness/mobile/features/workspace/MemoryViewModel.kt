package dev.harness.mobile.features.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.harness.mobile.core.model.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class MemoryViewModel(
    private val repository: WorkspaceRepository,
    private val wsFlow: Flow<WsMessage>? = null
) : ViewModel() {

    private val _state = MutableStateFlow(MemoryState())
    val state: StateFlow<MemoryState> = _state.asStateFlow()

    init {
        wsFlow?.let { flow ->
            viewModelScope.launch {
                flow.collect { message ->
                    if (message is WsMessage.Memory) {
                        val org = _state.value.orgSlug
                        if (org.isNotBlank() && (message.orgId == org || message.orgId.isBlank())) {
                            load(org)
                        }
                    }
                }
            }
        }
    }

    fun load(orgSlug: String) {
        _state.value = _state.value.copy(orgSlug = orgSlug, error = null)
        loadFacets(orgSlug)
        loadNotes(orgSlug)
        loadWrites(orgSlug)
        loadLessons(orgSlug)
    }

    fun search(query: String) { _state.value = _state.value.copy(searchQuery = query); loadNotes(_state.value.orgSlug) }
    fun setScopeFilter(scope: String?) { _state.value = _state.value.copy(selectedScopeFilter = scope); loadNotes(_state.value.orgSlug) }
    fun setTypeFilter(type: String?) { _state.value = _state.value.copy(selectedTypeFilter = type); loadNotes(_state.value.orgSlug) }
    fun setTagFilter(tag: String?) { _state.value = _state.value.copy(selectedTagFilter = tag); loadNotes(_state.value.orgSlug) }
    fun closeNoteDetail() { _state.value = _state.value.copy(selectedNote = null, backlinks = emptyList(), wikilinkResult = null) }
    fun closeEditor() { _state.value = _state.value.copy(isEditorOpen = false, conflictState = null) }
    fun clearBanner() { _state.value = _state.value.copy(bannerNotice = null, error = null) }
    fun filterLessons(status: String?) { _state.value = _state.value.copy(lessonStatusFilter = status); loadLessons(_state.value.orgSlug) }
    fun updateEditorDraft(body: String, title: String? = null) { _state.value = _state.value.copy(editorDraftBody = body, editorTitle = title ?: _state.value.editorTitle) }

    fun loadFacets(orgSlug: String = _state.value.orgSlug) {
        viewModelScope.launch {
            try { _state.value = _state.value.copy(facets = repository.getFacets(orgSlug)) }
            catch (e: Exception) { if (e is CancellationException) throw e; _state.value = _state.value.copy(error = e.message) }
        }
    }

    fun loadNotes(orgSlug: String = _state.value.orgSlug) {
        _state.value = _state.value.copy(isLoadingNotes = true)
        viewModelScope.launch {
            try {
                val notes = repository.getNotes(
                    orgSlug = orgSlug,
                    query = _state.value.searchQuery.ifBlank { null },
                    scope = _state.value.selectedScopeFilter,
                    type = _state.value.selectedTypeFilter,
                    tag = _state.value.selectedTagFilter
                )
                _state.value = _state.value.copy(notes = notes, isLoadingNotes = false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(isLoadingNotes = false, error = e.message)
            }
        }
    }

    fun openNoteDetail(noteId: String) {
        viewModelScope.launch {
            try {
                val note = repository.getNote(_state.value.orgSlug, noteId)
                val backlinks = repository.getBacklinks(_state.value.orgSlug, noteId)
                _state.value = _state.value.copy(selectedNote = note, backlinks = backlinks, wikilinkResult = null)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun resolveWikilink(target: String) {
        val note = _state.value.selectedNote ?: return
        viewModelScope.launch {
            try {
                val result = repository.resolveWikilink(_state.value.orgSlug, note.id, target)
                _state.value = _state.value.copy(wikilinkResult = result)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        }
    }

    fun openNewNoteEditor() {
        _state.value = _state.value.copy(
            isEditorOpen = true, editorNoteId = null, editorRelPath = "",
            editorTitle = "", editorDraftBody = "", editorBaseHash = "",
            editorScope = "org", editorType = "decision", editorTags = emptyList(),
            conflictState = null
        )
    }

    fun openEditNoteEditor(note: NoteView) {
        _state.value = _state.value.copy(
            isEditorOpen = true, editorNoteId = note.id, editorRelPath = note.path,
            editorTitle = note.title, editorDraftBody = note.body, editorBaseHash = note.hash,
            editorScope = note.scope, editorType = note.type, editorTags = note.tags,
            conflictState = null
        )
    }

    fun saveNoteDraft() {
        val noteId = _state.value.editorNoteId
        val orgSlug = _state.value.orgSlug
        val bodyText = _state.value.editorDraftBody
        _state.value = _state.value.copy(isSavingNote = true, error = null)

        viewModelScope.launch {
            if (noteId == null) {
                try {
                    val created = repository.createNote(
                        orgSlug,
                        CreateNoteRequest(
                            scope = _state.value.editorScope,
                            rel = _state.value.editorRelPath.ifBlank { "notes/${System.currentTimeMillis()}.md" },
                            body = bodyText, type = _state.value.editorType, tags = _state.value.editorTags
                        )
                    )
                    _state.value = _state.value.copy(isSavingNote = false, isEditorOpen = false, selectedNote = created)
                    loadNotes(orgSlug)
                    loadWrites(orgSlug)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    _state.value = _state.value.copy(isSavingNote = false, error = e.message)
                }
            } else {
                val req = UpdateNoteRequest(
                    baseHash = _state.value.editorBaseHash, body = bodyText,
                    type = _state.value.editorType, tags = _state.value.editorTags
                )
                when (val result = repository.saveNote(orgSlug, noteId, req)) {
                    is SaveNoteResult.Success -> {
                        _state.value = _state.value.copy(
                            isSavingNote = false, isEditorOpen = false,
                            selectedNote = result.note, conflictState = null
                        )
                        loadNotes(orgSlug)
                        loadWrites(orgSlug)
                    }
                    is SaveNoteResult.Conflict -> {
                        val remoteNote = try {
                            repository.getNote(orgSlug, noteId)
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            null
                        }
                        _state.value = _state.value.copy(
                            isSavingNote = false,
                            conflictState = ConflictState(
                                remoteHash = result.currentHash,
                                remoteBody = remoteNote?.body.orEmpty(),
                                localDraftBody = bodyText,
                                noteId = noteId
                            )
                        )
                    }
                    is SaveNoteResult.Failure -> {
                        _state.value = _state.value.copy(isSavingNote = false, error = result.error)
                    }
                }
            }
        }
    }

    fun resolveConflictOverwrite() {
        val conflict = _state.value.conflictState ?: return
        _state.value = _state.value.copy(editorBaseHash = conflict.remoteHash, editorDraftBody = conflict.localDraftBody, conflictState = null)
        saveNoteDraft()
    }

    fun resolveConflictReloadRemote() {
        val conflict = _state.value.conflictState ?: return
        _state.value = _state.value.copy(editorDraftBody = conflict.remoteBody, editorBaseHash = conflict.remoteHash, conflictState = null)
    }

    fun deleteNote(noteId: String, baseHash: String) {
        viewModelScope.launch {
            try {
                if (repository.deleteNote(_state.value.orgSlug, noteId, baseHash)) {
                    _state.value = _state.value.copy(selectedNote = null)
                    loadNotes(_state.value.orgSlug)
                } else { _state.value = _state.value.copy(error = "Failed to delete note") }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun loadWrites(orgSlug: String = _state.value.orgSlug) {
        _state.value = _state.value.copy(isLoadingWrites = true)
        viewModelScope.launch {
            try {
                val writes = repository.getWrites(orgSlug)
                _state.value = _state.value.copy(writes = writes, isLoadingWrites = false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(isLoadingWrites = false, error = e.message)
            }
        }
    }

    fun revertWrite(writeId: String) {
        viewModelScope.launch {
            try {
                if (repository.revertWrite(_state.value.orgSlug, writeId)) {
                    _state.value = _state.value.copy(bannerNotice = "Write reverted successfully")
                    loadWrites(_state.value.orgSlug)
                    loadNotes(_state.value.orgSlug)
                } else { _state.value = _state.value.copy(error = "Failed to revert write") }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }

    fun loadLessons(orgSlug: String = _state.value.orgSlug) {
        _state.value = _state.value.copy(isLoadingLessons = true)
        viewModelScope.launch {
            try {
                val lessons = repository.getLessons(orgSlug, _state.value.lessonStatusFilter)
                _state.value = _state.value.copy(lessons = lessons, isLoadingLessons = false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(isLoadingLessons = false, error = e.message)
            }
        }
    }

    fun decideLesson(lessonId: String, decision: String, reason: String) {
        viewModelScope.launch {
            try {
                repository.decideLesson(_state.value.orgSlug, lessonId, decision, reason)
                loadLessons(_state.value.orgSlug)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(error = e.message)
            }
        }
    }
}
