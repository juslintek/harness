package dev.harness.mobile.features.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.*
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.StudioNorthTheme

enum class MemorySubTab(val title: String) {
    VAULT("Vault Notes"),
    WRITES("Write Feed"),
    LESSONS("Lesson Review")
}

@Composable
fun MemorySection(
    state: MemoryState,
    isAdmin: Boolean = false,
    onSearchChange: (String) -> Unit,
    onSelectScopeFilter: (String?) -> Unit,
    onSelectTypeFilter: (String?) -> Unit,
    onSelectTagFilter: (String?) -> Unit,
    onOpenNoteDetail: (String) -> Unit,
    onCloseNoteDetail: () -> Unit,
    onOpenNewNote: () -> Unit,
    onOpenEditNote: (NoteView) -> Unit,
    onDeleteNote: (String, String) -> Unit,
    onResolveWikilink: (String) -> Unit,
    onRevertWrite: (String) -> Unit,
    onFilterLessons: (String?) -> Unit,
    onDecideLesson: (String, String, String) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    var activeSubTab by remember { mutableStateOf(MemorySubTab.VAULT) }
    var wikilinkInput by remember { mutableStateOf("") }
    var showLessonDecisionDialog by remember { mutableStateOf<Pair<String, String>?>(null) }
    var decisionReason by remember { mutableStateOf("") }

    Column(modifier = modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            MemorySubTab.entries.forEach { tab ->
                val isSelected = activeSubTab == tab
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(StudioNorthTheme.radius24))
                        .background(if (isSelected) colors.brand else colors.surfaceRaised)
                        .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius24))
                        .clickable { activeSubTab = tab }
                        .padding(horizontal = 14.dp, vertical = 6.dp)
                ) {
                    Text(
                        text = tab.title,
                        fontSize = 12.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                        color = if (isSelected) colors.onBrand else colors.ink
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(4.dp))

        when (activeSubTab) {
            MemorySubTab.VAULT -> {
                OutlinedTextField(
                    value = state.searchQuery,
                    onValueChange = onSearchChange,
                    placeholder = { Text("Search notes...", fontSize = 13.sp) },
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = colors.brand,
                        unfocusedBorderColor = colors.border
                    )
                )
                Spacer(modifier = Modifier.height(6.dp))
                // Scope Filter Chips
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    contentPadding = PaddingValues(vertical = 2.dp)
                ) {
                    item {
                        FilterChip(
                            label = "All Scopes",
                            selected = state.selectedScopeFilter == null,
                            onClick = { onSelectScopeFilter(null) }
                        )
                    }
                    items(state.facets.scopes.keys.toList()) { scopeKey ->
                        FilterChip(
                            label = "$scopeKey (${state.facets.scopes[scopeKey]})",
                            selected = state.selectedScopeFilter == scopeKey,
                            onClick = {
                                onSelectScopeFilter(if (state.selectedScopeFilter == scopeKey) null else scopeKey)
                            }
                        )
                    }
                }
                // Type & Tag Filter Chips
                if (state.facets.types.isNotEmpty() || state.facets.tags.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(4.dp))
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        contentPadding = PaddingValues(vertical = 2.dp)
                    ) {
                        if (state.facets.types.isNotEmpty()) {
                            item {
                                FilterChip(
                                    label = "All Types",
                                    selected = state.selectedTypeFilter == null,
                                    onClick = { onSelectTypeFilter(null) }
                                )
                            }
                            items(state.facets.types.keys.toList()) { typeKey ->
                                FilterChip(
                                    label = "$typeKey (${state.facets.types[typeKey]})",
                                    selected = state.selectedTypeFilter == typeKey,
                                    onClick = {
                                        onSelectTypeFilter(if (state.selectedTypeFilter == typeKey) null else typeKey)
                                    }
                                )
                            }
                        }
                        if (state.facets.tags.isNotEmpty()) {
                            items(state.facets.tags.keys.toList()) { tagKey ->
                                FilterChip(
                                    label = "#$tagKey (${state.facets.tags[tagKey]})",
                                    selected = state.selectedTagFilter == tagKey,
                                    onClick = {
                                        onSelectTagFilter(if (state.selectedTagFilter == tagKey) null else tagKey)
                                    }
                                )
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Notes (${state.notes.size})",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.inkMuted
                    )
                    Text(
                        text = "+ New Note",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.link,
                        modifier = Modifier.clickable { onOpenNewNote() }.padding(4.dp)
                    )
                }
                Spacer(modifier = Modifier.height(6.dp))
                LazyColumn(
                    modifier = Modifier.fillMaxSize().testTag("memory.notes.list"),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(bottom = 16.dp)
                ) {
                    items(state.notes) { note ->
                        NoteCard(note = note, onClick = { onOpenNoteDetail(note.id) })
                    }
                }
            }

            MemorySubTab.WRITES -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(state.writes) { write ->
                        WriteFeedCard(write = write, onRevert = { onRevertWrite(write.id) })
                    }
                }
            }

            MemorySubTab.LESSONS -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(state.lessons) { lesson ->
                        LessonCard(
                            lesson = lesson,
                            isAdmin = isAdmin,
                            onAccept = { showLessonDecisionDialog = lesson.id to "accept" },
                            onReject = { showLessonDecisionDialog = lesson.id to "reject" }
                        )
                    }
                }
            }
        }
    }

    // Note Detail Dialog
    state.selectedNote?.let { note ->
        AlertDialog(
            onDismissRequest = onCloseNoteDetail,
            containerColor = colors.surface,
            title = {
                Column {
                    Text(text = note.title, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = colors.ink)
                    Text(text = note.path, fontSize = 12.sp, color = colors.inkMuted)
                }
            },
            text = {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(colors.surfaceRaised)
                            .padding(8.dp)
                    ) {
                        Text(text = note.body, fontSize = 13.sp, fontFamily = FontFamily.Monospace, color = colors.ink)
                    }
                    if (state.backlinks.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(text = "Backlinks (${state.backlinks.size})", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = colors.inkMuted)
                        state.backlinks.forEach { bl ->
                            Text(text = "• ${bl.title}", fontSize = 12.sp, color = colors.link)
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = wikilinkInput,
                            onValueChange = { wikilinkInput = it },
                            placeholder = { Text("[[Target]]", fontSize = 11.sp) },
                            modifier = Modifier.weight(1f).height(44.dp),
                            singleLine = true
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = "Find",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = colors.link,
                            modifier = Modifier.clickable { onResolveWikilink(wikilinkInput) }.padding(4.dp)
                        )
                    }
                    state.wikilinkResult?.let { linkHit ->
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(text = "Found: ${linkHit.title} (${linkHit.path})", fontSize = 11.sp, color = colors.ink)
                    }
                }
            },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Edit",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.link,
                        modifier = Modifier.clickable { onOpenEditNote(note) }.padding(8.dp)
                    )
                    Text(
                        text = "Delete",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.danger,
                        modifier = Modifier.clickable { onDeleteNote(note.id, note.hash) }.padding(8.dp)
                    )
                }
            },
            dismissButton = {
                Text(
                    text = "Close",
                    fontSize = 13.sp,
                    color = colors.inkMuted,
                    modifier = Modifier.clickable { onCloseNoteDetail() }.padding(8.dp)
                )
            }
        )
    }

    // Lesson Decision Dialog
    showLessonDecisionDialog?.let { (lessonId, decision) ->
        AlertDialog(
            onDismissRequest = { showLessonDecisionDialog = null },
            containerColor = colors.surface,
            title = {
                Text(
                    text = "${decision.replaceFirstChar { it.uppercase() }} Lesson",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
            },
            text = {
                OutlinedTextField(
                    value = decisionReason,
                    onValueChange = { decisionReason = it },
                    label = { Text("Reason") },
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                ActionPill(
                    text = "Confirm",
                    onClick = {
                        onDecideLesson(lessonId, decision, decisionReason)
                        decisionReason = ""
                        showLessonDecisionDialog = null
                    }
                )
            },
            dismissButton = {
                Text(
                    text = "Cancel",
                    color = colors.inkMuted,
                    modifier = Modifier.clickable { showLessonDecisionDialog = null }.padding(8.dp)
                )
            }
        )
    }
}
