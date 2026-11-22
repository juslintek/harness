package dev.harness.mobile.features.workspace

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.theme.HairlineDivider
import dev.harness.mobile.theme.RaisedCard
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun NotificationMatrix(
    state: AccountState,
    onTogglePref: (String, String) -> Unit,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    val hScrollState = rememberScrollState()

    RaisedCard(modifier = modifier.fillMaxWidth()) {
        Box(modifier = Modifier.fillMaxWidth().horizontalScroll(hScrollState)) {
            Column {
                // Table Header
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.width(130.dp)) {
                        Text(
                            text = "Event",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = colors.inkMuted
                        )
                    }
                    NOTIFY_CHANNELS.forEach { channel ->
                        Box(modifier = Modifier.width(72.dp), contentAlignment = Alignment.Center) {
                            Text(
                                text = CHANNEL_LABELS[channel] ?: channel,
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.ink
                            )
                        }
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                HairlineDivider()
                Spacer(modifier = Modifier.height(6.dp))

                // Table Rows (5 kinds x 5 channels = 25 cells)
                NOTIFY_KINDS.forEach { kind ->
                    Row(
                        modifier = Modifier.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(modifier = Modifier.width(130.dp)) {
                            Text(
                                text = KIND_LABELS[kind] ?: kind,
                                fontSize = 12.sp,
                                color = colors.ink
                            )
                        }
                        NOTIFY_CHANNELS.forEach { channel ->
                            val isEnabled = state.isPrefEnabled(channel, kind)
                            Box(modifier = Modifier.width(72.dp), contentAlignment = Alignment.Center) {
                                Checkbox(
                                    checked = isEnabled,
                                    onCheckedChange = { onTogglePref(channel, kind) },
                                    colors = CheckboxDefaults.colors(
                                        checkedColor = colors.brand,
                                        uncheckedColor = colors.border,
                                        checkmarkColor = colors.onBrand
                                    )
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
