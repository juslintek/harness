package dev.harness.mobile.features.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.harness.mobile.core.model.DashboardFixture
import dev.harness.mobile.core.model.WsMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class DashboardState(
    val selectedRange: DashboardTimeRange = DashboardTimeRange.HOURS_24,
    val dashboard: DashboardFixture? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    val currentOrgSlug: String = ""
) {
    val totalSpendUsd: Double
        get() = dashboard?.members?.sumOf { it.costUsd } ?: 0.0

    val totalRuns: Int
        get() = dashboard?.members?.sumOf { it.runs } ?: 0

    val totalCompleted: Int
        get() = dashboard?.members?.sumOf { it.completed } ?: 0

    val totalInputTokens: Long
        get() = dashboard?.members?.sumOf { it.inputTokens } ?: 0L

    val totalOutputTokens: Long
        get() = dashboard?.members?.sumOf { it.outputTokens } ?: 0L
}

class DashboardViewModel(
    private val repository: WorkspaceRepository,
    private val wsFlow: Flow<WsMessage>? = null
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardState())
    val state: StateFlow<DashboardState> = _state.asStateFlow()

    init {
        wsFlow?.let { flow ->
            viewModelScope.launch {
                flow.collect { message ->
                    if (message is WsMessage.Dashboard) {
                        val org = _state.value.currentOrgSlug
                        if (org.isNotBlank()) {
                            load(org, _state.value.selectedRange)
                        }
                    }
                }
            }
        }
    }

    fun load(orgSlug: String, range: DashboardTimeRange = _state.value.selectedRange) {
        val sinceMs = range.computeSinceMs()
        _state.value = _state.value.copy(
            isLoading = true,
            error = null,
            selectedRange = range,
            currentOrgSlug = orgSlug
        )
        viewModelScope.launch {
            try {
                val data = repository.getDashboard(orgSlug, sinceMs)
                _state.value = _state.value.copy(
                    dashboard = data,
                    isLoading = false,
                    error = null
                )
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _state.value = _state.value.copy(
                    isLoading = false,
                    error = e.message ?: "Failed to load dashboard"
                )
            }
        }
    }

    fun selectRange(range: DashboardTimeRange) {
        val org = _state.value.currentOrgSlug
        if (org.isNotBlank()) {
            load(org, range)
        } else {
            _state.value = _state.value.copy(selectedRange = range)
        }
    }

    fun refresh() {
        val org = _state.value.currentOrgSlug
        if (org.isNotBlank()) {
            load(org, _state.value.selectedRange)
        }
    }
}
