package com.pimobile.app.data

/**
 * Client messages: Android → Server
 */
interface ClientMessage {
    val type: String
}


data class UserMessage(val content: String) : ClientMessage {
    override val type = "user_message"
}


class AbortMessage : ClientMessage {
    override val type = "abort"
}


// QS-09: session_id 可选 — 服务端优先按稳定 UUID 匹配，避免同名会话切错/删错
data class SwitchSessionMessage(val name: String, val session_id: String? = null) : ClientMessage {
    override val type = "switch_session"
}


data class NewSessionMessage(val name: String? = null, val cwd: String? = null) : ClientMessage {
    override val type = "new_session"
}


data class DeleteSessionMessage(val name: String, val session_id: String? = null) : ClientMessage {
    override val type = "delete_session"
}


data class RenameSessionMessage(val old: String, val new: String, val session_id: String? = null) : ClientMessage {
    override val type = "rename_session"
}


data class SetModelMessage(val provider: String, val model: String) : ClientMessage {
    override val type = "set_model"
}


class GetSessionsMessage : ClientMessage {
    override val type = "get_sessions"
}


class GetStateMessage : ClientMessage {
    override val type = "get_state"
}


class CompactMessage : ClientMessage {
    override val type = "compact"
}


class GetModelsMessage : ClientMessage {
    override val type = "get_models"
}


/**
 * Android → Server: cycle the thinking level on the PC side.
 *
 * Reserved for keyboard shortcuts / external triggers — the primary thinking
 * UI path is the top-bar drawer (setThinkingLevel → state_update sync), so no
 * in-app screen currently invokes this message. Kept because `cycle_thinking`
 * remains a core uplink in the v1.0 protocol matrix and the server implements
 * it (session.ts cycleThinkingLevel).
 */
class CycleThinkingMessage : ClientMessage {
    override val type = "cycle_thinking"
}

/**
 * Android → Server: request available slash commands
 */

class GetCommandsMessage : ClientMessage {
    override val type = "get_commands"
}

/**
 * Server messages: Server → Android
 */
interface ServerMessage {
    val type: String
}


data class TextChunk(val text: String) : ServerMessage {
    override val type = "text_chunk"
}


data class ThinkingChunk(val text: String) : ServerMessage {
    override val type = "thinking_chunk"
}


data class ToolStartMessage(
    val tool_id: String,
    val tool_name: String,
    val input: String
) : ServerMessage {
    override val type = "tool_start"
}


data class ToolOutputMessage(
    val tool_id: String,
    val output: String,
    val status: String  // "running" | "completed" | "failed"
) : ServerMessage {
    override val type = "tool_output"
}


class MessageEnd : ServerMessage {
    override val type = "message_end"
}


data class StateUpdate(
    val cost: CostInfo,
    val context_window: Int,
    val message_count: Int,
    val thinking_level: String = "off",
    val context_usage: ContextUsageInfo? = null
) : ServerMessage {
    override val type = "state_update"
}


data class CostInfo(
    val input: Int,
    val output: Int,
    val total: Int
)


data class ContextUsageInfo(
    val tokens: Int,
    val context_window: Int,
    val percent: Int
)


data class SessionList(val sessions: List<SessionData>) : ServerMessage {
    override val type = "session_list"
}


data class SessionData(
    val session_id: String = "",
    val name: String,
    val current: Boolean? = null,
    val msg_count: Int,
    val project: String,
    val status: String? = null,  // "active" | "running" | "completed" | "sleeping"
    val display_name: String? = null,
    val last_active: Long = 0,
    val parent_session: String? = null
)


// QS-09: session_switched 携带稳定 session_id，客户端可立即绑定 builder key
data class SessionSwitched(val name: String, val session_id: String? = null) : ServerMessage {
    override val type = "session_switched"
}


data class ErrorMessage(val message: String) : ServerMessage {
    override val type = "error"
}


/** P3-7: server sent a message type this client does not know yet. Ignored
 *  (logged in the parser) instead of surfacing as an error bubble — the
 *  server may add new message types (e.g. after an SDK upgrade). */
class UnknownMessage : ServerMessage {
    override val type = "unknown"
}


data class FileAvailableMessage(
    val id: String,
    val name: String,
    val size: Long,
    val content_type: String? = null
) : ServerMessage {
    override val type = "file_available"
}


data class MessageHistory(
    val name: String,
    val messages: List<Any>
) : ServerMessage {
    override val type = "message_history"
}


data class ModelListMessage(val models: List<ModelData>) : ServerMessage {
    override val type = "model_list"
}


data class ModelData(
    val id: String,
    val provider: String,
    val name: String,
    val context_window: Int
)

/**
 * Server → Android: available slash commands
 */

data class CommandInfo(
    val name: String,
    val description: String? = null,
    val source: String = ""
)


data class CommandListMessage(val commands: List<CommandInfo>) : ServerMessage {
    override val type = "command_list"
}
