package com.pimobile.app.data

import android.util.Log
import kotlin.jvm.Volatile
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.*
import java.util.concurrent.TimeUnit
import java.io.IOException

/**
 * Connection states for the WebSocket client.
 */
enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED
}

/**
 * PiWebSocketClient manages the OkHttp WebSocket connection to the Pi server.
 *
 * Features:
 *   - pingInterval (15s) to detect half-open connections (lock-screen/Doze recovery)
 *   - Unlimited auto-reconnect with exponential backoff (capped at 60s)
 *   - Connection state as StateFlow
 *   - Incoming messages as SharedFlow
 *   - JSON error resilience (parse errors → ErrorMessage)
 */
class PiWebSocketClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)  // No timeout for WebSocket
        .pingInterval(15, TimeUnit.SECONDS)      // Detect half-open TCP (lock-screen/Doze)
        .build()

    private var webSocket: WebSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _messages = MutableSharedFlow<ServerMessage>(
        replay = 0,
        extraBufferCapacity = 256
    )
    val messages: SharedFlow<ServerMessage> = _messages.asSharedFlow()

    private var reconnectCount = 0
    private val baseReconnectDelayMs = 1000L
    private val maxReconnectDelayMs = 60_000L  // Cap exponential backoff at 60s

    // Generation token bumped on every connect/disconnect so stale OkHttp
    // WebSocketListener callbacks (from a previous socket) can be ignored instead
    // of spawning ghost reconnects. P1-1 fix: previously connect()→disconnect()→
    // close(1000)→async onClosed(1000)→code≠4001→scheduleReconnect leaked a parallel
    // ghost socket on every address change.
    @Volatile private var generation = 0
    private var reconnectJob: Job? = null

    private var serverAddress: String = ""
    private var authToken: String = ""

    /**
     * Connect to the Pi server WebSocket.
     */
    fun connect(address: String, token: String) {
        // disconnect() bumps generation + cancels pending reconnect, so the old
        // socket's async onClosed(1000) callback is treated as stale and skipped
        // (no ghost scheduleReconnect). (P1-1 fix.)
        disconnect()

        serverAddress = address
        authToken = token
        reconnectCount = 0
        _connectionState.value = ConnectionState.CONNECTING

        doConnect()
    }

    private fun doConnect() {
        val myGen = generation
        val wsUrl = buildWsUrl(serverAddress)
        val request = Request.Builder()
            .url(wsUrl)
            // QS-13: token in the Authorization header — never in the URL
            // (URL tokens leak into access logs and can't be rotated). The
            // server accepts both (header preferred, query fallback for old APKs).
            .apply {
                if (authToken.isNotEmpty()) {
                    header("Authorization", "Bearer $authToken")
                }
            }
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (myGen != generation) return  // stale socket, ignore
                reconnectCount = 0
                _connectionState.value = ConnectionState.CONNECTED
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val msg = PiMessageParser.parse(text)
                    scope.launch {
                        _messages.emit(msg)
                    }
                } catch (e: Exception) {
                    // Emit error for unparseable messages
                    scope.launch {
                        _messages.emit(ErrorMessage("Failed to parse: ${e.message}"))
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (myGen != generation) return  // stale socket from before disconnect
                _connectionState.value = ConnectionState.DISCONNECTED
                // Reconnect on every failure EXCEPT auth rejection (HTTP 401 handshake).
                // Covers IOException, SocketTimeout, ProtocolException, 5xx, network handoff,
                // and half-open detection from pingInterval — all should auto-recover.
                if (response?.code != 401) {
                    scheduleReconnect()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (myGen != generation) return  // stale socket (e.g. closed by disconnect())
                _connectionState.value = ConnectionState.DISCONNECTED
                // AUDIT-W1: only 4001 (auth rejection) is a definitive no-retry.
                // 4002 (QS-14 duplicate-connection rejection) is NOT definitive —
                // it fires when the server still sees our OLD socket as OPEN
                // (half-open TCP after a network blip / lock-screen; the server
                // has no heartbeat, so a stale socket can linger for minutes).
                // Treating 4002 as final left the app permanently disconnected
                // after a reconnect race until manual retry. Retry with backoff
                // instead: the server accepts once the stale socket is cleaned
                // up. In a genuine two-client scenario this retries ~1/min
                // (capped backoff) — self-healing, far better than dead.
                if (code != 4001) {
                    scheduleReconnect()
                }
            }
        })
    }

    private fun scheduleReconnect() {
        // Unlimited reconnect with exponential backoff capped at 60s.
        // Survives lock-screen/Doze recovery, server restarts, and network handoffs.
        // (No upper bound on attempts — a transient network blip hours later should still recover.)
        val myGen = generation
        val shift = reconnectCount.coerceAtMost(6)  // Cap shift to avoid overflow beyond 2^6
        val delay = minOf(baseReconnectDelayMs * (1L shl shift), maxReconnectDelayMs)
        reconnectCount++

        _connectionState.value = ConnectionState.CONNECTING
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(delay)
            // If a connect/disconnect happened while we were waiting (generation bumped),
            // abort — a newer doConnect() is already in flight.
            if (myGen != generation) return@launch
            doConnect()
        }
    }

    /**
     * Send a client message to the server.
     * Returns false (and surfaces an error to the messages flow) when the
     * socket is null or its send backlog is full, so the UI isn't left
     * silently assuming a message went through during a reconnect gap.
     * (P2-2 fix: previously send() returned Boolean but no caller checked,
     * so a failed send during a reconnect window was silently dropped —
     * the user's message vanished with no UI hint. Emitting an ErrorMessage
     * makes the loss visible. Chosen over a pending-send queue because a
     * queue would have to coordinate with the P1-1 generation flag to avoid
     * flushing ghost messages into a stale socket, which is a larger change
     * with its own races; surfacing the failure is the safe minimal fix.)
     */
    fun send(message: ClientMessage): Boolean {
        val ws = webSocket
        if (ws == null) {
            Log.w(TAG, "send dropped: not connected (${message::class.simpleName})")
            scope.launch { _messages.emit(ErrorMessage("未连接服务器，消息未发送（请等待重连）")) }
            return false
        }
        val json = buildJsonMessage(message)
        val ok = ws.send(json)
        if (!ok) {
            Log.w(TAG, "send dropped: WebSocket backlog full (${message::class.simpleName})")
            scope.launch { _messages.emit(ErrorMessage("发送失败：连接队列已满，请稍后重试")) }
        }
        return ok
    }

    /**
     * Disconnect from the server.
     */
    fun disconnect() {
        // Bump generation FIRST: any in-flight OkHttp listener (onClosed/onFailure)
        // from a prior socket sees myGen != generation and skips scheduleReconnect.
        // Also cancel a pending reconnect job so it can't fire after teardown.
        generation++
        cancelReconnectJob()
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        _connectionState.value = ConnectionState.DISCONNECTED
        reconnectCount = 0
    }

    private fun cancelReconnectJob() {
        reconnectJob?.cancel()
        reconnectJob = null
    }

    /**
     * Clean up all resources.
     */
    fun dispose() {
        disconnect()
        scope.cancel()
    }

    companion object {
        private const val TAG = "PiWebSocketClient"

        private fun buildWsUrl(address: String): String {
            var base = if (address.startsWith("ws://") || address.startsWith("wss://")) {
                address
            } else {
                "ws://$address"
            }
            // Ensure the URL path ends with the server's /ws endpoint.
            // endsWith (not contains) so paths like /wsapi or /api/ws don't
            // falsely skip appending /ws.
            if (!base.endsWith("/ws")) {
                base = "${base.trimEnd('/')}/ws"
            }
            // QS-13: token moved to the Authorization header (see doConnect).
            // `token` param is kept for signature compatibility but no longer
            // appended to the URL.
            return base
        }

        /**
         * Build JSON from a ClientMessage using manual string construction.
         * Avoids annotation-processor overhead and keeps protocol changes in
         * one place (this method + PiProtocol.kt data classes + PiMessageParser).
         */
        private fun buildJsonMessage(msg: ClientMessage): String {
            return when (msg) {
                is AbortMessage -> """{"type":"abort"}"""
                is UserMessage -> """{"type":"user_message","content":${jsonStr(msg.content)}}"""
                // QS-09: 带稳定 session_id 时优先按 id 路由（服务端匹配更可靠）
                is SwitchSessionMessage -> if (msg.session_id.isNullOrBlank()) {
                    """{"type":"switch_session","name":${jsonStr(msg.name)}}"""
                } else {
                    """{"type":"switch_session","name":${jsonStr(msg.name)},"session_id":${jsonStr(msg.session_id)}}"""
                }
                is NewSessionMessage -> """{"type":"new_session","name":${jsonStr(msg.name ?: "")},"cwd":${jsonStr(msg.cwd ?: "")}}"""
                is DeleteSessionMessage -> if (msg.session_id.isNullOrBlank()) {
                    """{"type":"delete_session","name":${jsonStr(msg.name)}}"""
                } else {
                    """{"type":"delete_session","name":${jsonStr(msg.name)},"session_id":${jsonStr(msg.session_id)}}"""
                }
                is RenameSessionMessage -> if (msg.session_id.isNullOrBlank()) {
                    """{"type":"rename_session","old":${jsonStr(msg.old)},"new":${jsonStr(msg.new)}}"""
                } else {
                    """{"type":"rename_session","old":${jsonStr(msg.old)},"new":${jsonStr(msg.new)},"session_id":${jsonStr(msg.session_id)}}"""
                }
                is SetModelMessage -> """{"type":"set_model","provider":${jsonStr(msg.provider)},"model":${jsonStr(msg.model)}}"""
                is GetSessionsMessage -> """{"type":"get_sessions"}"""
                is GetStateMessage -> """{"type":"get_state"}"""
                is CompactMessage -> """{"type":"compact"}"""
                is GetModelsMessage -> """{"type":"get_models"}"""
                is CycleThinkingMessage -> """{"type":"cycle_thinking"}"""
                is GetCommandsMessage -> """{"type":"get_commands"}"""
                else -> throw IllegalArgumentException("Unknown message type: ${msg::class.simpleName}")
            }
        }

        /**
         * Minimal JSON string escape — covers backslash, double quote, control chars.
         * User content shouldn't contain \b\f or other rare chars; surrogate pairs pass through.
         */
        private fun jsonStr(s: String): String {
            val sb = StringBuilder(s.length + 2)
            sb.append('"')
            for (c in s) {
                when (c) {
                    '\\' -> sb.append("\\\\")
                    '"' -> sb.append("\\\"")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    '\b' -> sb.append("\\b")
                    '\u000C' -> sb.append("\\f")
                    else -> {
                        if (c.code < 0x20) {
                            sb.append("\\u%04x".format(c.code))
                        } else {
                            sb.append(c)
                        }
                    }
                }
            }
            sb.append('"')
            return sb.toString()
        }
    }
}
