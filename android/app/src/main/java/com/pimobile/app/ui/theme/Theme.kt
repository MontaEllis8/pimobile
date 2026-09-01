package com.pimobile.app.ui.theme

import android.app.Activity
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

val LocalAppColors = staticCompositionLocalOf<AppColors> { error("No colors provided") }

@Composable
fun AppTheme(
    content: @Composable () -> Unit
) {
    val isDark by ThemeState.isDarkTheme.collectAsState()
    val colors = if (isDark) DarkAppColors else LightAppColors

    val animatedColors = AppColors(
        background = animateColorAsState(colors.background, label = "background").value,
        surfaceColor = animateColorAsState(colors.surfaceColor, label = "surface").value,
        surfaceContainer = animateColorAsState(colors.surfaceContainer, label = "surfaceContainer").value,
        primaryAccent = animateColorAsState(colors.primaryAccent, label = "primary").value,
        outlineColor = animateColorAsState(colors.outlineColor, label = "outline").value,
        outlineVariant = animateColorAsState(colors.outlineVariant, label = "outlineVariant").value,
        textPrimary = animateColorAsState(colors.textPrimary, label = "textPrimary").value,
        textSecondary = animateColorAsState(colors.textSecondary, label = "textSecondary").value,
        textMuted = animateColorAsState(colors.textMuted, label = "textMuted").value,
        userBubbleBg = animateColorAsState(colors.userBubbleBg, label = "userBubbleBg").value,
        userBubbleBorder = animateColorAsState(colors.userBubbleBorder, label = "userBubbleBorder").value,
        userBubbleText = animateColorAsState(colors.userBubbleText, label = "userBubbleText").value,
        codeBackground = animateColorAsState(colors.codeBackground, label = "codeBackground").value,
        statusGreen = animateColorAsState(colors.statusGreen, label = "statusGreen").value,
        statusGreenBg = animateColorAsState(colors.statusGreenBg, label = "statusGreenBg").value,
        statusGreenBorder = animateColorAsState(colors.statusGreenBorder, label = "statusGreenBorder").value,
        statusGreenIconBg = animateColorAsState(colors.statusGreenIconBg, label = "statusGreenIconBg").value,
        statusGreenIcon = animateColorAsState(colors.statusGreenIcon, label = "statusGreenIcon").value,
        statusYellow = animateColorAsState(colors.statusYellow, label = "statusYellow").value,
        statusYellowBg = animateColorAsState(colors.statusYellowBg, label = "statusYellowBg").value,
        statusYellowBorder = animateColorAsState(colors.statusYellowBorder, label = "statusYellowBorder").value,
        statusYellowText = animateColorAsState(colors.statusYellowText, label = "statusYellowText").value,
        statusRed = animateColorAsState(colors.statusRed, label = "statusRed").value
    )

    val colorScheme = if (isDark) {
        darkColorScheme(
            primary = animatedColors.primaryAccent,
            background = animatedColors.background,
            surface = animatedColors.surfaceColor,
            surfaceVariant = animatedColors.surfaceContainer,
            onPrimary = animatedColors.background,
            onBackground = animatedColors.textPrimary,
            onSurface = animatedColors.textPrimary,
            onSurfaceVariant = animatedColors.textSecondary,
            outline = animatedColors.outlineColor,
            outlineVariant = animatedColors.outlineVariant,
            error = animatedColors.statusRed,
            onError = animatedColors.surfaceColor
        )
    } else {
        lightColorScheme(
            primary = animatedColors.primaryAccent,
            background = animatedColors.background,
            surface = animatedColors.surfaceColor,
            surfaceVariant = animatedColors.surfaceContainer,
            onPrimary = animatedColors.background,
            onBackground = animatedColors.textPrimary,
            onSurface = animatedColors.textPrimary,
            onSurfaceVariant = animatedColors.textSecondary,
            outline = animatedColors.outlineColor,
            outlineVariant = animatedColors.outlineVariant,
            error = animatedColors.statusRed,
            onError = animatedColors.background
        )
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = animatedColors.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !isDark
        }
    }

    CompositionLocalProvider(LocalAppColors provides animatedColors) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = Typography,
            content = content
        )
    }
}