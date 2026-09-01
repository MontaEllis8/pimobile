package com.pimobile.app.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.Badge
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.pimobile.app.AppContainer
import com.pimobile.app.ui.chat.ChatScreen
import com.pimobile.app.ui.sessions.SessionsScreen

sealed class Screen(val route: String, val title: String, val icon: @Composable () -> Unit) {
    object Chat : Screen("chat", "Chat", { Icon(Icons.Default.ChatBubbleOutline, contentDescription = "Chat") })
    object Sessions : Screen("sessions", "Sessions", { Icon(Icons.Default.List, contentDescription = "Sessions") })
}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()
    val items = listOf(Screen.Chat, Screen.Sessions)

    Scaffold(
        bottomBar = {
            val colors = com.pimobile.app.ui.theme.LocalAppColors.current
            NavigationBar(
                containerColor = colors.surfaceColor,
            ) {
                val navBackStackEntry by navController.currentBackStackEntryAsState()
                val currentDestination = navBackStackEntry?.destination

                items.forEach { screen ->
                    NavigationBarItem(
                        icon = screen.icon,
                        label = { Text(screen.title, fontWeight = FontWeight.Medium) },
                        selected = currentDestination?.hierarchy?.any { it.route == screen.route } == true,
                        onClick = {
                            navController.navigate(screen.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                }
            }
        }
    ) { innerPadding ->
        NavHost(
            navController = navController,
            startDestination = Screen.Chat.route,
            modifier = Modifier.padding(innerPadding)
        ) {
            composable(Screen.Chat.route) {
                ChatScreen(navController = navController)
            }
            composable("chat/{sessionId}?name={sessionName}") { backStackEntry ->
                // P2-6: session ids are routed URL-encoded (a '/' or other reserved
                // char would otherwise break NavHost route parsing and crash).
                val sessionId = backStackEntry.arguments?.getString("sessionId")?.let {
                    try {
                        java.net.URLDecoder.decode(it, "UTF-8")
                    } catch (e: Exception) {
                        it
                    }
                }
                val sessionName = backStackEntry.arguments?.getString("sessionName")?.let {
                    try {
                        java.net.URLDecoder.decode(it, "UTF-8")
                    } catch (e: Exception) {
                        it
                    }
                }
                ChatScreen(navController = navController, sessionId = sessionId, sessionName = sessionName)
            }
            composable(Screen.Sessions.route) {
                SessionsScreen(navController = navController)
            }
            composable("settings") {
                com.pimobile.app.ui.settings.SettingsScreen(navController = navController)
            }
        }
    }
}
