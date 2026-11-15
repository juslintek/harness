package dev.harness.mobile.features.board

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.TaskDetail
import dev.harness.mobile.core.model.TaskView
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StatusBadge
import dev.harness.mobile.theme.StudioNorthTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailBottomSheet(
    detail: TaskDetail,
    members: List<BoardMember>,
    projectTasks: List<TaskView>,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onSave: (title: String, desc: String, estimate: Int?, assigneeId: String?) -> Unit,
    onCheckout: () -> Unit,
    onRelease: () -> Unit,
    onWake: (agentId: String) -> Unit,
    onAddDep: (dependsOnTaskId: String) -> Unit,
    onRemoveDep: (dependsOnTaskId: String) -> Unit,
    onAddSubtask: (title: String) -> Unit,
    onAddComment: (body: String) -> Unit
) {
    val colors = StudioNorthTheme.colors
    val task = detail.task

    var title by remember(task.id) { mutableStateOf(task.title) }
    var description by remember(task.id) { mutableStateOf(task.description) }
    var estimateText by remember(task.id) { mutableStateOf(task.estimateMinutes?.toString() ?: "") }
    var assigneeId by remember(task.id) { mutableStateOf(task.assigneeId ?: "") }
    var showAssigneeDropdown by remember { mutableStateOf(false) }

    var depInput by remember { mutableStateOf("") }
    var subtaskTitle by remember { mutableStateOf("") }
    var commentBody by remember { mutableStateOf("") }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = colors.surface,
        contentColor = colors.ink,
        tonalElevation = 0.dp
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Header
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(text = "#${task.number}", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = colors.ink)
                        Spacer(modifier = Modifier.width(8.dp))
                        StatusBadge(status = task.status)
                    }
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = colors.inkMuted)
                    }
                }
                if (errorMessage != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(text = errorMessage, fontSize = 13.sp, color = colors.danger, fontWeight = FontWeight.Medium)
                }
            }

            // Edit fields
            item {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true
                )
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("Description") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = estimateText,
                        onValueChange = { estimateText = it.filter { ch -> ch.isDigit() } },
                        label = { Text("Estimate (min)") },
                        modifier = Modifier.weight(1f),
                        singleLine = true
                    )
                    Box(modifier = Modifier.weight(1f)) {
                        OutlinedTextField(
                            value = members.find { it.id == assigneeId }?.let { "@${it.handle}" } ?: "Unassigned",
                            onValueChange = {},
                            readOnly = true,
                            label = { Text("Assignee") },
                            modifier = Modifier.fillMaxWidth().clickable { showAssigneeDropdown = true }
                        )
                        DropdownMenu(
                            expanded = showAssigneeDropdown,
                            onDismissRequest = { showAssigneeDropdown = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("Unassigned") },
                                onClick = { assigneeId = ""; showAssigneeDropdown = false }
                            )
                            members.forEach { m ->
                                DropdownMenuItem(
                                    text = { Text("@${m.handle} (${m.displayName})") },
                                    onClick = { assigneeId = m.id; showAssigneeDropdown = false }
                                )
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
                Button(
                    onClick = {
                        val est = estimateText.toIntOrNull()
                        onSave(title, description, est, assigneeId.ifBlank { null })
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.onBrand)
                ) {
                    Text("Save Changes", fontWeight = FontWeight.SemiBold)
                }
            }

            // Task Actions (Checkout / Release / Wake)
            item {
                HairlineDivider()
                Spacer(modifier = Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryLinkButton(
                        text = if (task.holderId != null) "Release" else "Checkout",
                        onClick = { if (task.holderId != null) onRelease() else onCheckout() },
                        modifier = Modifier.weight(1f)
                    )
                    if (task.assignee?.kind == "agent" && task.assigneeId != null) {
                        SecondaryLinkButton(
                            text = "Run now",
                            onClick = { onWake(task.assigneeId) },
                            modifier = Modifier.weight(1f)
                        )
                    }
                }
            }

            // Dependencies
            item {
                HairlineDivider()
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = "Dependencies", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = colors.ink)
            }
            if (detail.deps.isEmpty()) {
                item { Text(text = "No dependencies.", fontSize = 13.sp, color = colors.inkMuted) }
            } else {
                items(detail.deps) { dep ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(text = "#${dep.number} ${dep.title}", fontSize = 14.sp, color = colors.ink)
                            Spacer(modifier = Modifier.width(6.dp))
                            StatusBadge(status = dep.status)
                        }
                        TextButton(onClick = { onRemoveDep(dep.id) }) {
                            Text(text = "Remove", color = colors.danger, fontSize = 12.sp)
                        }
                    }
                }
            }
            item {
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = depInput,
                        onValueChange = { depInput = it },
                        placeholder = { Text("Task # or ID") },
                        modifier = Modifier.weight(1f),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            val clean = depInput.trim().removePrefix("#")
                            val matched = projectTasks.find { it.number.toString() == clean || it.id == clean }
                            if (matched != null) {
                                onAddDep(matched.id)
                                depInput = ""
                            }
                        },
                        shape = RoundedCornerShape(StudioNorthTheme.radius24),
                        colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.onBrand)
                    ) {
                        Text("Add Dep")
                    }
                }
            }

            // Subtasks
            item {
                HairlineDivider()
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = "Subtasks", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = colors.ink)
            }
            if (detail.subtasks.isEmpty()) {
                item { Text(text = "No subtasks.", fontSize = 13.sp, color = colors.inkMuted) }
            } else {
                items(detail.subtasks) { sub ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(text = "#${sub.number} ${sub.title}", fontSize = 14.sp, color = colors.ink)
                        StatusBadge(status = sub.status)
                    }
                }
            }
            item {
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = subtaskTitle,
                        onValueChange = { subtaskTitle = it },
                        placeholder = { Text("New subtask title") },
                        modifier = Modifier.weight(1f),
                        singleLine = true
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            if (subtaskTitle.isNotBlank()) {
                                onAddSubtask(subtaskTitle.trim())
                                subtaskTitle = ""
                            }
                        },
                        shape = RoundedCornerShape(StudioNorthTheme.radius24),
                        colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.onBrand)
                    ) {
                        Text("Add Sub")
                    }
                }
            }

            // Comments
            item {
                HairlineDivider()
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = "Comments", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = colors.ink)
            }
            if (detail.comments.isEmpty()) {
                item { Text(text = "No comments yet.", fontSize = 13.sp, color = colors.inkMuted) }
            } else {
                items(detail.comments) { com ->
                    RaisedCard(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = "@${com.author?.handle ?: "system"}",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = colors.link
                        )
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(text = com.body, fontSize = 14.sp, color = colors.ink)
                    }
                }
            }
            item {
                OutlinedTextField(
                    value = commentBody,
                    onValueChange = { commentBody = it },
                    placeholder = { Text("Add a comment…") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2
                )
                Spacer(modifier = Modifier.height(6.dp))
                Button(
                    onClick = {
                        if (commentBody.isNotBlank()) {
                            onAddComment(commentBody.trim())
                            commentBody = ""
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.onBrand)
                ) {
                    Text("Post Comment")
                }
            }
        }
    }
}
