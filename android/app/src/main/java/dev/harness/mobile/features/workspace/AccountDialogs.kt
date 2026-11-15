package dev.harness.mobile.features.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.harness.mobile.theme.ActionPill
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun AddInstanceDialog(
    onDismiss: () -> Unit,
    onConfirm: (String, String) -> Unit
) {
    val colors = StudioNorthTheme.colors
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.surface,
        title = { Text("Add Server Instance", color = colors.ink) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Instance Name") },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("Origin URL") },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            ActionPill(
                text = "Add",
                onClick = { onConfirm(name, url) }
            )
        },
        dismissButton = {
            Text(
                text = "Cancel",
                color = colors.inkMuted,
                modifier = Modifier.clickable { onDismiss() }.padding(8.dp)
            )
        }
    )
}

@Composable
fun RegisterPushDialog(
    onDismiss: () -> Unit,
    onConfirm: (String, String) -> Unit
) {
    val colors = StudioNorthTheme.colors
    var relayUrl by remember { mutableStateOf("https://relay.example.com") }
    var pushToken by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.surface,
        title = { Text("Register Push Notifications", color = colors.ink) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = relayUrl,
                    onValueChange = { relayUrl = it },
                    label = { Text("Relay URL") },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = pushToken,
                    onValueChange = { pushToken = it },
                    label = { Text("Device Push Token") },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            ActionPill(
                text = "Register",
                onClick = { onConfirm(relayUrl, pushToken) }
            )
        },
        dismissButton = {
            Text(
                text = "Cancel",
                color = colors.inkMuted,
                modifier = Modifier.clickable { onDismiss() }.padding(8.dp)
            )
        }
    )
}
