package dev.harness.mobile.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import dev.harness.mobile.core.model.ChatMember
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun NewDmDialog(
    members: List<ChatMember>,
    onDismiss: () -> Unit,
    onConfirm: (memberId: String) -> Unit
) {
    val colors = StudioNorthTheme.colors
    var selectedMemberId by remember { mutableStateOf<String?>(null) }

    Dialog(onDismissRequest = onDismiss) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                .background(colors.surfaceRaised)
                .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                .padding(16.dp)
        ) {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "New Direct Message",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = "Select a person or agent to chat with:",
                    fontSize = 13.sp,
                    color = colors.inkMuted
                )
                Spacer(modifier = Modifier.height(8.dp))

                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 240.dp)
                ) {
                    items(members, key = { it.id }) { member ->
                        val isSelected = selectedMemberId == member.id
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (isSelected) colors.surface else colors.surfaceRaised)
                                .clickable { selectedMemberId = member.id }
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column {
                                Text(
                                    text = member.displayName.ifBlank { member.handle },
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 14.sp,
                                    color = colors.ink
                                )
                                Text(
                                    text = "@${member.handle}",
                                    fontSize = 12.sp,
                                    color = colors.inkMuted
                                )
                            }
                            MemberKindBadge(kind = member.kind)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    SecondaryLinkButton(text = "Cancel", onClick = onDismiss)
                    Spacer(modifier = Modifier.width(8.dp))
                    ActionPill(
                        text = "Start DM",
                        enabled = selectedMemberId != null,
                        onClick = {
                            selectedMemberId?.let { onConfirm(it) }
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun NewGroupDialog(
    members: List<ChatMember>,
    onDismiss: () -> Unit,
    onConfirm: (name: String, memberIds: List<String>) -> Unit
) {
    val colors = StudioNorthTheme.colors
    var groupName by remember { mutableStateOf("") }
    val selectedIds = remember { mutableStateListOf<String>() }

    Dialog(onDismissRequest = onDismiss) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                .background(colors.surfaceRaised)
                .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                .padding(16.dp)
        ) {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "New Group Channel",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                Spacer(modifier = Modifier.height(12.dp))

                OutlinedTextField(
                    value = groupName,
                    onValueChange = { groupName = it },
                    label = { Text("Group Name", color = colors.inkMuted) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(StudioNorthTheme.radius12),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = colors.brand,
                        unfocusedBorderColor = colors.border,
                        focusedContainerColor = colors.surface,
                        unfocusedContainerColor = colors.surface,
                        focusedTextColor = colors.ink,
                        unfocusedTextColor = colors.ink
                    ),
                    singleLine = true
                )
                Spacer(modifier = Modifier.height(12.dp))

                Text(
                    text = "Select group members:",
                    fontSize = 13.sp,
                    color = colors.inkMuted
                )
                Spacer(modifier = Modifier.height(6.dp))

                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 200.dp)
                ) {
                    items(members, key = { it.id }) { member ->
                        val isChecked = selectedIds.contains(member.id)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    if (isChecked) selectedIds.remove(member.id) else selectedIds.add(member.id)
                                }
                                .padding(horizontal = 8.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(
                                checked = isChecked,
                                onCheckedChange = { checked ->
                                    if (checked) selectedIds.add(member.id) else selectedIds.remove(member.id)
                                },
                                colors = CheckboxDefaults.colors(
                                    checkedColor = colors.brand,
                                    uncheckedColor = colors.border,
                                    checkmarkColor = colors.onBrand
                                )
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = member.displayName.ifBlank { member.handle },
                                    fontWeight = FontWeight.Medium,
                                    fontSize = 14.sp,
                                    color = colors.ink
                                )
                                Text(
                                    text = "@${member.handle}",
                                    fontSize = 12.sp,
                                    color = colors.inkMuted
                                )
                            }
                            MemberKindBadge(kind = member.kind)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    SecondaryLinkButton(text = "Cancel", onClick = onDismiss)
                    Spacer(modifier = Modifier.width(8.dp))
                    ActionPill(
                        text = "Create Group",
                        enabled = groupName.isNotBlank() && selectedIds.isNotEmpty(),
                        onClick = {
                            onConfirm(groupName.trim(), selectedIds.toList())
                        }
                    )
                }
            }
        }
    }
}
