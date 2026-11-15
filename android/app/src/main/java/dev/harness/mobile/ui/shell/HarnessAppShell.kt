package dev.harness.mobile.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.crypto.DeviceKeySigner
import dev.harness.mobile.core.network.HarnessApiClient
import dev.harness.mobile.core.push.DeepLinkTarget
import dev.harness.mobile.core.store.InstanceRepository
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.core.store.SessionState
import dev.harness.mobile.features.approvals.ApprovalsScreen
import dev.harness.mobile.features.auth.HaltConfirmDialog
import dev.harness.mobile.features.auth.PairEnrollScreen
import dev.harness.mobile.features.board.BoardScreen
import dev.harness.mobile.features.chat.ChatScreen
import dev.harness.mobile.features.runs.RunsScreen
import dev.harness.mobile.features.workspace.WorkspaceScreen
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.StudioNorthTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class ShellTab(val title: String, val icon: ImageVector) {
    APPROVALS("Approvals", Icons.Default.CheckCircle),
    BOARD("Board", Icons.Default.Dashboard),
    RUNS("Runs", Icons.Default.PlayArrow),
    CHAT("Chat", Icons.Default.Forum),
    WORKSPACE("Workspace", Icons.Default.Folder)
}

@Composable
fun HarnessAppShell(
    instanceRepo: InstanceRepository,
    sessionRepo: SessionRepository,
    deviceKeySigner: DeviceKeySigner,
    modifier: Modifier = Modifier,
    pendingDeepLink: DeepLinkTarget? = null,
    onDeepLinkConsumed: () -> Unit = {}
) {
    val colors = StudioNorthTheme.colors
    val scope = rememberCoroutineScope()
    val sessionState by sessionRepo.sessionState.collectAsState()

    if (sessionState !is SessionState.Authenticated) {
        val pairLink = pendingDeepLink as? DeepLinkTarget.Pair
        PairEnrollScreen(
            instanceRepo = instanceRepo,
            sessionRepo = sessionRepo,
            deviceKeySigner = deviceKeySigner,
            modifier = modifier,
            initialOrigin = pairLink?.origin,
            initialCode = pairLink?.code,
            onConnected = {
                if (pairLink != null) onDeepLinkConsumed()
            }
        )
        return
    }

    val activeInstance by instanceRepo.activeInstance.collectAsState()
    val instances by instanceRepo.instances.collectAsState()
    val activeOrg by sessionRepo.activeOrg.collectAsState()
    val me by sessionRepo.me.collectAsState()
    val isInstanceAdmin by sessionRepo.isInstanceAdmin.collectAsState()
    val storedToken = (sessionState as? SessionState.Authenticated)?.token

    val apiClient = remember(activeInstance.originUrl, storedToken) {
        HarnessApiClient(
            baseUrl = activeInstance.originUrl,
            tokenProvider = { storedToken },
            signerProvider = { deviceKeySigner }
        )
    }

    var selectedTab by remember { mutableStateOf(ShellTab.APPROVALS) }
    var focusedApprovalId by remember { mutableStateOf<String?>(null) }
    var focusedRunId by remember { mutableStateOf<String?>(null) }
    var focusedChannelId by remember { mutableStateOf<String?>(null) }
    var showHaltDialog by remember { mutableStateOf(false) }
    var isHalted by remember { mutableStateOf(false) }

    LaunchedEffect(pendingDeepLink, me) {
        when (pendingDeepLink) {
            is DeepLinkTarget.Approval -> {
                selectedTab = ShellTab.APPROVALS
                focusedApprovalId = pendingDeepLink.approvalId
                onDeepLinkConsumed()
            }
            is DeepLinkTarget.Run -> {
                selectedTab = ShellTab.RUNS
                focusedRunId = pendingDeepLink.runId
                onDeepLinkConsumed()
            }
            is DeepLinkTarget.Chat -> {
                selectedTab = ShellTab.CHAT
                val targetOrg = pendingDeepLink.orgSlug?.let { slug ->
                    me?.orgs?.find { it.slug.equals(slug, ignoreCase = true) }
                }
                if (targetOrg != null) {
                    sessionRepo.selectOrg(targetOrg.id)
                }
                focusedChannelId = pendingDeepLink.channelId
                onDeepLinkConsumed()
            }
            is DeepLinkTarget.Pair -> onDeepLinkConsumed()
            null -> Unit
        }
    }

    if (showHaltDialog) {
        HaltConfirmDialog(
            isCurrentlyHalted = isHalted,
            onConfirm = { nextHalt ->
                isHalted = nextHalt
                scope.launch {
                    val token = sessionRepo.getStoredToken()
                    val client = HarnessApiClient(
                        baseUrl = activeInstance.originUrl,
                        tokenProvider = { token },
                        signerProvider = { deviceKeySigner }
                    )
                    withContext(Dispatchers.IO) {
                        try {
                            client.postHalt(nextHalt)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            isHalted = !nextHalt
                        }
                    }
                }
            },
            onDismiss = { showHaltDialog = false }
        )
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            ShellTopBar(
                activeInstance = activeInstance,
                instances = instances,
                activeOrg = activeOrg,
                orgs = me?.orgs ?: emptyList(),
                isInstanceAdmin = isInstanceAdmin,
                isHalted = isHalted,
                onSelectInstance = { instanceRepo.selectInstance(it) },
                onSelectOrg = { sessionRepo.selectOrg(it) },
                onOpenHaltDialog = { showHaltDialog = true }
            )
        },
        bottomBar = {
            Column(modifier = Modifier.fillMaxWidth().background(colors.surface)) {
                HairlineDivider()
                NavigationBar(
                    containerColor = colors.surface,
                    contentColor = colors.ink,
                    tonalElevation = 0.dp
                ) {
                    ShellTab.entries.forEach { tab ->
                        val isSelected = selectedTab == tab
                        NavigationBarItem(
                            selected = isSelected,
                            onClick = { selectedTab = tab },
                            modifier = Modifier
                                .testTag("tab.${tab.name.lowercase()}")
                                .semantics { contentDescription = "${tab.title} tab" },
                            icon = { Icon(tab.icon, contentDescription = null) },
                            label = {
                                Text(
                                    text = tab.title,
                                    fontSize = 11.sp,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = colors.brand,
                                selectedTextColor = colors.brand,
                                unselectedIconColor = colors.inkMuted,
                                unselectedTextColor = colors.inkMuted,
                                indicatorColor = colors.surfaceRaised
                            )
                        )
                    }
                }
            }
        }
    ) { padding ->
        val screenModifier = Modifier.padding(padding)
        when (selectedTab) {
            ShellTab.APPROVALS -> ApprovalsScreen(
                session = sessionRepo,
                modifier = screenModifier,
                baseUrl = activeInstance.originUrl,
                customClient = apiClient.client,
                focusedApprovalId = focusedApprovalId,
                onNavigateToRun = { runId ->
                    focusedRunId = runId
                    selectedTab = ShellTab.RUNS
                }
            )
            ShellTab.BOARD -> BoardScreen(
                session = sessionRepo,
                modifier = screenModifier,
                baseUrl = activeInstance.originUrl
            )
            ShellTab.RUNS -> RunsScreen(
                session = sessionRepo,
                modifier = screenModifier,
                baseUrl = activeInstance.originUrl,
                customClient = apiClient.client,
                focusedRunId = focusedRunId
            )
            ShellTab.CHAT -> ChatScreen(
                session = sessionRepo,
                modifier = screenModifier,
                baseUrl = activeInstance.originUrl,
                focusedChannelId = focusedChannelId
            )
            ShellTab.WORKSPACE -> WorkspaceScreen(
                session = sessionRepo,
                modifier = screenModifier,
                baseUrl = activeInstance.originUrl,
                instanceRepo = instanceRepo,
                customClient = apiClient.client
            )
        }
    }
}
