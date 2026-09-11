package com.pimobile.app.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import com.pimobile.app.AppContainer
import com.pimobile.app.data.MdnsDiscovery
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

    val context = LocalContext.current
    val clipboardManager = LocalClipboardManager.current
    val mdns = remember { MdnsDiscovery(context) }
    val discoveredServices by mdns.services.collectAsState()
    val isDiscovering by mdns.isDiscovering.collectAsState()
    var hasSearched by remember { mutableStateOf(false) }
    LaunchedEffect(isDiscovering) { if (isDiscovering) hasSearched = true }
    DisposableEffect(Unit) { onDispose { mdns.stopDiscovery() } }

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
            // mDNS 局域网发现
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("局域网发现", style = MaterialTheme.typography.titleSmall, color = colors.primaryAccent)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (isDiscovering) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    }
                    IconButton(onClick = { mdns.startDiscovery() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "搜索", tint = colors.textPrimary)
                    }
                }
            }
            if (isDiscovering && discoveredServices.isEmpty()) {
                Text("搜索中...", style = MaterialTheme.typography.bodySmall, color = colors.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
            }
            if (discoveredServices.isNotEmpty()) {
                Column(modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    discoveredServices.forEach { service ->
                        Surface(
                            color = colors.surfaceColor,
                            shape = MaterialTheme.shapes.small,
                            tonalElevation = 1.dp,
                            modifier = Modifier.fillMaxWidth().clickable {
                                editServerAddress = "${service.host}:${service.port}"
                                Toast.makeText(context, "已填入 ${service.host}:${service.port}", Toast.LENGTH_SHORT).show()
                            }
                        ) {
                            Text(
                                "${service.name} (${service.host}:${service.port})",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.textPrimary,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)
                            )
                        }
                    }
                }
            }
            if (!isDiscovering && hasSearched && discoveredServices.isEmpty()) {
                Text("未发现，确认同WiFi/PC已启动", style = MaterialTheme.typography.bodySmall, color = colors.textSecondary, modifier = Modifier.padding(bottom = 8.dp))
            }
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
                trailingIcon = {
                    IconButton(onClick = {
                        val newToken = java.util.UUID.randomUUID().toString().replace("-", "") + java.util.UUID.randomUUID().toString().substring(0, 8)
                        editAuthToken = newToken
                        clipboardManager.setText(AnnotatedString(newToken))
                        Toast.makeText(context, "已生成并复制", Toast.LENGTH_SHORT).show()
                    }) {
                        Icon(Icons.Filled.AutoAwesome, contentDescription = "生成随机Token", tint = colors.primaryAccent)
                    }
                },
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = colors.surfaceColor,
                    unfocusedContainerColor = colors.surfaceColor,
                    focusedTextColor = colors.textPrimary,
                    unfocusedTextColor = colors.textPrimary,
                )
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "PC端: \$env:AUTH_TOKEN=\"xxx\"; 重启 server",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textMuted,
                    modifier = Modifier.weight(1f)
                )
                if (editAuthToken.isNotBlank()) {
                    TextButton(onClick = {
                        clipboardManager.setText(AnnotatedString(editAuthToken))
                        Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                    }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = "复制", modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("复制", fontSize = 12.sp)
                    }
                }
            }

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
