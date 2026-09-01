package com.pimobile.app.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pimobile.app.AppContainer
import com.pimobile.app.data.ConnectionState
import com.pimobile.app.data.Message
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class ChatUiState(
    val messages: List<Message> = emptyList(),
    val sessionName: String = "Untitled Session",
    val model: String = "",
    val modelDisplay: String = "Select Model",
    val tokenUsage: String? = null,
    val isConnected: Boolean = false,
    val isConnecting: Boolean = false,
    val snackbarMessage: String? = null
)

class ChatViewModel : ViewModel() {
    private val repository = AppContainer.repository

    private val _uiState = MutableStateFlow(ChatUiState())
    val uiState: StateFlow<ChatUiState> = _uiState.asStateFlow()

    private val _inputText = MutableStateFlow("")
    val inputText: StateFlow<String> = _inputText.asStateFlow()

    private val _thinkingLevel = MutableStateFlow("off")
    val thinkingLevel: StateFlow<String> = _thinkingLevel.asStateFlow()

    private val _commands = MutableStateFlow<List<com.pimobile.app.data.CommandInfo>>(emptyList())
    val commands: StateFlow<List<com.pimobile.app.data.CommandInfo>> = _commands.asStateFlow()

    // QA-07: expose repository state through the ViewModel so UI components
    // (model picker bottom sheet) don't reach into the global AppContainer
    // singleton directly.
    val models: StateFlow<List<com.pimobile.app.data.ModelData>> = repository.models

    // QA-04: generation indicator driven by the streaming slot (not by scanning
    // the message list for isStreaming — the streaming message may be absent
    // from _messages between chunks in edge cases).
    val isGenerating: StateFlow<Boolean> = repository.lastStreamingMessage
        .map { it != null }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    init {
        // Observe connection state with snackbar for transitions
        viewModelScope.launch {
            var previous = repository.connectionState.value
            repository.connectionState.collect { state ->
                when {
                    state == ConnectionState.CONNECTED && previous != ConnectionState.CONNECTED ->
                        _uiState.value = _uiState.value.copy(snackbarMessage = "已连接服务器")
                    state == ConnectionState.DISCONNECTED && previous == ConnectionState.CONNECTED ->
                        _uiState.value = _uiState.value.copy(snackbarMessage = "连接已断开")
                    state == ConnectionState.DISCONNECTED && previous == ConnectionState.CONNECTING ->
                        _uiState.value = _uiState.value.copy(snackbarMessage = "连接失败，请检查服务器地址")
                }
                previous = state
                _uiState.value = _uiState.value.copy(
                    isConnected = state == ConnectionState.CONNECTED,
                    isConnecting = state == ConnectionState.CONNECTING
                )
            }
        }

        // Observe messages from server.
        // QA-04: the streaming Assistant lives in repository.lastStreamingMessage
        // (no full-list copy per chunk). Render = formal list + streaming slot.
        viewModelScope.launch {
            combine(repository.messages, repository.lastStreamingMessage) { list, streaming ->
                if (streaming != null) list + streaming else list
            }.collect { rendered ->
                _uiState.value = _uiState.value.copy(messages = rendered)
            }
        }

        // Observe active session name
        viewModelScope.launch {
            repository.activeSessionName.collect { name ->
                // Navigation-set name takes priority over server response
                if (sessionNameFromNavigation == null && name.isNotEmpty()) {
                    _uiState.value = _uiState.value.copy(sessionName = name)
                }
            }
        }

        // Server-confirmed session changes must override the navigation-set
        // name: after a reconnect the repository follows the server's current
        // session (session_list / message_history) while sessionNameFromNavigation
        // still holds the pre-drop name — the top bar would show a stale name
        // while the message area already shows the new conversation. Clear the
        // navigation override as soon as the server-confirmed id changes.
        viewModelScope.launch {
            repository.activeSessionId.collect { sid ->
                if (sid.isNotBlank()) {
                    sessionNameFromNavigation = null
                }
            }
        }

        // Observe token usage
        viewModelScope.launch {
            repository.tokenUsage.collect { usage ->
                val usageStr = if (usage.contextUsage != null) {
                    // New: show current context fill percentage
                    val used = formatTokens(usage.contextUsage.tokens)
                    val total = formatTokens(usage.contextUsage.context_window)
                    val pct = usage.contextUsage.percent
                    "$used / $total ($pct%) · ${usage.messageCount} msgs"
                } else if (usage.total > 0) {
                    // Fallback: cumulative total vs window
                    val used = formatTokens(usage.total)
                    val total = formatTokens(usage.contextWindow)
                    "$used / $total · ${usage.messageCount} msgs"
                } else null
                _uiState.value = _uiState.value.copy(tokenUsage = usageStr)
            }
        }

        // Observe thinking level
        viewModelScope.launch {
            repository.thinkingLevel.collect { level ->
                _thinkingLevel.value = level
            }
        }

        // Auto-connect if settings are configured
        viewModelScope.launch {
            val ds = AppContainer.settingsDataStore
            combine(ds.serverAddress, ds.authToken) { address, token ->
                address to token
            }.collect { (address, token) ->
                if (address.isNotBlank() && repository.connectionState.value == ConnectionState.DISCONNECTED) {
                    repository.connect(address, token)
                }
            }
        }

        // Observe model list for display names
        viewModelScope.launch {
            repository.models.collect { models ->
                if (models.isNotEmpty()) {
                    // Find current model's display name
                    val currentModel = _uiState.value.model
                    val found = models.find { it.id == currentModel }
                    val display = found?.name ?: currentModel
                    if (display.isNotEmpty()) {
                        _uiState.value = _uiState.value.copy(modelDisplay = display)
                    }
                }
            }
        }

        // Observe commands
        viewModelScope.launch {
            repository.commands.collect { cmds ->
                _commands.value = cmds
            }
        }
    }

