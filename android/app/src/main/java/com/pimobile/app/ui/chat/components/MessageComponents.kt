package com.pimobile.app.ui.chat.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import com.pimobile.app.data.*
import com.pimobile.app.ui.theme.*
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.window.Dialog
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter
import coil.request.ImageRequest
import com.pimobile.app.AppContainer
import java.io.File

@Composable
fun MessageBubble(message: Message, onDownloadFile: (id: String, filename: String) -> Unit = { _, _ -> }) {
    val colors = LocalAppColors.current
    val clipboardManager = LocalClipboardManager.current
    if (message is Message.User) {
        val timeStr = remember(message.timestamp) {
            SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(message.timestamp))
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Column(horizontalAlignment = Alignment.End) {
                Surface(
                    color = colors.userBubbleBg,
                    shape = RoundedCornerShape(20.dp, 20.dp, 4.dp, 20.dp),
                    border = BorderStroke(1.dp, colors.userBubbleBorder),
                    modifier = Modifier.widthIn(max = 300.dp)
                ) {
                    Box {
                        Text(
                            text = message.content,
                            modifier = Modifier.padding(16.dp).padding(bottom = 12.dp),
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.userBubbleText
                        )
                        Icon(
                            Icons.Outlined.ContentCopy,
                            contentDescription = "Copy",
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(8.dp)
                                .size(14.dp)
                                .clickable { clipboardManager.setText(AnnotatedString(message.content)) },
                            tint = colors.textSecondary
                        )
                    }
                }
                Text(
                    timeStr,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textMuted,
                    modifier = Modifier.padding(top = 4.dp, end = 4.dp)
                )
            }
        }
    } else if (message is Message.Assistant) {
        val timeStr = remember(message.timestamp) {
            SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(message.timestamp))
        }
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
            Column(modifier = Modifier.widthIn(max = 340.dp)) {
                // P2-9: while streaming, sections are intentionally empty (the
                // builder skips toSections() per chunk for O(n²) avoidance) — render
                // the flattened fields directly. At message_end the sections are
                // generated once and the non-streaming path below takes over.
                if (message.isStreaming && message.sections.isEmpty()) {
                    if (message.thinkingText.isNotEmpty()) {
                        ThinkingSection(AssistantSection.Thinking("", message.thinkingText))
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                    if (message.bodyText.isNotEmpty()) {
                        BodySection(AssistantSection.Body(listOf(MessagePart.Text(message.bodyText))))
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                    message.toolCall?.let { tc ->
                        val status = when (tc.status) {
                            "running" -> ToolStatus.RUNNING
                            "completed" -> ToolStatus.COMPLETED
                            "failed" -> ToolStatus.FAILED
                            else -> ToolStatus.RUNNING
                        }
                        ToolCallSection(
                            AssistantSection.ToolCall(tc.toolName, status, tc.input, tc.output)
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                    for (fl in message.fileLinks) {
                        FileLinkSection(
                            AssistantSection.FileLink(fl.id, fl.filename, fl.size, fl.contentType),
                            onDownloadFile
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                    message.error?.let { e ->
                        ErrorSection(AssistantSection.ErrorCard(e.message))
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                } else {
                    message.sections.forEach { section ->
                        when (section) {
                            is AssistantSection.Thinking -> ThinkingSection(section)
                            is AssistantSection.Body -> BodySection(section)
                            is AssistantSection.ToolCall -> ToolCallSection(section)
                            is AssistantSection.FileLink -> FileLinkSection(section, onDownloadFile)
                            is AssistantSection.ErrorCard -> ErrorSection(section)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                }
                Text(
                    timeStr,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textMuted,
                    modifier = Modifier.padding(top = 2.dp, start = 4.dp)
                )
                Icon(
                    Icons.Outlined.ContentCopy,
                    contentDescription = "Copy",
                    modifier = Modifier
                        .align(Alignment.End)
                        .padding(top = 4.dp, end = 4.dp)
                        .size(16.dp)
                        .clickable {
                            // P2-9: streaming messages have empty sections — copy
                            // the flattened body text in that case.
                            val text = if (message.sections.isNotEmpty()) {
                                message.sections.joinToString("\n") { section ->
                                    when (section) {
                                        is AssistantSection.Body -> section.parts.joinToString("") { part ->
                                            when (part) {
                                                is MessagePart.Text -> part.content
                                            }
                                        }
                                        else -> ""
                                    }
                                }
                            } else {
                                message.bodyText
                            }
                            clipboardManager.setText(AnnotatedString(text))
                        },
                    tint = colors.textSecondary
                )
            }
        }
    }
}

@Composable
fun ThinkingSection(section: AssistantSection.Thinking) {
    var expanded by remember { mutableStateOf(false) }
    val colors = LocalAppColors.current
    val clipboardManager = LocalClipboardManager.current
    
    Surface(
        color = colors.surfaceContainer,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.outlineVariant),
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "Thinking...", 
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textSecondary
                )
            }
            AnimatedVisibility(visible = expanded) {
                Text(
                    text = section.content,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = colors.textSecondary,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
        }
    }
}

@Composable
fun BodySection(section: AssistantSection.Body) {
    val colors = LocalAppColors.current
    Column {
        section.parts.forEach { part ->
            when (part) {
                is MessagePart.Text -> {
                    MarkdownView(
                        text = part.content,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }
        }
    }
}

@Composable
fun ToolCallSection(section: AssistantSection.ToolCall) {
    var expanded by remember { mutableStateOf(true) }
    val colors = LocalAppColors.current
    val isDark by ThemeState.isDarkTheme.collectAsState()
    
    val bgColors = if (isDark) colors.statusGreenBg else colors.surfaceColor
    val borderColors = if (isDark) colors.statusGreenBorder else colors.outlineVariant

    Surface(
        color = bgColors,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, borderColors),
        modifier = Modifier
            .fillMaxWidth()
            // P2-4: expandable when there is either input args or tool output
            .clickable(enabled = section.details != null || section.output.isNotBlank()) { expanded = !expanded }
            .drawWithContent {
                drawContent()
                if (!isDark) {
                    drawRect(
                        color = colors.statusGreen,
                        topLeft = androidx.compose.ui.geometry.Offset.Zero,
                        size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height)
                    )
                }
            }
            .clip(RoundedCornerShape(12.dp))
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .background(colors.statusGreenIconBg, RoundedCornerShape(8.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        when (section.status) {
                            ToolStatus.COMPLETED -> Icons.Outlined.Check
                            ToolStatus.RUNNING -> Icons.Outlined.Refresh
                            ToolStatus.FAILED -> Icons.Default.Warning
                        },
                        contentDescription = null,
                        tint = when(section.status) {
                            ToolStatus.COMPLETED -> colors.statusGreenIcon
                            ToolStatus.RUNNING -> MaterialTheme.colorScheme.primary
                            ToolStatus.FAILED -> MaterialTheme.colorScheme.error
                        },
                        modifier = Modifier.size(16.dp)
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Column {
                    Text(
                        text = section.name,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.textPrimary,
                        maxLines = 1
                    )
                    Text(
                        text = when (section.status) {
                            ToolStatus.COMPLETED -> "Completed successfully"
                            ToolStatus.RUNNING -> "Running..."
                            ToolStatus.FAILED -> "Failed"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textSecondary
                    )
                }
            }
            AnimatedVisibility(visible = expanded && (section.details != null || section.output.isNotBlank())) {
                Column(modifier = Modifier.padding(top = 8.dp)) {
                    if (section.details != null) {
                        Text(
                            "INPUT",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textSecondary
                        )
                        Text(
                            text = section.details,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                            color = colors.textSecondary,
                            modifier = Modifier.padding(top = 2.dp)
                        )
                    }
                    // P2-4: show the tool result output (with base64 image guard + preview)
                    if (section.output.isNotBlank()) {
                        Text(
                            "OUTPUT",
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.textSecondary,
                            modifier = Modifier.padding(top = 8.dp)
                        )
                        val isBase64Image = section.output.length > 2000 &&
                            (section.output.contains("/9j/") ||
                                section.output.contains("base64,") ||
                                section.output.contains("iVBORw0KGgo") ||
                                (section.output.length > 10000 && section.output.filter { !it.isWhitespace() }.take(2000).all { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' }))
                        if (isBase64Image) {
                            var showDialog by remember { mutableStateOf(false) }
                            val kb = section.output.length / 1024
                            val dataUri = remember(section.output) {
                                val raw = section.output.trim()
                                when {
                                    raw.contains("data:image") -> raw.substring(raw.indexOf("data:image"))
                                    raw.contains("/9j/") -> {
                                        val b64 = raw.substring(raw.indexOf("/9j/")).filter { !it.isWhitespace() }
                                        "data:image/jpeg;base64," + b64
                                    }
                                    raw.contains("iVBORw0KGgo") -> {
                                        val b64 = raw.substring(raw.indexOf("iVBORw0KGgo")).filter { !it.isWhitespace() }
                                        "data:image/png;base64," + b64
                                    }
                                    raw.contains("base64,") -> "data:image/jpeg;base64," + raw.substringAfter("base64,").filter { !it.isWhitespace() }
                                    else -> "data:image/jpeg;base64," + raw.filter { !it.isWhitespace() }
                                }
                            }
                            Column(modifier = Modifier.padding(top = 2.dp).clickable { showDialog = true }) {
                                Text(
                                    text = "[图片输出 ${kb}KB，点击预览]",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    color = colors.primaryAccent,
                                    textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline
                                )
                                Spacer(modifier = Modifier.height(6.dp))
                                AsyncImage(
                                    model = ImageRequest.Builder(LocalContext.current).data(dataUri).crossfade(true).build(),
                                    contentDescription = "tool image",
                                    modifier = Modifier.fillMaxWidth().heightIn(max = 180.dp).clip(RoundedCornerShape(8.dp)),
                                    contentScale = ContentScale.Crop
                                )
                            }
                            if (showDialog) {
                                Dialog(onDismissRequest = { showDialog = false }) {
                                    Box(modifier = Modifier.fillMaxWidth().wrapContentHeight().background(colors.surfaceColor, RoundedCornerShape(12.dp)).padding(8.dp)) {
                                        AsyncImage(model = dataUri, contentDescription = "preview", modifier = Modifier.fillMaxWidth().wrapContentHeight(), contentScale = ContentScale.Fit)
                                    }
                                }
                            }
                        } else {
                            Text(
                                text = section.output,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.sp,
                                color = colors.textPrimary,
                                modifier = Modifier.padding(top = 2.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun FileLinkSection(section: AssistantSection.FileLink, onDownload: (id: String, filename: String) -> Unit = { _, _ -> }) {
    val colors = LocalAppColors.current
    val isImage = section.contentType?.startsWith("image/") == true
    val emoji = when {
        section.contentType?.startsWith("text/html") == true -> "🌐"
        isImage -> "🖼️"
        section.contentType?.startsWith("text/") == true -> "📄"
        section.contentType?.startsWith("application/pdf") == true -> "📑"
        else -> "📦"
    }
    if (isImage) {
        val context = LocalContext.current
        // 优先用本地已下载缓存，命中则秒开；未命中则用远程 http url 让 Coil 直连下载缩略图
        val cachedFile = remember(section.id, section.filename) {
            findCachedImageFile(context, section.filename)
        }
        val baseUrl = remember {
            try { AppContainer.repository.getBaseUrl() } catch (_: Exception) { "" }
        }
        val imageModel: Any? = when {
            cachedFile != null && cachedFile.exists() -> cachedFile
            baseUrl.isNotBlank() -> "$baseUrl/files/${section.id}"
            else -> null
        }
        Surface(
            color = colors.outlineColor,
            shape = RoundedCornerShape(8.dp),
            border = BorderStroke(1.dp, colors.outlineVariant),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(8.dp)) {
                if (imageModel != null) {
                    // L0 fix — Coil thumbnail for non-image / broken content must show error placeholder instead of blank
                    var imageError by remember(section.id) { mutableStateOf(false) }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(180.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable { onDownload(section.id, section.filename) }
                    ) {
                        AsyncImage(
                            model = ImageRequest.Builder(context)
                                .data(imageModel)
                                .crossfade(true)
                                .build(),
                            contentDescription = section.filename,
                            modifier = Modifier.fillMaxSize(),
                            contentScale = ContentScale.Crop,
                            onState = { state ->
                                if (state is AsyncImagePainter.State.Error) imageError = true
                                if (state is AsyncImagePainter.State.Success) imageError = false
                            },
                            // placeholder/fallback keep blank; error is handled by overlay below
                        )
                        if (imageError) {
                            Box(
                                modifier = Modifier
                                    .fillMaxSize()
                                    .background(colors.surfaceContainer),
                                contentAlignment = Alignment.Center
                            ) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Icon(
                                        androidx.compose.material.icons.Icons.Filled.Warning,
                                        contentDescription = "load failed",
                                        tint = MaterialTheme.colorScheme.error,
                                        modifier = Modifier.size(28.dp)
                                    )
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text(
                                        "图片加载失败，点 OPEN 重试",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = colors.textSecondary
                                    )
                                }
                            }
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onDownload(section.id, section.filename) }
                        .padding(horizontal = 4.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("$emoji ${section.filename}", style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary)
                        Text(section.size, style = MaterialTheme.typography.labelSmall, color = colors.textSecondary)
                    }
                    Text("OPEN ↗", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    } else {
        Surface(
            color = colors.outlineColor,
            shape = RoundedCornerShape(8.dp),
            border = BorderStroke(1.dp, colors.outlineVariant),
            modifier = Modifier.fillMaxWidth().clickable { onDownload(section.id, section.filename) }
        ) {
            Row(
                modifier = Modifier.padding(12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("$emoji ${section.filename}", style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary)
                    Text(section.size, style = MaterialTheme.typography.labelSmall, color = colors.textSecondary)
                }
                Text("OPEN ↗", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

/** B6: 查找本地已缓存的图片文件（命中则 Coil 直接加载本地文件，无需再走网络） */
private fun findCachedImageFile(context: android.content.Context, filename: String): File? {
    if (filename.isBlank()) return null
    val safeName = filename.ifBlank { "download" }
        .replace(Regex("""[<>:\"/\\\\|?*]"""), "_")
        .replace(Regex("""\.\.+"""), "_")
        .trimStart('.', '/')
        .ifBlank { "download" }
    val roots = listOfNotNull(context.externalCacheDir, context.cacheDir)
    for (root in roots) {
        val piFiles = File(root, "pi-files")
        if (!piFiles.exists()) continue
        // 扫描所有 session 子目录下同名文件，取最新一个
        val candidates = piFiles.walkTopDown().filter { it.isFile && it.name == safeName }.toList()
        if (candidates.isNotEmpty()) {
            return candidates.maxByOrNull { it.lastModified() }
        }
    }
    return null
}

@Composable
fun ErrorSection(section: AssistantSection.ErrorCard) {
    val colors = LocalAppColors.current
    val isDark by ThemeState.isDarkTheme.collectAsState()
    val errorColor = MaterialTheme.colorScheme.error

    val bgColors = if (isDark) errorColor.copy(alpha = 0.1f) else colors.surfaceColor
    val borderColors = if (isDark) errorColor.copy(alpha = 0.3f) else colors.outlineVariant

    Surface(
        color = bgColors,
        border = BorderStroke(1.dp, borderColors),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .drawWithContent {
                drawContent()
                if (!isDark) {
                    drawRect(
                        color = errorColor,
                        topLeft = androidx.compose.ui.geometry.Offset.Zero,
                        size = androidx.compose.ui.geometry.Size(4.dp.toPx(), size.height)
                    )
                }
            }
            .clip(RoundedCornerShape(8.dp))
    ) {
        Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            Icon(Icons.Default.Warning, contentDescription = "Error", tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text(section.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
