package com.pimobile.app.ui.theme

import androidx.compose.ui.graphics.Color
import kotlinx.coroutines.flow.MutableStateFlow

object ThemeState {
    val isDarkTheme = MutableStateFlow(true)
}

data class AppColors(
    val background: Color,
    val surfaceColor: Color,
    val surfaceContainer: Color,
    val primaryAccent: Color,
    val outlineColor: Color,
    val outlineVariant: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val userBubbleBg: Color,
    val userBubbleBorder: Color,
    val userBubbleText: Color,
    val codeBackground: Color,
    val statusGreen: Color,
    val statusGreenBg: Color,
    val statusGreenBorder: Color,
    val statusGreenIconBg: Color,
    val statusGreenIcon: Color,
    val statusYellow: Color,
    val statusYellowBg: Color,
    val statusYellowBorder: Color,
    val statusYellowText: Color,
    val statusRed: Color
)

val DarkAppColors = AppColors(
    background = Color(0xFF0D0D0D),
    surfaceColor = Color(0xFF141414),
    surfaceContainer = Color(0xFF1A1A1A),
    primaryAccent = Color(0xFF2563EB), // blue-600
    outlineColor = Color(0x0DFFFFFF), // white/5
    outlineVariant = Color(0x1AFFFFFF), // white/10
    textPrimary = Color(0xFFE2E2E2),
    textSecondary = Color(0x66FFFFFF), // white/40
    textMuted = Color(0x4DFFFFFF), // white/30
    userBubbleBg = Color(0x332563EB), // blue-600/20
    userBubbleBorder = Color(0x4D3B82F6), // blue-500/30
    userBubbleText = Color(0xFFEFF6FF), // blue-50
    codeBackground = Color(0x66000000), // black/40
    statusGreen = Color(0xFF10B981), // emerald-500
    statusGreenBg = Color(0x0D10B981), // emerald-500/5
    statusGreenBorder = Color(0x4D10B981), // emerald-500/30
    statusGreenIconBg = Color(0x3310B981), // emerald-500/20
    statusGreenIcon = Color(0xFF34D399), // emerald-400
    statusYellow = Color(0xFFF59E0B), // amber-500
    statusYellowBg = Color(0x1AF59E0B), // amber-500/10
    statusYellowBorder = Color(0x66F59E0B), // amber-500/40
    statusYellowText = Color(0xFFFDE68A), // amber-200
    statusRed = Color(0xFFEF4444) // red-500
)

val LightAppColors = AppColors(
    background = Color(0xFFFAFAFA),
    surfaceColor = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFF4F4F5), // zinc-100
    primaryAccent = Color(0xFF2563EB), // blue-600
    outlineColor = Color(0x0D000000), // black/5
    outlineVariant = Color(0x1A000000), // black/10
    textPrimary = Color(0xFF27272A), // zinc-800
    textSecondary = Color(0x9927272A), // zinc-800/60
    textMuted = Color(0x6627272A), // zinc-800/40
    userBubbleBg = Color(0xFFEFF6FF), // blue-50
    userBubbleBorder = Color(0xFFBFDBFE), // blue-200
    userBubbleText = Color(0xFF1E3A8A), // blue-900
    codeBackground = Color(0x0D000000), // black/5
    statusGreen = Color(0xFF059669), // emerald-600
    statusGreenBg = Color(0xFFECFDF5), // emerald-50
    statusGreenBorder = Color(0xFFA7F3D0), // emerald-200
    statusGreenIconBg = Color(0xFFD1FAE5), // emerald-100
    statusGreenIcon = Color(0xFF059669), // emerald-600
    statusYellow = Color(0xFFD97706), // amber-600
    statusYellowBg = Color(0xFFFFFBEB), // amber-50
    statusYellowBorder = Color(0xFFFDE68A), // amber-200
    statusYellowText = Color(0xFF92400E), // amber-800
    statusRed = Color(0xFFEF4444) // red-500
)

