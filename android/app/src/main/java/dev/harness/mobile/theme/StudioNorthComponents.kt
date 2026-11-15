package dev.harness.mobile.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun ActionPill(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val colors = StudioNorthTheme.colors
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
        shape = RoundedCornerShape(StudioNorthTheme.radius24),
        colors = ButtonDefaults.buttonColors(
            containerColor = colors.brand,
            contentColor = colors.onBrand,
            disabledContainerColor = colors.border,
            disabledContentColor = colors.inkMuted
        ),
        elevation = ButtonDefaults.buttonElevation(
            defaultElevation = 0.dp,
            pressedElevation = 0.dp,
            focusedElevation = 0.dp,
            hoveredElevation = 0.dp
        ),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = "↗",
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp
            )
        }
    }
}

@Composable
fun SecondaryLinkButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    val colors = StudioNorthTheme.colors
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
        shape = RoundedCornerShape(StudioNorthTheme.radius24),
        border = BorderStroke(1.dp, colors.border),
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = colors.link,
            disabledContentColor = colors.inkMuted
        ),
        elevation = ButtonDefaults.buttonElevation(
            defaultElevation = 0.dp,
            pressedElevation = 0.dp
        ),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Text(
            text = text,
            fontWeight = FontWeight.Medium,
            fontSize = 14.sp
        )
    }
}

@Composable
fun RaisedCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit
) {
    val colors = StudioNorthTheme.colors
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(StudioNorthTheme.radius12))
            .background(colors.surfaceRaised)
            .border(1.dp, colors.border, RoundedCornerShape(StudioNorthTheme.radius12))
            .padding(16.dp),
        content = content
    )
}

@Composable
fun HairlineDivider(
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(colors.border)
    )
}

@Composable
fun StatusBadge(
    status: String,
    modifier: Modifier = Modifier
) {
    val colors = StudioNorthTheme.colors
    val (bgColor, textColor) = when (status.lowercase()) {
        "approved", "done", "completed" -> colors.surfaceRaised to colors.brand
        "pending", "queued", "starting" -> colors.accent.copy(alpha = 0.25f) to colors.brand
        "running", "in_progress" -> colors.link.copy(alpha = 0.25f) to colors.link
        "denied", "failed", "blocked", "killed" -> colors.danger.copy(alpha = 0.2f) to colors.danger
        else -> colors.border.copy(alpha = 0.5f) to colors.inkMuted
    }

    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(bgColor)
            .border(1.dp, colors.border, CircleShape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = status.replace('_', ' ').replaceFirstChar { it.uppercase() },
            color = textColor,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium
        )
    }
}
