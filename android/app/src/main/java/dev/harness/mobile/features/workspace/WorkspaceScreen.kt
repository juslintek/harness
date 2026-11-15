package dev.harness.mobile.features.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.network.HarnessWsClient
import dev.harness.mobile.core.store.InstanceRepository
import dev.harness.mobile.core.store.SessionRepository
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.StudioNorthTheme

enum class WorkspaceTab(val title: String) {
    DASHBOARD("Dashboard"),
    MEMORY("Memory Vault"),
    ACCOUNT("Account & Settings")
}

@Composable
fun WorkspaceScreen(
    session: SessionRepository,
    modifier: Modifier = Modifier,
    baseUrl: String = "http://127.0.0.1:4100",
    dashboardViewModel: DashboardViewModel? = null,
    memoryViewModel: MemoryViewModel? = null,
    accountViewModel: AccountViewModel? = null,
    instanceRepo: InstanceRepository? = null,
    wsClient: HarnessWsClient? = null,
    customClient: okhttp3.OkHttpClient? = null
) {
    val colors = StudioNorthTheme.colors
    val activeOrg by session.activeOrg.collectAsState()
    val isInstanceAdmin by session.isInstanceAdmin.collectAsState()
    val orgSlug = activeOrg?.slug ?: "default"
    val isAdmin = isInstanceAdmin || activeOrg?.role == "admin" || activeOrg?.role == "owner"

    var storedToken by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        storedToken = session.getStoredToken()
    }

    val repository = remember(baseUrl, storedToken, customClient) {
        WorkspaceHttpRepository(
            baseUrlProvider = { baseUrl },
            tokenProvider = { storedToken },
            client = customClient ?: okhttp3.OkHttpClient()
        )
    }

    val dashVm = dashboardViewModel ?: remember(repository, wsClient) {
        DashboardViewModel(repository, wsFlow = wsClient?.messages)
    }
    val memVm = memoryViewModel ?: remember(repository, wsClient) {
        MemoryViewModel(repository, wsFlow = wsClient?.messages)
    }
    val accVm = accountViewModel ?: remember(repository) {
        AccountViewModel(repository)
    }

    val instRepo = instanceRepo ?: remember { InstanceRepository() }
    val instances by instRepo.instances.collectAsState()
    val activeInstance by instRepo.activeInstance.collectAsState()

    val dashState by dashVm.state.collectAsState()
    val memState by memVm.state.collectAsState()
    val accState by accVm.state.collectAsState()

    var selectedTab by remember { mutableStateOf(WorkspaceTab.DASHBOARD) }

    LaunchedEffect(orgSlug, storedToken) {
        if (orgSlug.isNotBlank() && (dashboardViewModel != null || !storedToken.isNullOrBlank())) {
            dashVm.load(orgSlug)
            memVm.load(orgSlug)
            accVm.load(orgSlug)
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
    ) {
        if (memState.isEditorOpen) {
            NoteEditorSheet(
                state = memState,
                onDraftChange = { memVm.updateEditorDraft(it) },
                onSave = { memVm.saveNoteDraft() },
                onClose = { memVm.closeEditor() },
                onOverwriteConflict = { memVm.resolveConflictOverwrite() },
                onReloadRemoteConflict = { memVm.resolveConflictReloadRemote() }
            )
        } else {
            Column(modifier = Modifier.fillMaxSize()) {
                // Header & Top Tab Bar
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 10.dp)
                ) {
                    Text(
                        text = "Workspace Hub",
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.ink
                    )
                    Spacer(modifier = Modifier.height(10.dp))
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        WorkspaceTab.entries.forEach { tab ->
                            val isSelected = selectedTab == tab
                            Box(
                                modifier = Modifier
                                    .weight(1f)
                                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                                    .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                                    .background(if (isSelected) colors.brand else colors.surfaceRaised)
                                    .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                                    .clickable { selectedTab = tab }
                                    .padding(horizontal = 6.dp, vertical = 8.dp)
                                    .testTag("workspace.tab.${tab.name.lowercase()}")
                                    .semantics { contentDescription = "${tab.title} tab" },
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = tab.title,
                                    fontSize = 12.sp,
                                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                                    color = if (isSelected) colors.onBrand else colors.ink,
                                    textAlign = TextAlign.Center,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                }

                HairlineDivider()

                // Banner Notices / Errors
                val banner = memState.bannerNotice ?: accState.bannerNotice
                if (banner != null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(colors.surfaceRaised)
                            .padding(horizontal = 16.dp, vertical = 6.dp)
                    ) {
                        Text(
                            text = banner,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.brand
                        )
                    }
                    HairlineDivider()
                }

                val errorMsg = dashState.error ?: memState.error ?: accState.error
                if (errorMsg != null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(colors.danger.copy(alpha = 0.15f))
                            .padding(horizontal = 16.dp, vertical = 6.dp)
                    ) {
                        Text(
                            text = errorMsg,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.danger
                        )
                    }
                    HairlineDivider()
                }

                // Main Content Body
                Box(modifier = Modifier.weight(1f)) {
                    when (selectedTab) {
                        WorkspaceTab.DASHBOARD -> {
                            DashboardSection(
                                state = dashState,
                                onSelectRange = { dashVm.selectRange(it) },
                                onRefresh = { dashVm.refresh() }
                            )
                        }
                        WorkspaceTab.MEMORY -> {
                            MemorySection(
                                state = memState,
                                isAdmin = isAdmin,
                                onSearchChange = { memVm.search(it) },
                                onSelectScopeFilter = { memVm.setScopeFilter(it) },
                                onSelectTypeFilter = { memVm.setTypeFilter(it) },
                                onSelectTagFilter = { memVm.setTagFilter(it) },
                                onOpenNoteDetail = { memVm.openNoteDetail(it) },
                                onCloseNoteDetail = { memVm.closeNoteDetail() },
                                onOpenNewNote = { memVm.openNewNoteEditor() },
                                onOpenEditNote = { memVm.openEditNoteEditor(it) },
                                onDeleteNote = { id, hash -> memVm.deleteNote(id, hash) },
                                onResolveWikilink = { memVm.resolveWikilink(it) },
                                onRevertWrite = { memVm.revertWrite(it) },
                                onFilterLessons = { memVm.filterLessons(it) },
                                onDecideLesson = { id, dec, reason -> memVm.decideLesson(id, dec, reason) }
                            )
                        }
                        WorkspaceTab.ACCOUNT -> {
                            AccountSection(
                                state = accState,
                                onTogglePref = { channel, kind -> accVm.togglePref(channel, kind) },
                                onRevokeDevice = { accVm.revokeDevice(it) },
                                onRegisterPush = { url, token -> accVm.registerPush(url, token) },
                                instances = instances,
                                activeInstance = activeInstance,
                                onSelectInstance = { instRepo.selectInstance(it) },
                                onAddInstance = { name, url -> instRepo.addInstance(name, url) },
                                onRemoveInstance = { instRepo.removeInstance(it) },
                                isInstanceAdmin = isInstanceAdmin,
                                instanceOrigin = activeInstance?.originUrl ?: baseUrl,
                                orgSlug = orgSlug
                            )
                        }
                    }
                }
            }
        }
    }
}
