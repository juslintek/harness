package dev.harness.mobile.features.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.harness.mobile.theme.SecondaryLinkButton
import dev.harness.mobile.theme.StudioNorthTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HaltConfirmDialog(
    isCurrentlyHalted: Boolean,
    onConfirm: (Boolean) -> Unit,
    onDismiss: () -> Unit
) {
    val colors = StudioNorthTheme.colors
    val nextHaltState = !isCurrentlyHalted

    BasicAlertDialog(
        onDismissRequest = onDismiss
    ) {
        Column(
            modifier = Modifier
                .clip(RoundedCornerShape(StudioNorthTheme.radius12))
                .background(colors.surface)
                .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
                .padding(20.dp)
        ) {
            Text(
                text = if (nextHaltState) "Emergency Halt Instance?" else "Resume Instance?",
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                color = if (nextHaltState) colors.danger else colors.ink
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = if (nextHaltState) {
                    "Halting the instance terminates all active agent processes immediately and refuses new runs until resumed."
                } else {
                    "Resuming the instance allows queued tasks and new agent runs to proceed normally."
                },
                fontSize = 14.sp,
                color = colors.inkMuted,
                lineHeight = 20.sp
            )
            Spacer(modifier = Modifier.height(24.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End
            ) {
                SecondaryLinkButton(
                    text = "Cancel",
                    onClick = onDismiss
                )
                Spacer(modifier = Modifier.width(12.dp))
                Button(
                    onClick = {
                        onConfirm(nextHaltState)
                        onDismiss()
                    },
                    shape = RoundedCornerShape(StudioNorthTheme.radius24),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (nextHaltState) colors.danger else colors.brand,
                        contentColor = colors.onBrand
                    ),
                    elevation = ButtonDefaults.buttonElevation(defaultElevation = 0.dp)
                ) {
                    Text(
                        text = if (nextHaltState) "Halt Now" else "Resume Now",
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }
    }
}
