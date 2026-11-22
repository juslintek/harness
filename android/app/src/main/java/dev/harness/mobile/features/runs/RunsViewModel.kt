package dev.harness.mobile.features.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.harness.mobile.core.model.RunDetail
import dev.harness.mobile.core.model.WsMessage
import dev.harness.mobile.core.network.HarnessWsClient
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.core.store.SessionState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

class RunsViewModel(
    val session: SessionRepository,
    val baseUrl: String = "http://127.0.0.1:4100",
    private val customClient: OkHttpClient? = null,
    private val wsFactory: ((url: String) -> HarnessWsClient)? = null,
    coroutineScope: CoroutineScope? = null,
    private val ioDispatcher: CoroutineDispatcher = coroutineScope?.coroutineContext?.get(CoroutineDispatcher) ?: Dispatchers.IO
) : ViewModel() {

    private val scope = coroutineScope ?: viewModelScope
    private val httpClient = customClient ?: OkHttpClient()
    private val repository = RunsRepository(baseUrl, httpClient, session, ioDispatcher)

    private val _uiState = MutableStateFlow(RunsUiState())
    val uiState: StateFlow<RunsUiState> = _uiState.asStateFlow()

    private val wsScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var runsWsClient: HarnessWsClient? = null
    private var runTranscriptWsClient: HarnessWsClient? = null
    private var lastRowid: Long = 0L

    init {
        val isAdmin = session.isInstanceAdmin.value
        val orgRole = session.activeOrg.value?.role
        _uiState.value = _uiState.value.copy(
            isInstanceAdmin = isAdmin,
            canWakeMembers = orgRole == "owner" || orgRole == "admin"
        )
    }

    fun setFilter(filter: RunsFilter) {
        _uiState.value = _uiState.value.copy(filter = filter)
    }

    fun toggleAutoScroll() {
        _uiState.value = _uiState.value.copy(isAutoScroll = !_uiState.value.isAutoScroll)
    }

    fun dismissBanners() {
        _uiState.value = _uiState.value.copy(errorBanner = null, startRunHaltedError = null)
    }

    fun loadData() {
        val isAdmin = session.isInstanceAdmin.value
        val orgRole = session.activeOrg.value?.role
        _uiState.value = _uiState.value.copy(
            isInstanceAdmin = isAdmin,
            canWakeMembers = orgRole == "owner" || orgRole == "admin",
            isLoading = true
        )

        if (!isAdmin) {
            loadWakeups()
        } else {
            loadRuns()
            setupRunsWebSocket()
        }
    }

    private fun loadWakeups() {
        val orgSlug = session.activeOrg.value?.slug ?: return
        scope.launch {
            try {
                val result = repository.fetchWakeups(orgSlug)
                _uiState.value = _uiState.value.copy(isLoading = false, wakeups = result)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(isLoading = false, errorBanner = e.message)
            }
        }
    }

    fun wakeMember(memberId: String, taskId: String? = null) {
        scope.launch {
            try {
                val code = repository.wakeMember(memberId, taskId)
                if (code == 202) {
                    loadWakeups()
                } else {
                    _uiState.value = _uiState.value.copy(errorBanner = "Wakeup returned status $code")
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorBanner = e.message)
            }
        }
    }

    private fun loadRuns() {
        scope.launch {
            try {
                val result = repository.fetchRuns()
                _uiState.value = _uiState.value.copy(isLoading = false, runs = result)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(isLoading = false, errorBanner = e.message)
            }
        }
    }

    fun startRun(agentId: String, repo: String, prompt: String, model: String?) {
        _uiState.value = _uiState.value.copy(isStartingRun = true, startRunHaltedError = null)
        scope.launch {
            try {
                val (code, body) = repository.startRun(agentId, repo, prompt, model)
                if (code == 409) {
                    _uiState.value = _uiState.value.copy(
                        isStartingRun = false,
                        startRunHaltedError = "Instance is halted: cannot start new agent runs."
                    )
                } else if (code == 201 || code == 200) {
                    _uiState.value = _uiState.value.copy(isStartingRun = false)
                    loadRuns()
                } else {
                    _uiState.value = _uiState.value.copy(
                        isStartingRun = false,
                        errorBanner = "Start run failed: HTTP $code ($body)"
                    )
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    isStartingRun = false,
                    errorBanner = e.message ?: "Network error starting run"
                )
            }
        }
    }

    fun killRun(id: String) {
        _uiState.value = _uiState.value.copy(isKillingRun = true)
        scope.launch {
            try {
                repository.killRun(id)
                loadRuns()
                if (_uiState.value.selectedRunId == id) {
                    fetchIncrementalTranscript(id)
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorBanner = e.message)
            } finally {
                _uiState.value = _uiState.value.copy(isKillingRun = false)
            }
        }
    }

    fun selectRun(runId: String?) {
        _uiState.value = _uiState.value.copy(selectedRunId = runId, selectedRunDetail = null, inlineApprovals = emptyList())
        runTranscriptWsClient?.disconnect()
        runTranscriptWsClient = null
        lastRowid = 0L

        if (runId != null) {
            loadInitialTranscript(runId)
            setupRunTranscriptWebSocket(runId)
            loadInlineApprovals(runId)
        }
    }

    private fun loadInitialTranscript(runId: String) {
        scope.launch {
            try {
                val detail = repository.fetchRunDetail(runId, after = 0L)
                lastRowid = detail.events.maxOfOrNull { it.rowid } ?: 0L
                _uiState.value = _uiState.value.copy(selectedRunDetail = detail)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorBanner = e.message)
            }
        }
    }

    fun onRunWsNudge(runId: String, msg: WsMessage) {
        if (msg is WsMessage.Event || msg is WsMessage.Run) {
            fetchIncrementalTranscript(runId)
            loadInlineApprovals(runId)
        }
    }

    private fun fetchIncrementalTranscript(runId: String) {
        scope.launch {
            try {
                val incremental = repository.fetchRunDetail(runId, after = lastRowid)
                val current = _uiState.value.selectedRunDetail
                val mergedEvents = if (current != null) {
                    (current.events + incremental.events).distinctBy { it.rowid }
                } else incremental.events
                lastRowid = mergedEvents.maxOfOrNull { it.rowid } ?: lastRowid
                _uiState.value = _uiState.value.copy(
                    selectedRunDetail = RunDetail(run = incremental.run, events = mergedEvents)
                )
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _uiState.value = _uiState.value.copy(errorBanner = e.message)
            }
        }
    }

    private fun loadInlineApprovals(runId: String) {
        scope.launch {
            try {
                val allPending = repository.fetchPendingApprovals()
                _uiState.value = _uiState.value.copy(inlineApprovals = allPending.filter { it.runId == runId })
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _uiState.value = _uiState.value.copy(errorBanner = e.message)
            }
        }
    }

    fun decideInlineApproval(approvalId: String, decision: String) {
        scope.launch {
            try {
                repository.decideApproval(approvalId, decision)
                _uiState.value.selectedRunId?.let {
                    loadInlineApprovals(it)
                    fetchIncrementalTranscript(it)
                }
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(errorBanner = e.message)
            }
        }
    }

    private fun setupRunsWebSocket() {
        if (runsWsClient != null) return
        val wsBase = baseUrl.replace("http://", "ws://").replace("https://", "wss://")
        val tokenProvider = { (session.sessionState.value as? SessionState.Authenticated)?.token }
        val originProvider = { baseUrl }

        val url = "$wsBase/ws?topic=runs"
        runsWsClient = wsFactory?.invoke(url) ?: HarnessWsClient(
            wsUrl = url,
            tokenProvider = tokenProvider,
            originProvider = originProvider,
            scope = wsScope
        )
        runsWsClient?.connect()
        wsScope.launch {
            runsWsClient?.messages?.collect { msg ->
                if (msg is WsMessage.Run) {
                    val current = _uiState.value.runs
                    val updated = if (current.any { it.id == msg.run.id }) {
                        current.map { if (it.id == msg.run.id) msg.run else it }
                    } else {
                        listOf(msg.run) + current
                    }
                    _uiState.value = _uiState.value.copy(runs = updated)
                }
            }
        }
    }

    private fun setupRunTranscriptWebSocket(runId: String) {
        val wsBase = baseUrl.replace("http://", "ws://").replace("https://", "wss://")
        val tokenProvider = { (session.sessionState.value as? SessionState.Authenticated)?.token }
        val originProvider = { baseUrl }

        val url = "$wsBase/ws?topic=run:$runId"
        runTranscriptWsClient = wsFactory?.invoke(url) ?: HarnessWsClient(
            wsUrl = url,
            tokenProvider = tokenProvider,
            originProvider = originProvider,
            scope = wsScope
        )
        runTranscriptWsClient?.connect()
        wsScope.launch {
            runTranscriptWsClient?.messages?.collect { msg ->
                onRunWsNudge(runId, msg)
            }
        }
    }

    public override fun onCleared() {
        super.onCleared()
        wsScope.cancel()
        runsWsClient?.disconnect()
        runTranscriptWsClient?.disconnect()
    }
}
