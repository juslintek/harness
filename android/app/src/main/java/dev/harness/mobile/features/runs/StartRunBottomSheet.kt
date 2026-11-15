package dev.harness.mobile.features.runs

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StartRunBottomSheet(
    onDismiss: () -> Unit,
    onSubmit: (agentId: String, repo: String, prompt: String, model: String?) -> Unit,
    isLoading: Boolean,
    haltedError: String? = null
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val colors = StudioNorthTheme.colors

    var agentId by remember { mutableStateOf("claude-code") }
    var repo by remember { mutableStateOf("/Users/alice/projects/harness") }
    var prompt by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surfaceRaised,
        tonalElevation = 0.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 12.dp)
        ) {
            Text(
                text = "Start New Run",
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = colors.ink
            )

            Spacer(modifier = Modifier.height(12.dp))

            if (!haltedError.isNullOrBlank()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                        .background(colors.danger.copy(alpha = 0.15f))
                        .border(1.dp, colors.danger, RoundedCornerShape(StudioNorthTheme.radius12))
                        .padding(12.dp)
                ) {
                    Text(
                        text = haltedError,
                        color = colors.danger,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            OutlinedTextField(
                value = agentId,
                onValueChange = { agentId = it },
                label = { Text("Agent ID") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = colors.brand,
                    unfocusedBorderColor = colors.border,
                    focusedTextColor = colors.ink,
                    unfocusedTextColor = colors.ink
                )
            )

            Spacer(modifier = Modifier.height(8.dp))

            OutlinedTextField(
                value = repo,
                onValueChange = { repo = it },
                label = { Text("Repository Path") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = colors.brand,
                    unfocusedBorderColor = colors.border,
                    focusedTextColor = colors.ink,
                    unfocusedTextColor = colors.ink
                )
            )

            Spacer(modifier = Modifier.height(8.dp))

            OutlinedTextField(
                value = model,
                onValueChange = { model = it },
                label = { Text("Model (Optional)") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = colors.brand,
                    unfocusedBorderColor = colors.border,
                    focusedTextColor = colors.ink,
                    unfocusedTextColor = colors.ink
                )
            )

            Spacer(modifier = Modifier.height(8.dp))

            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                label = { Text("Prompt") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3,
                maxLines = 5,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = colors.brand,
                    unfocusedBorderColor = colors.border,
                    focusedTextColor = colors.ink,
                    unfocusedTextColor = colors.ink
                )
            )

            Spacer(modifier = Modifier.height(16.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically
            ) {
                SecondaryLinkButton(
                    text = "Cancel",
                    onClick = onDismiss,
                    enabled = !isLoading
                )
                Spacer(modifier = Modifier.width(10.dp))
                ActionPill(
                    text = "Launch Run",
                    onClick = {
                        if (prompt.isNotBlank() && agentId.isNotBlank() && repo.isNotBlank()) {
                            onSubmit(agentId, repo, prompt, model.ifBlank { null })
                        }
                    },
                    enabled = !isLoading && prompt.isNotBlank()
                )
            }

            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}
