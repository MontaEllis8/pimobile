package com.pimobile.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavController
import androidx.activity.ComponentActivity
import com.pimobile.app.AppContainer
import com.pimobile.app.ui.chat.components.MessageBubble
import com.pimobile.app.ui.theme.LocalAppColors
import com.pimobile.app.ui.theme.ThemeState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import android.content.Intent
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    navController: NavController,
    sessionId: String? = null,
    sessionName: String? = null
) {
    val activity = LocalContext.current as ComponentActivity
    val viewModel: ChatViewModel = viewModel(viewModelStoreOwner = activity)
    val uiState by viewModel.uiState.collectAsState()
    val inputText by viewModel.inputText.collectAsState()
    val commands by viewModel.commands.collectAsState()
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var showModelBottomSheet by remember { mutableStateOf(false) }
    val colors = LocalAppColors.current

    LaunchedEffect(sessionId, sessionName) {
        // Set session name from navigation parameter; reset when switching sessions
        viewModel.setSessionDisplayName(sessionName ?: "")
    }

    // QA-04: generation indicator follows the streaming slot (lastStreamingMessage),
    // not the message list — the streaming bubble is rendered by combining the
    // formal list with the streaming slot, and isGenerating is source-of-truth.
    val isGenerating by viewModel.isGenerating.collectAsState()

    var isAutoScrollPaused by remember { mutableStateOf(false) }

    LaunchedEffect(listState.isScrollInProgress) {
        if (listState.isScrollInProgress) {
            val isAtBottom = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index == listState.layoutInfo.totalItemsCount - 1
            if (!isAtBottom) {
                isAutoScrollPaused = true
            } else {
                isAutoScrollPaused = false
            }
        }
    }

    LaunchedEffect(uiState.messages.size, isGenerating) {
        if (uiState.messages.isNotEmpty() && !isAutoScrollPaused) {
            // Wait for LazyColumn layout to complete before scrolling
            snapshotFlow { listState.layoutInfo.totalItemsCount }
                .first { it == uiState.messages.size }
            listState.animateScrollToItem(uiState.messages.size - 1)
        }
    }

    val snackbarHostState = remember { SnackbarHostState() }
    if (showModelBottomSheet) {
        val bottomSheetState = rememberModalBottomSheetState()
        val repoModels by viewModel.models.collectAsState()
        val currentThinkingLevel by viewModel.thinkingLevel.collectAsState()
        var optimisticLevel by remember { mutableStateOf(currentThinkingLevel) }
        LaunchedEffect(currentThinkingLevel) {
            optimisticLevel = currentThinkingLevel
        }

        ModalBottomSheet(
            onDismissRequest = { showModelBottomSheet = false },
            sheetState = bottomSheetState,
            containerColor = colors.surfaceColor
        ) {
            Column(modifier = Modifier.padding(16.dp).fillMaxWidth()) {
                // A. Thinking Budget (1.1: 6 levels + LazyRow + alias + optimistic)
                Text("Thinking Budget", style = MaterialTheme.typography.titleSmall, color = colors.primaryAccent)
                Spacer(modifier = Modifier.height(8.dp))
                LazyRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(listOf("off", "low", "medium", "high", "xhigh", "max")) { level ->
                        val isSelected = optimisticLevel.equals(level, ignoreCase = true) ||
                            (level == "medium" && optimisticLevel.equals("med", ignoreCase = true))
                        FilterChip(
                            selected = isSelected,
                            onClick = {
                                optimisticLevel = level
                                viewModel.setThinkingLevel(level)
                                coroutineScope.launch {
                                    snackbarHostState.showSnackbar("Thinking budget set to ${if (level == "medium") "MED" else level.uppercase()}")
                                }
                            },
                            label = { Text(if (level == "medium") "MED" else level.uppercase()) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = colors.primaryAccent.copy(alpha = 0.2f),
                                selectedLabelColor = colors.primaryAccent
                            )
                        )
                    }
                }

                HorizontalDivider(modifier = Modifier.padding(vertical = 16.dp), color = colors.outlineVariant)

                // B. Model List
                Text("Select Model", style = MaterialTheme.typography.titleSmall, color = colors.primaryAccent)
                Spacer(modifier = Modifier.height(8.dp))
                val models = repoModels.map { "${it.provider}/${it.id}" to "${it.name} (${it.context_window / 1000}k ctx)" }
                models.forEach { (modelId, label) ->
                    ListItem(
                        headlineContent = { Text(label, style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary) },
                        modifier = Modifier.clickable {
                            val parts = modelId.split("/")
                            val provider = parts.getOrElse(0) { "" }
                            val model = parts.getOrElse(1) { modelId }
                            viewModel.setModel(provider, model)
                            showModelBottomSheet = false
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent)
                    )
                }
            }
        }
    }

    LaunchedEffect(uiState.snackbarMessage) {
        uiState.snackbarMessage?.let { msg ->
            snackbarHostState.showSnackbar(msg)
            viewModel.clearSnackbar()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("CURRENT SESSION", style = MaterialTheme.typography.labelSmall, color = colors.textMuted)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(uiState.sessionName, style = MaterialTheme.typography.titleMedium)
                            Spacer(modifier = Modifier.width(6.dp))
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(
                                        when {
                                            uiState.isConnected -> colors.statusGreen
                                            uiState.isConnecting -> colors.statusYellow
                                            else -> MaterialTheme.colorScheme.error
                                        }
                                    )
                            )
                        }
                    }
                },
                actions = {
                    Surface(
                        color = colors.outlineColor,
                        shape = RoundedCornerShape(8.dp),
                        border = androidx.compose.foundation.BorderStroke(1.dp, colors.outlineVariant),
                        modifier = Modifier.clickable { showModelBottomSheet = true }
                    ) {
                        Row(modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                uiState.modelDisplay.ifEmpty { uiState.model.ifEmpty { "Model" } },
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.primaryAccent,
                                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace
                            )
                            Icon(
                                Icons.Default.KeyboardArrowDown,
                                contentDescription = "Change Model",
                                modifier = Modifier.size(16.dp).padding(start = 4.dp),
                                tint = colors.textSecondary
                            )
                        }
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    IconButton(onClick = { navController.navigate("settings") }) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings", tint = colors.textSecondary)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.surfaceColor)
            )
        },
        bottomBar = {
            Column(modifier = Modifier.background(MaterialTheme.colorScheme.background)) {
                // Status Bar — token usage only (thinking chip removed to avoid mis-tap)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        uiState.tokenUsage ?: "",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textSecondary
                    )
                }

                com.pimobile.app.ui.chat.components.CommandSuggestions(
                    query = inputText,
                    commands = commands,
                    onCommandSelected = { viewModel.setInputText(it + " ") }
                )

                // Input Bar
                val isDarkTheme by ThemeState.isDarkTheme.collectAsState()
                Surface(
                    color = if (isDarkTheme) colors.surfaceContainer else colors.surfaceColor,
                    shape = RoundedCornerShape(20.dp),
                    shadowElevation = if (isDarkTheme) 0.dp else 8.dp,
                    border = if (isDarkTheme) androidx.compose.foundation.BorderStroke(1.dp, colors.outlineVariant) else null,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 16.dp, bottom = 16.dp, top = 8.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(4.dp),
                        verticalAlignment = Alignment.Bottom
                    ) {
                        TextField(
                            value = inputText,
                            onValueChange = { viewModel.setInputText(it) },
                            modifier = Modifier
                                .weight(1f)
                                .padding(horizontal = 0.dp),
                            placeholder = { Text("Message Pi...", color = colors.textSecondary, style = MaterialTheme.typography.bodyLarge) },
                            colors = TextFieldDefaults.colors(
                                unfocusedContainerColor = Color.Transparent,
                                focusedContainerColor = Color.Transparent,
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                                unfocusedTextColor = colors.textPrimary,
                                focusedTextColor = colors.textPrimary
                            ),
                            maxLines = 5,
                            textStyle = MaterialTheme.typography.bodyLarge
                        )

                        IconButton(
                            onClick = {
                                if (isGenerating) {
                                    viewModel.abort()
                                } else {
                                    viewModel.sendMessage()
                                }
                            },
                            modifier = Modifier.padding(4.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(12.dp))
                        ) {
                            Icon(
                                if (isGenerating) Icons.Default.Stop else Icons.Default.Send,
                                contentDescription = if (isGenerating) "Stop" else "Send",
                                tint = colors.background
                            )
                        }
                    }
                }
            }
        }
    ) { innerPadding ->
        Box(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
            if (!uiState.isConnected) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.error)
                        .clickable { navController.navigate("settings") }
                        .padding(8.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text("未连接，点击设置", color = MaterialTheme.colorScheme.onError, style = MaterialTheme.typography.labelMedium)
                }
            }

            if (uiState.messages.isEmpty()) {
                Column(
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        "π",
                        style = MaterialTheme.typography.displayLarge,
                        color = colors.textSecondary.copy(alpha = 0.5f),
                        fontSize = 80.sp
                    )
                    Spacer(modifier = Modifier.height(24.dp))
                    Text(
                        "What would you like to build?",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textSecondary
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(top = if (!uiState.isConnected) 40.dp else 16.dp, start = 16.dp, end = 16.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // A1 K7 fix: streaming message id is now stable (PiRepository forces
                    // "streaming-<sessionKey>"), but keep this defensive so a future
                    // regression cannot churn the LazyColumn key every chunk.
                    items(uiState.messages, key = { if (it is com.pimobile.app.data.Message.Assistant && it.isStreaming) "streaming" else it.id }) { message ->
                        val ctx = LocalContext.current
                        MessageBubble(message = message, onDownloadFile = { fileId, filename ->
                            android.util.Log.d("ChatScreen", "onDownloadFile called: fileId=${fileId.take(30)}..., filename=$filename")
                            viewModel.downloadFile(fileId, filename) { downloadedFile ->
                                android.util.Log.d("ChatScreen", "openDownloadedFile: path=${downloadedFile.absolutePath}, size=${downloadedFile.length()}, ext=${downloadedFile.extension}")
                                openDownloadedFile(ctx, downloadedFile)
                            }
                        })
                    }
                }
            }

            AnimatedVisibility(
                visible = isAutoScrollPaused,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 16.dp)
            ) {
                SmallFloatingActionButton(
                    onClick = {
                        isAutoScrollPaused = false
                        coroutineScope.launch {
                            if (uiState.messages.isNotEmpty()) {
                                listState.animateScrollToItem(uiState.messages.size - 1)
                            }
                        }
                    },
                    containerColor = colors.surfaceContainer,
                    contentColor = colors.textSecondary,
                    shape = CircleShape
                ) {
                    Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Scroll to bottom")
                }
            }
        }
    }
}

/**
 * Open a downloaded file using the system app chooser.
 * Uses FileProvider for Android 7.0+ content:// URIs.
 */
private fun openDownloadedFile(context: android.content.Context, file: File) {
    try {
        val ext = file.extension.lowercase()
        val mimeType = when (ext) {
            "html", "htm" -> "text/html"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "pdf" -> "application/pdf"
            "txt" -> "text/plain"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
        }
        android.util.Log.d("ChatScreen", "openDownloadedFile: ext=$ext mime=$mimeType file=${file.absolutePath}")
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mimeType)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(intent, "Open with")
        context.startActivity(chooser)
    } catch (e: Exception) {
        android.util.Log.e("ChatScreen", "openDownloadedFile error: ${e.message}", e)
        Toast.makeText(context, "Cannot open file: ${e.message}", Toast.LENGTH_SHORT).show()
    }
}
