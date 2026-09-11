package com.pimobile.app.data

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import android.content.Context
import java.io.File

/**
 * PiRepository — facade after C1 split (God Object → 3 modules).
 *
 * Keeps public API identical (AppContainer.repository / ViewModels zero change).
 * Internally delegates message streaming to [MessageStore] and HTTP downloads to [FileDownloader].
 * Retains session/connection/token state and WebSocket orchestration.
 */
class PiRepository(private val appContext: Context) {
    val webSocketClient = PiWebSocketClient()

    /** Constructed after connect: http://host:port — exposed for Coil image preview */
    internal var baseUrl: String = ""

    fun getBaseUrl(): String = baseUrl

    // ── Delegated stores ──
    private val messageStore = MessageStore(
        getActiveSessionId = { _activeSessionId.value },
        getActiveSessionName = { _activeSessionName.value }
    )

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    private val fileDownloader = FileDownloader(
        appContext = appContext,
        getBaseUrl = ::getBaseUrl,
        getSessionId = { _activeSessionId.value },
        scope = scope
    )

    // ── Messages (delegated) ──
    val messages: StateFlow<List<Message>> get() = messageStore.messages
    val lastStreamingMessage: StateFlow<Message.Assistant?> get() = messageStore.lastStreamingMessage

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

    private var collectJob: Job? = null
    private var commandsJob: Job? = null
    private var reconnectJob: Job? = null

    companion object {
        private const val TAG = "PiRepository"
    }

    fun connect(address: String, token: String) {
        baseUrl = if (address.startsWith("ws://")) {
            "http://${address.removePrefix("ws://").split("/ws").first()}"
        } else if (address.startsWith("wss://")) {
            "https://${address.removePrefix("wss://").split("/ws").first()}"
        } else {
            "http://${address}"
        }

        webSocketClient.connect(address, token)

        collectJob?.cancel()
        commandsJob?.cancel()
        reconnectJob?.cancel()
        collectJob = scope.launch {
            webSocketClient.messages.collect { msg ->
                processMessage(msg)
            }
        }

        commandsJob = scope.launch {
            val connected = withTimeoutOrNull(10_000L) {
                webSocketClient.connectionState.first { it == ConnectionState.CONNECTED }
            }
            if (connected == null) {
                Log.w(TAG, "connect: timed out waiting for CONNECTED, commands not requested")
            } else {
                webSocketClient.send(GetCommandsMessage())
                requestModels()
            }
        }

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

    fun sendMessage(text: String): Boolean {
        val ok = webSocketClient.send(UserMessage(text))
        if (ok) {
            messageStore.addUserMessage(text)
        }
        return ok
    }

    fun abort() {
        webSocketClient.send(AbortMessage())
    }

    fun switchSession(name: String, sessionId: String? = null) {
        webSocketClient.send(SwitchSessionMessage(name, sessionId))
        synchronized(messageStore.pushLock) {
            messageStore.clearLocked()
            _activeSessionName.value = name
            _activeSessionId.value = sessionId ?: ""
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

    fun cycleThinking() {
        webSocketClient.send(CycleThinkingMessage())
    }

    fun downloadFile(id: String, filename: String = "download", onDownloaded: (File) -> Unit = {}) {
        fileDownloader.downloadFile(id, filename, onDownloaded)
    }

    fun setThinkingLevel(level: String) {
        webSocketClient.send(UserMessage("/think $level"))
    }

    // ── Message processing ──

    private fun processMessage(msg: ServerMessage) {
        when (msg) {
            is TextChunk -> messageStore.appendText(msg.text)
            is ThinkingChunk -> messageStore.appendThinking(msg.text)
            is ToolStartMessage -> messageStore.onToolStart(msg)
            is ToolOutputMessage -> messageStore.onToolOutput(msg)
            is MessageEnd -> messageStore.onMessageEnd()
            is StateUpdate -> onStateUpdate(msg)
            is SessionList -> onSessionList(msg)
            is SessionSwitched -> onSessionSwitched(msg)
            is ErrorMessage -> messageStore.onError(msg)
            is ModelListMessage -> onModelList(msg)
            is MessageHistory -> messageStore.onHistory(msg)
            is FileAvailableMessage -> messageStore.onFileAvailable(msg)
            is CommandListMessage -> _commands.value = msg.commands
            is UnknownMessage -> {}
            else -> {}
        }
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
        val cur = msg.sessions.find { it.current == true }
        if (cur != null) {
            if (cur.session_id.isNotBlank()) _activeSessionId.value = cur.session_id
            if (cur.name.isNotBlank()) _activeSessionName.value = cur.name
        }
    }

    private fun onSessionSwitched(msg: SessionSwitched) {
        synchronized(messageStore.pushLock) {
            messageStore.clearLocked()
        }
        _activeSessionName.value = msg.name.ifEmpty { _activeSessionName.value }
        if (!msg.session_id.isNullOrBlank()) {
            _activeSessionId.value = msg.session_id
        }
        webSocketClient.send(GetSessionsMessage())
    }

    private fun onModelList(msg: ModelListMessage) {
        _models.value = msg.models
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
