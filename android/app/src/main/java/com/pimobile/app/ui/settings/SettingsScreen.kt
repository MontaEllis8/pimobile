package com.pimobile.app.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.pimobile.app.AppContainer
import com.pimobile.app.ui.theme.LocalAppColors
import com.pimobile.app.ui.theme.ThemeState
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(navController: NavController) {
    val settingsDataStore = AppContainer.settingsDataStore
    val serverAddress by settingsDataStore.serverAddress.collectAsState(initial = "")
    val authToken by settingsDataStore.authToken.collectAsState(initial = "")
    val defaultCwd by settingsDataStore.defaultCwd.collectAsState(initial = "")
    val colors = LocalAppColors.current
    val isDarkTheme by ThemeState.isDarkTheme.collectAsState()
    val scope = rememberCoroutineScope()

    var editServerAddress by remember { mutableStateOf(serverAddress) }
    var editAuthToken by remember { mutableStateOf(authToken) }
    var editDefaultCwd by remember { mutableStateOf(defaultCwd) }
    var cwdDropdownExpanded by remember { mutableStateOf(false) }

    val projectPaths by AppContainer.repository.sessions
        .map { sessions -> sessions.map { it.project }.filter { it.isNotBlank() }.distinct().sorted() }
        .distinctUntilChanged()
        .collectAsState(initial = emptyList())

    LaunchedEffect(serverAddress) { editServerAddress = serverAddress }
    LaunchedEffect(authToken) { editAuthToken = authToken }
    LaunchedEffect(defaultCwd) { editDefaultCwd = defaultCwd }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings", fontWeight = FontWeight.Medium, color = colors.textPrimary) },
                navigationIcon = {
                    IconButton(onClick = { navController.popBackStack() }) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = colors.textPrimary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surfaceColor)
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState())
        ) {
            // 1. Appearance
            Text(
                "Appearance",
                style = MaterialTheme.typography.titleMedium,
                color = colors.primaryAccent,
                modifier = Modifier.padding(bottom = 16.dp)
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Dark Theme", style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
                Switch(
                    checked = isDarkTheme,
                    onCheckedChange = {
                        ThemeState.isDarkTheme.value = it
                        scope.launch { settingsDataStore.setDarkTheme(it) }
                    }
                )
            }

            Spacer(modifier = Modifier.height(28.dp))

            // 2. Connection
            Text(
                "Connection",
                style = MaterialTheme.typography.titleMedium,
                color = colors.primaryAccent,
                modifier = Modifier.padding(bottom = 16.dp)
            )
            OutlinedTextField(
                value = editServerAddress,
                onValueChange = { editServerAddress = it },
                label = { Text("Server Address (IP:Port)", color = colors.textSecondary) },
                placeholder = { Text("192.168.1.x:8787", color = colors.textSecondary.copy(alpha = 0.5f)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = colors.surfaceColor,
                    unfocusedContainerColor = colors.surfaceColor,
                    focusedTextColor = colors.textPrimary,
                    unfocusedTextColor = colors.textPrimary,
                )
            )
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                value = editAuthToken,
                onValueChange = { editAuthToken = it },
                label = { Text("Auth Token (Optional)", color = colors.textSecondary) },
                placeholder = { Text("Leave empty for LAN auto-connect", color = colors.textSecondary.copy(alpha = 0.5f)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = colors.surfaceColor,
                    unfocusedContainerColor = colors.surfaceColor,
                    focusedTextColor = colors.textPrimary,
                    unfocusedTextColor = colors.textPrimary,
                )
            )

            Spacer(modifier = Modifier.height(28.dp))

            // 3. Work Directory
            Text(
                "Work Directory",
                style = MaterialTheme.typography.titleMedium,
                color = colors.primaryAccent,
                modifier = Modifier.padding(bottom = 16.dp)
            )
            ExposedDropdownMenuBox(
                expanded = cwdDropdownExpanded,
                onExpandedChange = { cwdDropdownExpanded = it }
            ) {
                OutlinedTextField(
                    value = editDefaultCwd,
                    onValueChange = { editDefaultCwd = it },
                    label = { Text("Default Project Path (CWD)", color = colors.textSecondary) },
                    placeholder = { Text("D:\\worksave\\10-pi", color = colors.textSecondary.copy(alpha = 0.5f)) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(),
                    singleLine = true,
                    trailingIcon = {
                        Icon(Icons.Default.ArrowDropDown, "Select path", Modifier.clickable { cwdDropdownExpanded = !cwdDropdownExpanded })
                    },
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = colors.surfaceColor,
                        unfocusedContainerColor = colors.surfaceColor,
                        focusedTextColor = colors.textPrimary,
                        unfocusedTextColor = colors.textPrimary,
                    )
                )
                ExposedDropdownMenu(
                    expanded = cwdDropdownExpanded,
                    onDismissRequest = { cwdDropdownExpanded = false }
                ) {
                    if (projectPaths.isEmpty()) {
                        // P3-3: never render an empty popup — show a disabled hint instead.
                        DropdownMenuItem(
                            text = { Text("No sessions yet — type manually", fontSize = 13.sp, color = colors.textSecondary) },
                            onClick = { cwdDropdownExpanded = false },
                            enabled = false
                        )
                    } else {
                        projectPaths.forEach { path ->
                            DropdownMenuItem(
                                text = { Text(path, fontSize = 13.sp) },
                                onClick = {
                                    editDefaultCwd = path
                                    cwdDropdownExpanded = false
                                }
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(32.dp))

            Button(
                onClick = {
                    scope.launch {
                        settingsDataStore.setServerAddress(editServerAddress)
                        settingsDataStore.setAuthToken(editAuthToken)
                        settingsDataStore.setDefaultCwd(editDefaultCwd)
                    }
                    if (editServerAddress.isNotBlank()) {
                        AppContainer.repository.connect(editServerAddress, editAuthToken)
                    }
                    navController.popBackStack()
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Save & Connect")
            }
        }
    }
}
