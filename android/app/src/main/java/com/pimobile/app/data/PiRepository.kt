package com.pimobile.app.data

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import android.content.Context
import java.util.concurrent.TimeUnit

/**
 * PiRepository - the single source of truth for all Pi-related data.
 * Holds the WebSocket client and transforms raw ServerMessage streams into
 * UI-friendly state flows.
 */
class PiRepository(private val appContext: Context) {
    val webSocketClient = PiWebSocketClient()

    /** HTTP client for file downloads (OkHttp) */
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** Constructed after connect: http://host:port */
    private var baseUrl: String = ""

    // ── Messages ──
    /** Current active session's messages (ui-model) as a StateFlow */
    private val _messages = MutableStateFlow<List<Message>>(emptyList())
    val messages: StateFlow<List<Message>> = _messages.asStateFlow()

    /** In-flight streaming Assistant message (QA-04).
     *  Every text/thinking/tool chunk writes ONLY this slot — no full-list copy
     *  per chunk (previously pushStreamingUpdate did `_messages.update { dropLast(1) + msg }`,
     *  O(n) list copy per chunk → long replies + long histories lagged). Merged
     *  into _messages once at message_end, then cleared. */
    private val _lastStreamingMessage = MutableStateFlow<Message.Assistant?>(null)
    val lastStreamingMessage: StateFlow<Message.Assistant?> = _lastStreamingMessage.asStateFlow()

    /** Active session name */
    private val _activeSessionName = MutableStateFlow("")
    val activeSessionName: StateFlow<String> = _activeSessionName.asStateFlow()

    /** Active session UUID (stable, unlike display name which can duplicate) */
    private val _activeSessionId = MutableStateFlow("")
    val activeSessionId: StateFlow<String> = _activeSessionId.asStateFlow()

    // ── Sessions ──
    private val _sessions = MutableStateFlow<List<SessionData>>(emptyList())
    val sessions: StateFlow<List<SessionData>> = _sessions.asStateFlow()

    // ── Connection ──
    val connectionState: StateFlow<ConnectionState> = webSocketClient.connectionState

    // ── Token usage ──
    private val _tokenUsage = MutableStateFlow(TokenUsage())
    val tokenUsage: StateFlow<TokenUsage> = _tokenUsage.asStateFlow()

    // ── Models ──
    private val _models = MutableStateFlow<List<ModelData>>(emptyList())
    val models: StateFlow<List<ModelData>> = _models.asStateFlow()

    // ── Thinking level ──
    private val _thinkingLevel = MutableStateFlow("off")
    val thinkingLevel: StateFlow<String> = _thinkingLevel.asStateFlow()

    // ── Available slash commands ──
    private val _commands = MutableStateFlow<List<CommandInfo>>(emptyList())
    val commands: StateFlow<List<CommandInfo>> = _commands.asStateFlow()

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val uiMessageDispatchers = mutableMapOf<String, Message.Assistant.Builder>()
    private val pushLock = Any()
    private var collectJob: Job? = null
    private var commandsJob: Job? = null
    private var reconnectJob: Job? = null

    companion object {
        private const val TAG = "PiRepository"
    }

