package dev.harness.mobile.features.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.harness.mobile.core.model.ChannelView
import dev.harness.mobile.core.model.MessageView
import dev.harness.mobile.core.model.WsMessage
import dev.harness.mobile.core.store.SessionRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ChatViewModel(
    val repository: ChatRepository,
    val session: SessionRepository? = null,
    val wsFlow: Flow<WsMessage>? = null
) : ViewModel() {

    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    init {
        val handle = session?.me?.value?.user?.name ?: session?.me?.value?.user?.email?.substringBefore('@')
        if (handle != null) _state.value = _state.value.copy(myHandle = handle)
        if (wsFlow != null) {
            viewModelScope.launch { wsFlow.collect { msg -> handleWsMessage(msg) } }
        }
    }

    fun load(orgSlug: String, initialChannelId: String? = null) {
        _state.value = _state.value.copy(isLoading = true, orgSlug = orgSlug, errorMessage = null)
        viewModelScope.launch {
            try {
                val channels = repository.getChannels(orgSlug)
                val orgMembers = repository.getOrgMembers(orgSlug)
                val targetChannelId = initialChannelId
                    ?: _state.value.selectedChannelId?.takeIf { id -> channels.any { it.id == id } }
                    ?: channels.firstOrNull { it.kind == "org" }?.id
                    ?: channels.firstOrNull()?.id

                _state.value = _state.value.copy(
                    channels = channels,
                    orgMembers = orgMembers,
                    selectedChannelId = targetChannelId,
                    isLoading = false
                )
                if (targetChannelId != null) loadChannelData(targetChannelId)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(
                    isLoading = false,
                    errorMessage = e.message ?: "Failed to load channels"
                )
            }
        }
    }

    fun selectChannel(channelId: String) {
        if (_state.value.selectedChannelId == channelId && _state.value.messages.isNotEmpty()) return
        _state.value = _state.value.copy(
            selectedChannelId = channelId,
            messages = emptyList(),
            members = emptyList(),
            hasMoreOlder = true,
            activeThreadRoot = null,
            threadMessages = emptyList()
        )
        loadChannelData(channelId)
    }

    private fun loadChannelData(channelId: String) {
        markChannelRead(channelId)
        viewModelScope.launch {
            try {
                val members = repository.getChannelMembers(channelId)
                val rawMessages = repository.getMessages(channelId, limit = 50)
                val sorted = rawMessages.sortedWith(compareBy<MessageView> { it.createdAt }.thenBy { it.id })
                _state.value = _state.value.copy(
                    members = members,
                    messages = sorted,
                    hasMoreOlder = rawMessages.size >= 50,
                    errorMessage = null
                )
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to load messages")
            }
        }
    }

    fun loadOlderMessages() {
        val channelId = _state.value.selectedChannelId ?: return
        if (_state.value.isLoadingOlder || !_state.value.hasMoreOlder) return
        val oldest = _state.value.messages.firstOrNull() ?: return

        _state.value = _state.value.copy(isLoadingOlder = true)
        viewModelScope.launch {
            try {
                val cursor = "${oldest.createdAt}:${oldest.id}"
                val older = repository.getMessages(channelId, limit = 50, before = cursor)
                _state.value = _state.value.copy(
                    messages = mergeMessages(_state.value.messages, older),
                    hasMoreOlder = older.size >= 50,
                    isLoadingOlder = false
                )
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(
                    isLoadingOlder = false,
                    errorMessage = e.message ?: "Failed to load older messages"
                )
            }
        }
    }

    fun sendMessage(body: String, threadRootId: String? = null) {
        val trimmed = body.trim()
        if (trimmed.isBlank()) return
        val channelId = _state.value.selectedChannelId ?: return

        viewModelScope.launch {
            try {
                val posted = repository.postMessage(channelId, trimmed, threadRootId)
                if (threadRootId == null) {
                    _state.value = _state.value.copy(messages = mergeMessages(_state.value.messages, listOf(posted)))
                } else {
                    val updatedMessages = _state.value.messages.map {
                        if (it.id == threadRootId) it.copy(replyCount = it.replyCount + 1) else it
                    }
                    _state.value = _state.value.copy(
                        threadMessages = mergeMessages(_state.value.threadMessages, listOf(posted)),
                        messages = updatedMessages
                    )
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to send message")
            }
        }
    }

    fun openThread(rootMessage: MessageView) {
        _state.value = _state.value.copy(
            activeThreadRoot = rootMessage,
            isThreadLoading = true,
            threadMessages = emptyList()
        )
        viewModelScope.launch {
            try {
                val replies = repository.getMessages(rootMessage.channelId, limit = 100, threadRootId = rootMessage.id)
                val sorted = replies.sortedWith(compareBy<MessageView> { it.createdAt }.thenBy { it.id })
                _state.value = _state.value.copy(threadMessages = sorted, isThreadLoading = false)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(
                    isThreadLoading = false,
                    errorMessage = e.message ?: "Failed to load thread"
                )
            }
        }
    }

    fun closeThread() {
        _state.value = _state.value.copy(activeThreadRoot = null, threadMessages = emptyList(), isThreadLoading = false)
    }

    fun createDm(memberId: String, onCreated: ((ChannelView) -> Unit)? = null) {
        val slug = _state.value.orgSlug ?: return
        viewModelScope.launch {
            try {
                val dm = repository.createDm(slug, memberId)
                val exists = _state.value.channels.any { it.id == dm.id }
                val updated = if (exists) _state.value.channels else _state.value.channels + dm
                _state.value = _state.value.copy(channels = updated)
                selectChannel(dm.id)
                onCreated?.invoke(dm)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to create DM")
            }
        }
    }

    fun createGroup(name: String, memberIds: List<String>, onCreated: ((ChannelView) -> Unit)? = null) {
        val slug = _state.value.orgSlug ?: return
        viewModelScope.launch {
            try {
                val group = repository.createGroup(slug, name, memberIds)
                val exists = _state.value.channels.any { it.id == group.id }
                val updated = if (exists) _state.value.channels else _state.value.channels + group
                _state.value = _state.value.copy(channels = updated)
                selectChannel(group.id)
                onCreated?.invoke(group)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to create group")
            }
        }
    }

    fun markChannelRead(channelId: String) {
        val updated = _state.value.channels.map {
            if (it.id == channelId) it.copy(unread = 0) else it
        }
        _state.value = _state.value.copy(channels = updated)
        viewModelScope.launch {
            try {
                repository.markRead(channelId)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to mark channel read")
            }
        }
    }

    fun handleWsMessage(msg: WsMessage) {
        if (msg !is WsMessage.Chat) return
        val currentChannel = _state.value.selectedChannelId
        if (msg.channelId == currentChannel) {
            viewModelScope.launch {
                try {
                    val raw = repository.getMessages(msg.channelId, limit = 50)
                    _state.value = _state.value.copy(messages = mergeMessages(_state.value.messages, raw))
                    repository.markRead(msg.channelId)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to refresh messages")
                }
            }
            if (msg.threadRootId != null && _state.value.activeThreadRoot?.id == msg.threadRootId) {
                viewModelScope.launch {
                    try {
                        val replies = repository.getMessages(msg.channelId, limit = 100, threadRootId = msg.threadRootId)
                        _state.value = _state.value.copy(threadMessages = mergeMessages(_state.value.threadMessages, replies))
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to refresh thread")
                    }
                }
            }
        } else {
            val slug = _state.value.orgSlug ?: return
            viewModelScope.launch {
                try {
                    val updatedChannels = repository.getChannels(slug)
                    _state.value = _state.value.copy(channels = updatedChannels)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    _state.value = _state.value.copy(errorMessage = e.message ?: "Failed to refresh channels")
                }
            }
        }
    }

    fun handleDeepLink(uri: String): Boolean {
        val (slug, channelId) = parseChatDeepLink(uri) ?: return false
        if (_state.value.orgSlug != slug) {
            load(slug, initialChannelId = channelId)
        } else {
            selectChannel(channelId)
        }
        return true
    }

    fun onInputTextChanged(text: String, caretPosition: Int) {
        val query = MentionUtils.extractMentionQuery(text, caretPosition)
        val availableMembers = _state.value.members.ifEmpty { _state.value.orgMembers }
        val suggestions = if (query != null) {
            MentionUtils.filterMembers(availableMembers, query)
        } else {
            emptyList()
        }
        _state.value = _state.value.copy(mentionQuery = query, mentionSuggestions = suggestions)
    }

    fun dismissMentionSuggestions() {
        _state.value = _state.value.copy(mentionQuery = null, mentionSuggestions = emptyList())
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }
}
