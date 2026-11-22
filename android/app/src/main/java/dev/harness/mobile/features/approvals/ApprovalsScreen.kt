package dev.harness.mobile.features.approvals

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StudioNorthTheme
import kotlinx.coroutines.delay
import okhttp3.OkHttpClient

@Composable
fun ApprovalsScreen(
    session: SessionRepository,
    modifier: Modifier = Modifier,
    baseUrl: String = "http://127.0.0.1:4100",
    customClient: OkHttpClient? = null,
    focusedApprovalId: String? = null,
    viewModel: ApprovalsViewModel? = null,
    onNavigateToRun: ((String) -> Unit)? = null
) {
    val vm = viewModel ?: viewModel(key = baseUrl) {
        ApprovalsViewModel(session = session, baseUrl = baseUrl, customClient = customClient)
    }
    val uiState by vm.uiState.collectAsState()
    val colors = StudioNorthTheme.colors

    var currentTime by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(focusedApprovalId) {
        if (!focusedApprovalId.isNullOrBlank()) {
            vm.setFocusedApprovalId(focusedApprovalId)
        }
    }
    LaunchedEffect(Unit) {
        vm.loadApprovals()
        while (true) {
            delay(1000L)
            currentTime = System.currentTimeMillis()
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
            .padding(16.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Guard Approvals",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                if (uiState.isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.width(18.dp).height(18.dp),
                        strokeWidth = 2.dp,
                        color = colors.brand
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Inline Banners
            uiState.conflictBanner?.let { banner ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.danger.copy(alpha = 0.12f))
                        .border(1.dp, colors.danger, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(12.dp)
                        .clickable { vm.dismissBanners() }
                ) {
                    Text(text = banner, color = colors.danger, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                }
                Spacer(modifier = Modifier.height(10.dp))
            }

            uiState.adminRequiredBanner?.let { banner ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.accent.copy(alpha = 0.2f))
                        .border(1.dp, colors.accent, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(12.dp)
                        .clickable { vm.dismissBanners() }
                ) {
                    Text(text = banner, color = colors.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                }
                Spacer(modifier = Modifier.height(10.dp))
            }

            uiState.errorBanner?.let { banner ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.danger.copy(alpha = 0.1f))
                        .border(1.dp, colors.danger, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(12.dp)
                        .clickable { vm.dismissBanners() }
                ) {
                    Text(text = banner, color = colors.danger, fontSize = 13.sp)
                }
                Spacer(modifier = Modifier.height(10.dp))
            }

            if (!uiState.canManageApprovals) {
                RaisedCard(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = "Admin Access Required",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.ink
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "Guard approvals are restricted to instance administrators and organization admins. Your current role does not have approval management permissions.",
                        fontSize = 14.sp,
                        color = colors.inkMuted
                    )
                }
                return@Box
            }

            // Segmented Filter Control: Pending vs Resolved
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                    .background(colors.surfaceRaised)
                    .padding(4.dp)
            ) {
                val isPending = uiState.filter == ApprovalFilter.PENDING
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(if (isPending) colors.surface else colors.surfaceRaised)
                        .clickable { vm.setFilter(ApprovalFilter.PENDING) }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "Pending",
                            fontSize = 14.sp,
                            fontWeight = if (isPending) FontWeight.Bold else FontWeight.Medium,
                            color = colors.ink
                        )
                        if (uiState.pendingApprovals.isNotEmpty()) {
                            Spacer(modifier = Modifier.width(6.dp))
                            Box(
                                modifier = Modifier
                                    .clip(CircleShape)
                                    .background(colors.accent)
                                    .padding(horizontal = 7.dp, vertical = 2.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = "${uiState.pendingApprovals.size}",
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = colors.ink
                                )
                            }
                        }
                    }
                }

                val isResolved = uiState.filter == ApprovalFilter.RESOLVED
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(if (isResolved) colors.surface else colors.surfaceRaised)
                        .clickable { vm.setFilter(ApprovalFilter.RESOLVED) }
                        .padding(vertical = 8.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "Resolved",
                        fontSize = 14.sp,
                        fontWeight = if (isResolved) FontWeight.Bold else FontWeight.Medium,
                        color = colors.ink
                    )
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            val items = if (uiState.filter == ApprovalFilter.PENDING) {
                uiState.pendingApprovals
            } else {
                uiState.resolvedApprovals
            }

            if (items.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(top = 32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = if (uiState.filter == ApprovalFilter.PENDING) {
                            "No pending approvals requiring review."
                        } else {
                            "No resolved approvals recorded."
                        },
                        fontSize = 14.sp,
                        color = colors.inkMuted
                    )
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(items, key = { it.id }) { approval ->
                        val remaining = vm.remainingSeconds(approval.expiresAt, currentTime)
                        ApprovalCard(
                            approval = approval,
                            isDeciding = uiState.decidingId == approval.id,
                            remainingSeconds = remaining,
                            formatCountdown = { vm.formatCountdown(it) },
                            isDangerCountdown = { vm.isDangerCountdown(it) },
                            onApprove = { vm.decide(approval.id, "approve") },
                            onDeny = { vm.decide(approval.id, "deny") },
                            onSelectRun = { runId -> onNavigateToRun?.invoke(runId) },
                            isFocused = uiState.focusedApprovalId == approval.id
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                    }
                }
            }
        }
    }
}
