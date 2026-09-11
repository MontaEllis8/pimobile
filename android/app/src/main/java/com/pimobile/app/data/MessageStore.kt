package com.pimobile.app.data

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * MessageStore — extracted from PiRepository (C1 God Object split).
 *
 * Owns all message-related state: formal list + QA-04 streaming slot + builder map + pushLock.
 * PiRepository remains the facade and still owns _activeSessionName/Id, sessions, tokenUsage etc.
 * This class does not know about WebSocket; it is purely an in-memory message processor.
 *
 * Thread-safety: all mutations of _messages / _lastStreamingMessage / uiMessageDispatchers
 * are guarded by [pushLock]. Callers that need to atomically update activeSession + clear
 * messages should synchronized(pushLock) externally and call [clearLocked].
 */
class MessageStore(
    private val getActiveSessionId: () -> String,
    private val getActiveSessionName: () -> String
) {
    // ── Messages ──
    private val _messages = MutableStateFlow<List<Message>>(emptyList())
    val messages: StateFlow<List<Message>> = _messages.asStateFlow()

    private val _lastStreamingMessage = MutableStateFlow<Message.Assistant?>(null)
    val lastStreamingMessage: StateFlow<Message.Assistant?> = _lastStreamingMessage.asStateFlow()

    internal val pushLock = Any()
    private val uiMessageDispatchers = mutableMapOf<String, Message.Assistant.Builder>()

    companion object {
        private const val TAG = "MessageStore"
    }

    /** Prefer the stable session UUID; fall back to name when id unknown yet. */
    private fun activeBuilderKey(): String {
        val id = getActiveSessionId()
        return id.ifBlank { getActiveSessionName() }
    }

    private fun getCurrentBuilder(): Message.Assistant.Builder {
        val key = activeBuilderKey()
        return uiMessageDispatchers.getOrPut(key) {
            Message.Assistant.Builder()
        }
    }

    /** Clears messages/streaming/builders. Synchronized internally. */
    fun clearForSwitch() {
        synchronized(pushLock) {
            clearLocked()
        }
    }

    /** Clears without synchronizing — caller must already hold [pushLock]. */
    fun clearLocked() {
        _messages.value = emptyList()
        _lastStreamingMessage.value = null
        uiMessageDispatchers.clear()
    }

    fun addUserMessage(text: String) {
        val userMsg = Message.User(text, System.currentTimeMillis())
        _messages.update { it + userMsg }
    }

    fun appendText(text: String) {
        synchronized(pushLock) {
            val current = getCurrentBuilder().bodyText
            getCurrentBuilder().bodyText =
                if (text.length > current.length && text.startsWith(current)) text
                else current + text
            Log.d(TAG, "appendText: len=${text.length}, bodyText.len=${getCurrentBuilder().bodyText.length}")
        }
        pushStreamingUpdate()
    }

    fun appendThinking(text: String) {
        synchronized(pushLock) {
            val current = getCurrentBuilder().thinkingText
            getCurrentBuilder().thinkingText = if (text.startsWith(current)) text else current + text
        }
        pushStreamingUpdate()
    }

    fun onToolStart(msg: ToolStartMessage) {
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

    fun onToolOutput(msg: ToolOutputMessage) {
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

    fun onMessageEnd() {
        synchronized(pushLock) {
            val builder = getCurrentBuilder()
            val built = builder.build()
            Log.d(TAG, "onMessageEnd: built.bodyText.len=${built.bodyText.length}, sections=${built.sections.size}")
            val msg = built.copy(isStreaming = false)
            _messages.update { current ->
                if (current.isNotEmpty() && current.last() is Message.Assistant) {
                    current.dropLast(1) + msg
                } else {
                    current + msg
                }
            }
            _lastStreamingMessage.value = null
            val key = activeBuilderKey()
            uiMessageDispatchers.remove(key)
        }
    }

    fun pushStreamingUpdate() {
        val msg: Message.Assistant
        synchronized(pushLock) {
            val built = getCurrentBuilder().build(streaming = true)
            if (built.isEmpty()) return
            val stableId = "streaming-" + activeBuilderKey().ifBlank { "default" }
            msg = built.copy(id = stableId)
        }
        _lastStreamingMessage.value = msg
    }

    fun onFileAvailable(msg: FileAvailableMessage) {
        val fileLink = Message.Assistant.FileLinkData(
            id = msg.id,
            filename = msg.name,
            size = formatFileSize(msg.size),
            contentType = msg.content_type
        )
        synchronized(pushLock) {
            getCurrentBuilder().fileLinks.add(fileLink)
        }
        pushStreamingUpdate()
    }

    fun onError(msg: ErrorMessage) {
        val errorSection = Message.Assistant.ErrorData(msg.message)
        synchronized(pushLock) {
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

    fun onHistory(msg: MessageHistory) {
        Log.d(TAG, "onHistory: received ${msg.messages.size} entries, has_more=${msg.has_more}, total=${msg.total}")
        val historyMsgs = msg.messages.mapNotNull { entry ->
            when (entry) {
                is Map<*, *> -> {
                    val role = entry["role"]?.toString() ?: ""
                    val text = entry["text"]?.toString() ?: ""
                    val thinking = entry["thinking"]?.toString() ?: ""
                    val ts = (entry["timestamp"] as? Number)?.toLong() ?: System.currentTimeMillis()
                    val filesRaw = entry["files"] as? List<*>
                    Log.d(TAG, "onHistory entry role=$role textLen=${text.length} thinkingLen=${thinking.length} files=${filesRaw?.size ?: 0} ts=$ts")
                    if (text.isBlank() && thinking.isBlank() && filesRaw.isNullOrEmpty()) {
                        Log.d(TAG, "onHistory: dropping blank entry")
                        null
                    } else if (role == "user") Message.User(text, ts)
                    else {
                        Message.Assistant.Builder().apply {
                            bodyText = text
                            thinkingText = thinking
                            val filesList = filesRaw ?: emptyList<Any>()
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
        Log.d(TAG, "onHistory: built ${historyMsgs.size} messages, files total=${historyMsgs.filterIsInstance<Message.Assistant>().sumOf { it.fileLinks.size }}")
        _messages.value = historyMsgs
        _lastStreamingMessage.value = null
    }

    private fun formatFileSize(bytes: Long): String {
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "${bytes / 1024} KB"
            else -> "${"%.1f".format(bytes.toDouble() / (1024 * 1024))} MB"
        }
    }
}
