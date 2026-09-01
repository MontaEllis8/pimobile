package com.pimobile.app.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.activity.ComponentActivity
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavController
import com.pimobile.app.data.SessionInfo
import com.pimobile.app.data.SessionStatus
import com.pimobile.app.ui.theme.LocalAppColors
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    navController: NavController
) {
    val activity = LocalContext.current as ComponentActivity
    val viewModel: SessionsViewModel = viewModel(viewModelStoreOwner = activity)
    val uiState by viewModel.uiState.collectAsState()
    val colors = LocalAppColors.current
    val listState = rememberLazyListState()
    var showSearch by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<SessionInfo?>(null) }
    var renameText by remember { mutableStateOf("") }

    // Restore scroll position from ViewModel once data is loaded
    LaunchedEffect(uiState.groupedSessions, uiState.pinnedSessions) {
        val target = uiState.scrollToIndex
        if (target > 0) {
            listState.scrollToItem(target)
        }
    }

    // Save current scroll position for next restore
    LaunchedEffect(listState.firstVisibleItemIndex) {
        viewModel.saveScrollPosition(listState.firstVisibleItemIndex)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sessions", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = { showSearch = !showSearch }) {
                        Icon(Icons.Default.Search, contentDescription = "Search", tint = colors.textPrimary)
                    }
                    IconButton(onClick = { viewModel.createSession("session-${System.currentTimeMillis()}") }) {
                        Icon(Icons.Default.Add, contentDescription = "New Session", tint = colors.textPrimary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surfaceColor)
            )
        }
    ) { innerPadding ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(bottom = 16.dp)
        ) {
            if (showSearch) {
                item {
                    OutlinedTextField(
                        value = uiState.searchInput,
                        onValueChange = { viewModel.setSearchInput(it) },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                        placeholder = { Text("Search sessions") },
                        singleLine = true,
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = colors.surfaceColor,
                            unfocusedContainerColor = colors.surfaceColor,
                            focusedTextColor = colors.textPrimary,
                            unfocusedTextColor = colors.textPrimary
                        )
                    )
                }
            }
            if (uiState.pinnedSessions.isNotEmpty()) {
                item {
                    SessionGroupHeader(title = "Pinned")
                }
                items(uiState.pinnedSessions, key = { it.id }) { session ->
                    SessionRow(session, onClick = {
                        // QS-09: 切会话传稳定 session_id
                        viewModel.switchToSession(session.name, session.id)
                        val encodedId = URLEncoder.encode(session.id, "UTF-8")
                        val encodedName = URLEncoder.encode(session.displayName.ifBlank { session.name }, "UTF-8")
                        navController.navigate("chat/$encodedId?name=$encodedName") {
                            popUpTo(0)
                        }
                    },
                    onRename = { renameTarget = session; renameText = session.name },
                    onDelete = { viewModel.deleteSession(session.name, session.id) },
                    onTogglePin = { viewModel.togglePin(session.id) })
                }
            }

            uiState.groupedSessions.forEach { group ->
                val expanded = group.path in uiState.expandedGroups
                item(key = "header-${group.path}") {
                    SessionGroupHeader(
                        title = group.path,
                        expanded = expanded,
                        onClick = { viewModel.toggleGroup(group.path) }
                    )
                }
                if (expanded) {
                    items(group.sessions, key = { it.id }) { session ->
                        SessionRow(session, onClick = {
                            // QS-09: 切会话传稳定 session_id
                            viewModel.switchToSession(session.name, session.id)
                            // AUDIT-W11: URL-encode the id like the pinned branch
                            // (a reserved char in the id would break NavHost parsing)
                            val encodedId = URLEncoder.encode(session.id, "UTF-8")
                            val encodedName = URLEncoder.encode(session.displayName.ifBlank { session.name }, "UTF-8")
                            navController.navigate("chat/$encodedId?name=$encodedName") {
                                popUpTo(0)
                            }
                        },
                        onRename = { renameTarget = session; renameText = session.name },
                        onDelete = { viewModel.deleteSession(session.name, session.id) },
                        onTogglePin = { viewModel.togglePin(session.id) })
                    }
                }
            }
        }
    }

    // Rename dialog
    renameTarget?.let { session ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("Rename Session") },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    singleLine = true,
                    label = { Text("Session name") }
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val newName = renameText.trim()
                    if (newName.isNotBlank() && newName != session.name) {
                        // QS-09: 重命名传稳定 session_id
                        viewModel.renameSession(session.name, newName, session.id)
                    }
                    renameTarget = null
                }) { Text("Rename") }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("Cancel") }
            }
        )
    }
}

@Composable
fun SessionGroupHeader(title: String, expanded: Boolean = true, onClick: () -> Unit = {}) {
    val colors = LocalAppColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.background)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = if (expanded) Icons.Default.KeyboardArrowDown else Icons.Default.KeyboardArrowRight,
                contentDescription = if (expanded) "Collapse" else "Expand",
                tint = colors.textSecondary,
                modifier = Modifier.size(18.dp)
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                text = title,
                style = MaterialTheme.typography.labelMedium,
                color = colors.textSecondary
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SessionRow(
    session: SessionInfo,
    onClick: () -> Unit,
    onRename: () -> Unit = {},
    onDelete: () -> Unit = {},
    onTogglePin: () -> Unit = {}
) {
    val isChild = session.parentId != null || session.parentSession != null
    val colors = LocalAppColors.current
    var showMenu by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onClick,
                onLongClick = { showMenu = true }
            )
            .padding(
                start = if (isChild) 32.dp else 16.dp,
                end = 16.dp,
                top = 10.dp,
                bottom = 10.dp
            ),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (isChild) {
            Text(
                text = "↳",
                style = MaterialTheme.typography.titleMedium,
                color = colors.primaryAccent,
                modifier = Modifier.padding(end = 8.dp)
            )
        }

        Column(modifier = Modifier.weight(1f)) {
            Text(
                session.displayName.ifBlank { session.name },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                color = colors.textPrimary
            )
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(
                            when(session.status) {
                                SessionStatus.ACTIVE -> colors.statusGreen
                                SessionStatus.BACKGROUND -> colors.statusYellow
                                SessionStatus.SLEEPING -> colors.textMuted
                                SessionStatus.COMPLETED -> colors.primaryAccent
                            }
                        )
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = "${session.status.name.lowercase().replaceFirstChar { it.titlecase() }} · ${session.messageCount} msgs",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textSecondary
                )
            }
            if (session.projectPath.isNotBlank()) {
                val timeStr = if (session.lastActiveTime > 0) {
                    SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(session.lastActiveTime))
                } else ""
                Text(
                    text = if (timeStr.isNotBlank()) "${session.projectPath} · $timeStr" else session.projectPath,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
        }

        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = { showMenu = false },
            offset = DpOffset(16.dp, 0.dp)
        ) {
            DropdownMenuItem(
                text = { Text("Rename") },
                leadingIcon = { Icon(Icons.Outlined.Edit, null) },
                onClick = { showMenu = false; onRename() }
            )
            DropdownMenuItem(
                text = { Text(if (session.isPinned) "Unpin" else "Pin") },
                leadingIcon = { Icon(Icons.Outlined.PushPin, null) },
                onClick = { showMenu = false; onTogglePin() }
            )
            DropdownMenuItem(
                text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
                onClick = { showMenu = false; onDelete() }
            )
        }
    }
}