    private var sessionNameFromNavigation: String? = null

    fun setSessionDisplayName(name: String) {
        sessionNameFromNavigation = name.ifEmpty { null }
        if (name.isNotEmpty()) {
            _uiState.value = _uiState.value.copy(sessionName = name)
        }
    }

    fun setInputText(text: String) {
        _inputText.value = text
    }

    fun sendMessage() {
        val text = _inputText.value
        if (text.isBlank()) return

        if (!_uiState.value.isConnected) {
            _uiState.value = _uiState.value.copy(snackbarMessage = "未连接服务器")
            return
        }

        // 本地斜杠命令：/compact 是协议消息（server 侧 compaction 流程），
        // 不能当普通 prompt 发给模型（否则模型会把它当文字回复）。
        // 精确匹配命令本身（允许带参数时后续可扩展）。
        if (text.trim() == "/compact") {
            compact()
            _inputText.value = ""
            return
        }

        // QA-08: keep the input text when the send failed (e.g. reconnect gap)
        // so the user's message isn't silently lost — clear only on success.
        if (repository.sendMessage(text)) {
            _inputText.value = ""
        } else {
            _uiState.value = _uiState.value.copy(snackbarMessage = "发送失败，消息已保留在输入框")
        }
    }

    fun clearSnackbar() {
        _uiState.value = _uiState.value.copy(snackbarMessage = null)
    }

    fun setModel(provider: String, model: String) {
        repository.setModel(provider, model)
        // Look up display name from cached models
        val display = repository.models.value.find { it.id == model }?.name ?: model
        _uiState.value = _uiState.value.copy(
            model = model,
            modelDisplay = display,
            snackbarMessage = "模型已切换至 $display"
        )
    }

    fun setThinkingLevel(level: String) {
        repository.setThinkingLevel(level)
    }

    fun downloadFile(id: String, filename: String, onReady: (java.io.File) -> Unit = {}) {
        repository.downloadFile(id, filename, onReady)
    }

    fun compact() {
        repository.compact()
    }

    /** Reserved for keyboard shortcuts / external triggers — drawer uses [setThinkingLevel]. */
    fun cycleThinking() {
        repository.cycleThinking()
    }

    fun abort() {
        repository.abort()
    }

    override fun onCleared() {
        super.onCleared()
        // Don't disconnect on config change — repository survives
    }

    companion object {
        private fun formatTokens(count: Int): String {
            return when {
                count >= 1_000_000 -> "${count / 1_000_000}.${(count % 1_000_000) / 100_000}M"
                count >= 1_000 -> "${count / 1_000}.${(count % 1_000) / 100}k"
                else -> count.toString()
            }
        }
    }
}