    /**
     * Connect to the Pi server and start processing messages.
     * Cancels any previous collect coroutine to avoid duplicate processing.
     */
    fun connect(address: String, token: String) {
        // Save base URL for HTTP file downloads
        baseUrl = if (address.startsWith("ws://")) {
            "http://${address.removePrefix("ws://").split("/ws").first()}"
        } else if (address.startsWith("wss://")) {
            "https://${address.removePrefix("wss://").split("/ws").first()}"
        } else {
            "http://${address}"
        }

        webSocketClient.connect(address, token)

        // P0-7 fix: cancel previous collectors to prevent duplicate processing on re-connect
        collectJob?.cancel()
        commandsJob?.cancel()
        reconnectJob?.cancel()
        collectJob = scope.launch {
            webSocketClient.messages.collect { msg ->
                processMessage(msg)
            }
        }

        // Request available slash commands from server.
        // P2-5: wait for the WebSocket to actually reach CONNECTED instead of
        // a fixed 500ms delay — on a slow network the socket may not be open
        // yet (send silently fails → command list stays empty forever), and
        // on a fast network 500ms is wasted latency. Bounded by withTimeoutOrNull
        // so a connect that never completes doesn't hang the request forever.
        commandsJob = scope.launch {
            val connected = withTimeoutOrNull(10_000L) {
                webSocketClient.connectionState.first { it == ConnectionState.CONNECTED }
            }
            if (connected == null) {
                Log.w(TAG, "connect: timed out waiting for CONNECTED, commands not requested")
            } else {
                webSocketClient.send(GetCommandsMessage())
                // SDK upgrade (BREAKING-CHANGES step 6): get_models is
                // request/response — the server never pushes model_list, so
                // without this the model picker bottom sheet stays empty.
                requestModels()
            }
        }

        // Reconnect (AUDIT-W1 self-heal): restore the session we were viewing
        // before the drop. The server restores its own "current" from disk on
        // restart, which may be a different conversation (e.g. a desktop pi
        // terminal session) — blindly following it would yank the user's chat
        // to an unrelated conversation. First connect (cold start) keeps the
        // legacy behavior (follow server current); only reconnects restore.
        var firstConnect = true
        reconnectJob = scope.launch {
            webSocketClient.connectionState.collect { state ->
                if (state == ConnectionState.CONNECTED) {
                    if (!firstConnect) {
                        val sid = _activeSessionId.value
                        val sname = _activeSessionName.value
                        if (sid.isNotBlank() || sname.isNotBlank()) {
                            Log.d(TAG, "reconnect: restoring session sid=$sid name=$sname")
                            webSocketClient.send(SwitchSessionMessage(sname, sid))
                        }
                    }
                    firstConnect = false
                }
            }
        }
    }

    fun disconnect() {
        collectJob?.cancel()
        collectJob = null
        commandsJob?.cancel()
        commandsJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        webSocketClient.disconnect()
    }

    // ── Actions ──

    /**
     * Send a user message. Returns whether the frame was accepted by the socket.
     * (QA-08) The local user bubble is only added on success — a failed send
     * during a reconnect gap already surfaces an ErrorMessage (P2-2); adding
     * the bubble anyway would claim a message that never left the device.
     */
    fun sendMessage(text: String): Boolean {
        val ok = webSocketClient.send(UserMessage(text))
        if (ok) {
            // Add user message locally
            val userMsg = Message.User(text, System.currentTimeMillis())
            _messages.update { it + userMsg }
        }
        return ok
    }

    fun abort() {
        webSocketClient.send(AbortMessage())
    }

    fun switchSession(name: String, sessionId: String? = null) {
        webSocketClient.send(SwitchSessionMessage(name, sessionId))
        // QS-09: 立即写入目标稳定 id（不等 session_switched 回包）——彻底消除
        // "id 从空到有"的窗口：此前 builder key 经历 name → (session_list) → id
        // 跳变，切会话首条流式 chunk 会散落到双 builder。有 id 直接绑定；无 id
        // 清空走旧路径（等 session_list/session_switched 补全）。
        // Clear stale in-flight builders so arriving text_chunks don't key off the
        // OLD session's id (which would orphan chunks into a dead builder and leave
        // the new session's first Assistant bubble empty). (P1-3 + QA-03 fix.)
        // Held under pushLock for consistency with the other _messages writers.
        synchronized(pushLock) {
            _messages.value = emptyList()
            _activeSessionName.value = name
            _activeSessionId.value = sessionId ?: ""
            // QA-04: clear the streaming slot too — a stale streaming bubble
            // from the old session must not leak into the new one.
            _lastStreamingMessage.value = null
            uiMessageDispatchers.clear()
        }
    }

    fun createSession(name: String, cwd: String? = null) {
        webSocketClient.send(NewSessionMessage(name, cwd))
    }

    fun deleteSession(name: String, sessionId: String? = null) {
        webSocketClient.send(DeleteSessionMessage(name, sessionId))
    }

    fun renameSession(oldName: String, newName: String, sessionId: String? = null) {
        webSocketClient.send(RenameSessionMessage(oldName, newName, sessionId))
    }

    fun setModel(provider: String, model: String) {
        webSocketClient.send(SetModelMessage(provider, model))
    }

    fun requestSessions() {
        webSocketClient.send(GetSessionsMessage())
    }

    fun requestModels() {
        webSocketClient.send(GetModelsMessage())
    }

    fun compact() {
        webSocketClient.send(CompactMessage())
    }

    /**
     * Cycle the server-side thinking level by one step.
     * Reserved for keyboard shortcuts / external triggers — the main UI path
     * is [setThinkingLevel] driven by the top-bar drawer.
     */
    fun cycleThinking() {
        webSocketClient.send(CycleThinkingMessage())
    }

