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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.core.model.EventView
import dev.harness.mobile.theme.StudioNorthTheme

@Composable
fun EventRow(event: EventView) {
    val colors = StudioNorthTheme.colors
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(StudioNorthTheme.radius12))
            .background(colors.surfaceRaised)
            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
            .padding(10.dp)
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "#${event.rowid} • ${event.kind.uppercase()}",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = colors.ink
                )
                if (event.exitCode != null) {
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(if (event.exitCode == 0) colors.surfaceRaised else colors.danger.copy(alpha = 0.2f))
                            .border(1.dp, if (event.exitCode == 0) colors.border else colors.danger, CircleShape)
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text(
                            text = "exit ${event.exitCode}",
                            fontSize = 11.sp,
                            color = if (event.exitCode == 0) colors.inkMuted else colors.danger,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }

            if (!event.toolName.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "tool: ${event.toolName}",
                    fontSize = 12.sp,
                    color = colors.link,
                    fontWeight = FontWeight.Medium
                )
            }

            if (!event.command.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(colors.surface)
                        .border(1.dp, colors.border, RoundedCornerShape(6.dp))
                        .padding(8.dp)
                ) {
                    Text(
                        text = event.command,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        color = colors.ink
                    )
                }
            }

            if (!event.guardVerdict.isNullOrBlank() || !event.guardRule.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Guard [${event.guardLayer ?: "L"}]: ${event.guardVerdict ?: ""} (${event.guardRule ?: ""})",
                    fontSize = 12.sp,
                    color = if (event.guardVerdict == "denied") colors.danger else colors.brand,
                    fontWeight = FontWeight.SemiBold
                )
            }

            if (!event.body.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = event.body,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = colors.inkMuted
                )
            }
        }
    }
}
