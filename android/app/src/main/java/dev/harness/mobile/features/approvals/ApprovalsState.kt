package dev.harness.mobile.features.approvals

import dev.harness.mobile.core.model.ApprovalView

enum class ApprovalFilter {
    PENDING,
    RESOLVED
}

data class ApprovalsUiState(
    val canManageApprovals: Boolean = true,
    val isLoading: Boolean = false,
    val filter: ApprovalFilter = ApprovalFilter.PENDING,
    val pendingApprovals: List<ApprovalView> = emptyList(),
    val resolvedApprovals: List<ApprovalView> = emptyList(),
    val focusedApprovalId: String? = null,
    val decidingId: String? = null,
    val errorBanner: String? = null,
    val conflictBanner: String? = null,
    val adminRequiredBanner: String? = null
)
