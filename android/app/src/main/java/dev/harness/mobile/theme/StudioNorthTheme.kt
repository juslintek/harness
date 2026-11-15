package dev.harness.mobile.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Immutable
data class StudioNorthColors(
    val surface: Color,
    val surfaceRaised: Color,
    val ink: Color,
    val inkMuted: Color,
    val border: Color,
    val brand: Color,
    val onBrand: Color,
    val accent: Color,
    val link: Color,
    val danger: Color
)

val StudioNorthLightColors = StudioNorthColors(
    surface = Color(0xFFF3F0E8),
    surfaceRaised = Color(0xFFD0D6BC),
    ink = Color(0xFF252A24),
    inkMuted = Color(0xFF626C57),
    border = Color(0xFFCACCC0),
    brand = Color(0xFF252A24),
    onBrand = Color(0xFFF3F0E8),
    accent = Color(0xFFEDBD85),
    link = Color(0xFF77845D),
    danger = Color(0xFFA4452C)
)

val StudioNorthDarkColors = StudioNorthColors(
    surface = Color(0xFF181C17),
    surfaceRaised = Color(0xFF232921),
    ink = Color(0xFFF3F0E8),
    inkMuted = Color(0xFFA9B29C),
    border = Color(0xFF343C31),
    brand = Color(0xFFF3F0E8),
    onBrand = Color(0xFF181C17),
    accent = Color(0xFFEDBD85),
    link = Color(0xFFA3B586),
    danger = Color(0xFFE07A5F)
)

val LocalStudioNorthColors = staticCompositionLocalOf { StudioNorthLightColors }

object StudioNorthTheme {
    val colors: StudioNorthColors
        @Composable
        get() = LocalStudioNorthColors.current

    val elevation0 = 0.dp
    val stroke1 = 1.dp
    val radius12 = 12.dp
    val radius24 = 24.dp
}

@Composable
fun StudioNorthTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val studioColors = if (darkTheme) StudioNorthDarkColors else StudioNorthLightColors

    val materialColors = if (darkTheme) {
        darkColorScheme(
            background = studioColors.surface,
            surface = studioColors.surface,
            surfaceVariant = studioColors.surfaceRaised,
            onBackground = studioColors.ink,
            onSurface = studioColors.ink,
            onSurfaceVariant = studioColors.inkMuted,
            outline = studioColors.border,
            primary = studioColors.brand,
            onPrimary = studioColors.onBrand,
            secondary = studioColors.link,
            error = studioColors.danger
        )
    } else {
        lightColorScheme(
            background = studioColors.surface,
            surface = studioColors.surface,
            surfaceVariant = studioColors.surfaceRaised,
            onBackground = studioColors.ink,
            onSurface = studioColors.ink,
            onSurfaceVariant = studioColors.inkMuted,
            outline = studioColors.border,
            primary = studioColors.brand,
            onPrimary = studioColors.onBrand,
            secondary = studioColors.link,
            error = studioColors.danger
        )
    }

    CompositionLocalProvider(
        LocalStudioNorthColors provides studioColors
    ) {
        MaterialTheme(
            colorScheme = materialColors,
            content = content
        )
    }
}
