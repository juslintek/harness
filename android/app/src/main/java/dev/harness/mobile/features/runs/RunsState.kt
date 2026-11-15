package dev.harness.mobile.features.runs

import dev.harness.mobile.core.model.ApprovalView
import dev.harness.mobile.core.model.RunDetail
import dev.harness.mobile.core.model.RunView

enum class RunsFilter { ACTIVE, ALL }

data class RunsUiState(
    val isInstanceAdmin: Boolean = true,
    val isLoading: Boolean = false,
    val filter: RunsFilter = RunsFilter.ACTIVE,
    val runs: List<RunView> = emptyList(),
    val selectedRunId: String? = null,
    val selectedRunDetail: RunDetail? = null,
    val inlineApprovals: List<ApprovalView> = emptyList(),
    val isAutoScroll: Boolean = true,
    val wakeups: List<WakeupView> = emptyList(),
    val canWakeMembers: Boolean = false,
    val startRunHaltedError: String? = null,
    val errorBanner: String? = null,
    val isStartingRun: Boolean = false,
    val isKillingRun: Boolean = false
)
