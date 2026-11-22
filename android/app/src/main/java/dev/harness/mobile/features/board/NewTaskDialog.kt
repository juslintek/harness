package dev.harness.mobile.features.board

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun NewTaskDialog(
    members: List<BoardMember>,
    onDismiss: () -> Unit,
    onCreate: (title: String, description: String?, assigneeId: String?, estimateMinutes: Int?) -> Unit
) {
    val colors = StudioNorthTheme.colors
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var estimateText by remember { mutableStateOf("") }
    var assigneeId by remember { mutableStateOf("") }
    var showAssigneeDropdown by remember { mutableStateOf(false) }

    Dialog(onDismissRequest = onDismiss) {
        Card(
            shape = RoundedCornerShape(StudioNorthTheme.radius12),
            colors = CardDefaults.cardColors(containerColor = colors.surface),
            modifier = Modifier.fillMaxWidth().padding(16.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "New Task",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                Spacer(modifier = Modifier.height(12.dp))

                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))

                OutlinedTextField(
                    value = description,
                    onValueChange = { description = it },
                    label = { Text("Description") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(8.dp))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = estimateText,
                        onValueChange = { estimateText = it.filter { ch -> ch.isDigit() } },
                        label = { Text("Est (min)") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )

                    Box(modifier = Modifier.weight(1f)) {
                        OutlinedTextField(
                            value = members.find { it.id == assigneeId }?.let { "@${it.handle}" } ?: "Unassigned",
                            onValueChange = {},
                            readOnly = true,
                            label = { Text("Assignee") },
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { showAssigneeDropdown = true }
                        )
                        DropdownMenu(
                            expanded = showAssigneeDropdown,
                            onDismissRequest = { showAssigneeDropdown = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("Unassigned") },
                                onClick = {
                                    assigneeId = ""
                                    showAssigneeDropdown = false
                                }
                            )
                            members.forEach { m ->
                                DropdownMenuItem(
                                    text = { Text("@${m.handle}") },
                                    onClick = {
                                        assigneeId = m.id
                                        showAssigneeDropdown = false
                                    }
                                )
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) {
                        Text("Cancel", color = colors.inkMuted)
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            if (title.isNotBlank()) {
                                val est = estimateText.toIntOrNull()
                                onCreate(
                                    title.trim(),
                                    description.trim().ifBlank { null },
                                    assigneeId.ifBlank { null },
                                    est
                                )
                            }
                        },
                        enabled = title.isNotBlank(),
                        shape = RoundedCornerShape(StudioNorthTheme.radius24),
                        colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.onBrand)
                    ) {
                        Text("Create")
                    }
                }
            }
        }
    }
}
