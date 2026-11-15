package dev.harness.mobile.features.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun NoteEditorSheet(
    state: MemoryState,
    onDraftChange: (String) -> Unit,
    onSave: () -> Unit,
    onClose: () -> Unit,
    onOverwriteConflict: () -> Unit,
    onReloadRemoteConflict: () -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    val scrollState = rememberScrollState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.surface)
            .padding(16.dp)
            .verticalScroll(scrollState)
    ) {
        // Header
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = if (state.editorNoteId == null) "New Note" else "Edit Note",
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )
            Text(
                text = "Close",
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = colors.inkMuted,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { onClose() }
                    .padding(8.dp)
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        // 409 Conflict Banner / Resolution Sheet (Review Focus #5)
        state.conflictState?.let { conflict ->
            RaisedCard(
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, colors.danger, RoundedCornerShape(StudioNorthTheme.radius12))
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "⚠️ Conflict Detected (409)",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = colors.danger
                    )
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(colors.danger.copy(alpha = 0.2f))
                            .padding(horizontal = 8.dp, vertical = 2.dp)
                    ) {
                        Text(
                            text = "Draft Preserved",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.danger
                        )
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = "Another member updated this note while you were editing. Your changes are preserved below.",
                    fontSize = 12.sp,
                    color = colors.ink
                )
                Spacer(modifier = Modifier.height(10.dp))
                HairlineDivider()
                Spacer(modifier = Modifier.height(10.dp))

                Text(
                    text = "Remote Content (Hash: ${conflict.remoteHash.take(8)}...):",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.inkMuted
                )
                Spacer(modifier = Modifier.height(4.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(6.dp))
                        .padding(8.dp)
                ) {
                    Text(
                        text = conflict.remoteBody.ifBlank { "(empty)" },
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        color = colors.ink
                    )
                }

                Spacer(modifier = Modifier.height(12.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    ActionPill(
                        text = "Overwrite Latest",
                        onClick = onOverwriteConflict,
                        modifier = Modifier.weight(1f)
                    )
                    SecondaryLinkButton(
                        text = "Reload Remote",
                        onClick = onReloadRemoteConflict,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
            Spacer(modifier = Modifier.height(16.dp))
        }

        // Note Metadata preview
        if (state.editorNoteId != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(text = "Path: ${state.editorRelPath}", fontSize = 12.sp, color = colors.inkMuted)
                Text(text = "Scope: ${state.editorScope}", fontSize = 12.sp, color = colors.inkMuted)
            }
            Spacer(modifier = Modifier.height(8.dp))
        }

        // Body Editor Field
        OutlinedTextField(
            value = state.editorDraftBody,
            onValueChange = onDraftChange,
            label = { Text("Markdown Body") },
            modifier = Modifier
                .fillMaxWidth()
                .height(300.dp),
            shape = RoundedCornerShape(StudioNorthTheme.radius12),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = colors.brand,
                unfocusedBorderColor = colors.border,
                focusedTextColor = colors.ink,
                unfocusedTextColor = colors.ink
            )
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Save Button
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End
        ) {
            ActionPill(
                text = if (state.isSavingNote) "Saving..." else "Save Note",
                onClick = onSave,
                enabled = !state.isSavingNote && state.conflictState == null
            )
        }
    }
}