    fun downloadFile(id: String, filename: String = "download", onDownloaded: (File) -> Unit = {}) {
        scope.launch(Dispatchers.IO) {
            try {
                val url = "$baseUrl/files/$id"
                Log.d(TAG, "downloadFile: GET $url (filename=$filename, idLen=${id.length}, idPrefix=${id.take(20)})")
                val request = Request.Builder().url(url).build()
                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    val msg = "Download failed: HTTP ${response.code} for $filename"
                    Log.e(TAG, msg)
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }
                val body = response.body ?: run {
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(appContext, "Download: empty body for $filename", android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }
                // Save to app external cache dir (clearable in system Settings)
                // Scoped by session ID to prevent filename collisions across sessions
                val sessionId = _activeSessionId.value.ifBlank { "default" }
                val safeSessionId = sessionId.replace(Regex("""[<>:"/\\|?*]"""), "_")
                val cacheDir = File(appContext.externalCacheDir ?: appContext.cacheDir, "pi-files/$safeSessionId")
                cacheDir.mkdirs()
                val safeName = run {
                    // P2-1: sanitize the server-supplied filename the same way
                    // safeSessionId is sanitized. A malicious/buggy name with path
                    // separators or `..` would let File(cacheDir, safeName) resolve
                    // OUTSIDE the cache dir (path traversal). Also collapse `..`
                    // runs and strip leading dots/slashes, then verify the
                    // canonical path stays under cacheDir as defense-in-depth.
                    val raw = filename.ifBlank { "download" }
                    raw.replace(Regex("""[<>:"/\\|?*]"""), "_")
                        .replace(Regex("""\.\.+"""), "_")
                        .trimStart('.', '/')
                        .ifBlank { "download" }
                }
                val outFile = File(cacheDir, safeName)
                // Defense-in-depth: reject any path that escapes cacheDir after sanitization.
                if (!outFile.canonicalPath.startsWith(cacheDir.canonicalPath)) {
                    val msg = "Download rejected: filename escapes cache dir ($filename)"
                    Log.e(TAG, msg)
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }
                // Delete existing file first to avoid EACCES on locked/half-written files
                if (outFile.exists()) outFile.delete()
                outFile.outputStream().use { output ->
                    body.byteStream().use { input -> input.copyTo(output) }
                }
                Log.d(TAG, "downloadFile saved: ${outFile.absolutePath} (${outFile.length()} bytes)")
                withContext(Dispatchers.Main) {
                    onDownloaded(outFile)
                }
            } catch (e: Exception) {
                val msg = "Download error: ${e.message}"
                Log.e(TAG, msg)
                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    fun setThinkingLevel(level: String) {
        webSocketClient.send(UserMessage("/think $level"))
    }

    // ── Message processing ──

    private fun processMessage(msg: ServerMessage) {
        when (msg) {
            is TextChunk -> appendText(msg.text)
            is ThinkingChunk -> appendThinking(msg.text)
            is ToolStartMessage -> onToolStart(msg)
            is ToolOutputMessage -> onToolOutput(msg)
            is MessageEnd -> onMessageEnd()
            is StateUpdate -> onStateUpdate(msg)
            is SessionList -> onSessionList(msg)
            is SessionSwitched -> onSessionSwitched(msg)
            is ErrorMessage -> onError(msg)
            is ModelListMessage -> onModelList(msg)
            is MessageHistory -> onHistory(msg)
            is FileAvailableMessage -> onFileAvailable(msg)
            is CommandListMessage -> _commands.value = msg.commands
            is UnknownMessage -> {} // P3-7: unknown server messages are ignored
            else -> {} // Unknown messages ignored
        }
    }

    private fun appendText(text: String) {
        synchronized(pushLock) {
            val current = getCurrentBuilder().bodyText
            // Pi SDK sometimes sends full accumulated text instead of delta.
            // QA-09: treat as full accumulation ONLY when the new text strictly
            // extends the current one (longer AND startsWith it AND not equal).
            // Equal-but-different content (rare SDK quirk) is appended instead
            // of replacing, shrinking the false-positive window.
            getCurrentBuilder().bodyText =
                if (text.length > current.length && text.startsWith(current)) text
                else current + text
            Log.d(TAG, "appendText: len=${text.length}, bodyText.len=${getCurrentBuilder().bodyText.length}")
        }
        pushStreamingUpdate()
    }

    private fun appendThinking(text: String) {
        synchronized(pushLock) {
            val current = getCurrentBuilder().thinkingText
            getCurrentBuilder().thinkingText = if (text.startsWith(current)) text else current + text
        }
        pushStreamingUpdate()
    }

    private fun onToolStart(msg: ToolStartMessage) {
        synchronized(pushLock) {
            val toolSection = Message.Assistant.ToolCallData(
                toolId = msg.tool_id,
                toolName = msg.tool_name,
                input = msg.input,
                status = "running",
                output = ""
            )
            getCurrentBuilder().toolCall = toolSection
        }
        pushStreamingUpdate()
    }

    private fun onToolOutput(msg: ToolOutputMessage) {
        synchronized(pushLock) {
            val current = getCurrentBuilder()
            val tool = current.toolCall
            if (tool != null && tool.toolId == msg.tool_id) {
                val existingOutput = tool.output
                val newOutput = if (msg.output.startsWith(existingOutput)) msg.output else existingOutput + msg.output
                current.toolCall = tool.copy(
                    output = newOutput,
                    status = msg.status
                )
            }
        }
        pushStreamingUpdate()
    }

    private fun onMessageEnd() {
        synchronized(pushLock) {
            val builder = getCurrentBuilder()
            val built = builder.build()
            Log.d(TAG, "onMessageEnd: built.bodyText.len=${built.bodyText.length}, sections=${built.sections.size}")
            val msg = built.copy(isStreaming = false)
            // QA-04: merge the streaming slot into the formal list once. If the
            // list still ends with a non-streaming Assistant (e.g. an error was
            // merged), replace it (dropLast) — otherwise append.
            _messages.update { current ->
                if (current.isNotEmpty() && current.last() is Message.Assistant) {
                    current.dropLast(1) + msg
                } else {
                    current + msg
                }
            }
            // Clear the streaming slot — the UI now renders from _messages alone.
            _lastStreamingMessage.value = null
            // Reset builder for the next assistant message
            val key = activeBuilderKey()
            uiMessageDispatchers.remove(key)
        }
    }

    /**
     * Push the current builder state to the UI as a streaming Assistant message.
     * QA-04: writes ONLY _lastStreamingMessage (single value, no list copy).
     * The UI combines it with _messages for rendering. message_end merges it.
     */
    private fun pushStreamingUpdate() {
        val msg: Message.Assistant
        synchronized(pushLock) {
            // P2-9: streaming build — no toSections() expansion per chunk (O(n²)
            // bodyText copies on long replies). UI renders flattened fields while
            // isStreaming; sections are generated once at message_end.
            val built = getCurrentBuilder().build(streaming = true)
            if (built.isEmpty()) return
            msg = built
        }
        _lastStreamingMessage.value = msg
    }

    private fun onStateUpdate(msg: StateUpdate) {
        _tokenUsage.value = TokenUsage(
            input = msg.cost.input,
            output = msg.cost.output,
            total = msg.cost.total,
            contextWindow = msg.context_window,
            messageCount = msg.message_count,
            contextUsage = msg.context_usage
        )
        _thinkingLevel.value = msg.thinking_level
    }

    private fun onSessionList(msg: SessionList) {
        _sessions.value = msg.sessions
        // Track the active session's stable UUID for builder keying
        val cur = msg.sessions.find { it.current == true }
        if (cur != null) {
            if (cur.session_id.isNotBlank()) _activeSessionId.value = cur.session_id
            if (cur.name.isNotBlank()) _activeSessionName.value = cur.name
        }
    }

    private fun onSessionSwitched(msg: SessionSwitched) {
        // 新建会话（new_session）路径：server 只回 session_switched 不推空 message_history，
        // 必须在此清空旧会话的消息/流式槽/builder，否则 UI 残留上一会话内容。
        // 手动切换（switchSession）路径已提前清空，这里再清幂等无害；有内容的
        // message_history 随后到达并整体替换。
        synchronized(pushLock) {
            _messages.value = emptyList()
            _lastStreamingMessage.value = null
            uiMessageDispatchers.clear()
        }
        _activeSessionName.value = msg.name.ifEmpty { _activeSessionName.value }
        // QS-09: 服务端回包带稳定 id 时直接写入（switchSession 已提前写入，
        // 这里兜底覆盖——尤其旧服务端不回 id 时维持原行为）
        if (!msg.session_id.isNullOrBlank()) {
            _activeSessionId.value = msg.session_id
        }
        webSocketClient.send(GetSessionsMessage())
    }

    private fun onError(msg: ErrorMessage) {
        val errorSection = Message.Assistant.ErrorData(msg.message)
        synchronized(pushLock) {
            // QA-13: if a message is streaming, merge the error into the
            // streaming slot and finalize it. Otherwise a later pushStreamingUpdate
            // (chunks still in flight) would rebuild the bubble WITHOUT the error
            // — the error card gets swallowed.
            val streaming = _lastStreamingMessage.value
            if (streaming != null) {
                val errored = streaming.copy(error = errorSection, isStreaming = false)
                _messages.update { current ->
                    if (current.isNotEmpty() && current.last() is Message.Assistant) {
                        current.dropLast(1) + errored
                    } else {
                        current + errored
                    }
                }
                _lastStreamingMessage.value = null
                uiMessageDispatchers.remove(activeBuilderKey())
                return
            }
        }
        _messages.update { current ->
            if (current.isNotEmpty() && current.last() is Message.Assistant) {
                val last = current.last() as Message.Assistant
                current.dropLast(1) + last.copy(error = errorSection)
            } else {
                current + Message.Assistant(
                    error = errorSection,
                    timestamp = System.currentTimeMillis()
                )
            }
        }
    }

    private fun onModelList(msg: ModelListMessage) {
        _models.value = msg.models
    }

    private fun onHistory(msg: MessageHistory) {
        val historyMsgs = msg.messages.mapNotNull { entry ->
            when (entry) {
                is Map<*, *> -> {
                    val role = entry["role"]?.toString() ?: ""
                    val text = entry["text"]?.toString() ?: ""
                    val thinking = entry["thinking"]?.toString() ?: ""
                    // Real message time from server (epoch ms); fall back to now if absent
                    // (e.g. compaction summary has no persisted timestamp).
                    val ts = (entry["timestamp"] as? Number)?.toLong() ?: System.currentTimeMillis()
                    if (text.isBlank() && thinking.isBlank()) null
                    else if (role == "user") Message.User(text, ts)
                    else {
                        Message.Assistant.Builder().apply {
                            bodyText = text
                            thinkingText = thinking
                            // Parse files from history replay
                            val filesList = entry["files"] as? List<*> ?: emptyList<Any>()
                            for (fileEntry in filesList) {
                                (fileEntry as? Map<*, *>)?.let { f ->
                                    fileLinks.add(Message.Assistant.FileLinkData(
                                        id = f["id"]?.toString() ?: "",
                                        filename = f["name"]?.toString() ?: "",
                                        size = formatFileSize((f["size"] as? Number)?.toLong() ?: 0),
                                        contentType = f["content_type"]?.toString()
                                    ))
                                }
                            }
                        }.build().copy(timestamp = ts)
                    }
                }
                else -> null
            }
        }
        _messages.value = historyMsgs
        // QA-04: a fresh history replay supersedes any in-flight streaming slot.
        _lastStreamingMessage.value = null
    }

    // ── Helpers ──

    private fun getCurrentBuilder(): Message.Assistant.Builder {
        val key = activeBuilderKey()
        return uiMessageDispatchers.getOrPut(key) {
            Message.Assistant.Builder()
        }
    }

    /** Prefer the stable session UUID; fall back to name when id unknown yet. */
    private fun activeBuilderKey(): String {
        val id = _activeSessionId.value
        return id.ifBlank { _activeSessionName.value }
    }

    private fun onFileAvailable(msg: FileAvailableMessage) {
        // File available notification — add file link to current message
        val fileLink = Message.Assistant.FileLinkData(
            id = msg.id,
            filename = msg.name,
            size = formatFileSize(msg.size),
            contentType = msg.content_type
        )
        // Hold pushLock while mutating the builder's fileLinks list — build() reads
        // it via toList() and a concurrent add could throw ConcurrentModificationException.
        // (P1-4 fix; every other builder mutation already takes this lock.)
        synchronized(pushLock) {
            getCurrentBuilder().fileLinks.add(fileLink)
        }
        pushStreamingUpdate()
    }

    private fun formatFileSize(bytes: Long): String {
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "${bytes / 1024} KB"
            else -> "${"%.1f".format(bytes.toDouble() / (1024 * 1024))} MB"
        }
    }

    fun dispose() {
        scope.cancel()
        webSocketClient.dispose()
    }
}

data class TokenUsage(
    val input: Int = 0,
    val output: Int = 0,
    val total: Int = 0,
    val contextWindow: Int = 0,
    val messageCount: Int = 0,
    val contextUsage: ContextUsageInfo? = null
)
