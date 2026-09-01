package com.pimobile.app.data

import java.util.UUID

enum class SessionStatus {
    ACTIVE,
    BACKGROUND,
    COMPLETED,
    SLEEPING
}

data class SessionGroup(
    val path: String,
    val sessions: List<SessionInfo>
)

data class SessionInfo(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val projectPath: String,
    val status: SessionStatus,
    val lastActiveTime: Long = 0,
    val messageCount: Int = 0,
    val isPinned: Boolean = false,
    val parentId: String? = null,
    val parentSession: String? = null,
    val displayName: String = ""
)

sealed class MessagePart {
    data class Text(val content: String) : MessagePart()
}

sealed class AssistantSection {
    data class Thinking(val summary: String, val content: String) : AssistantSection()
    data class Body(val parts: List<MessagePart>) : AssistantSection()
    data class ToolCall(val name: String, val status: ToolStatus, val details: String? = null, val output: String = "") : AssistantSection()
    data class FileLink(val id: String = "", val filename: String, val size: String, val contentType: String? = null) : AssistantSection()
    data class ErrorCard(val message: String) : AssistantSection()
}

enum class ToolStatus {
    COMPLETED, RUNNING, FAILED
}

sealed class Message {
    abstract val id: String
    abstract val timestamp: Long

    data class User(
        val content: String,
        override val timestamp: Long = System.currentTimeMillis(),
        override val id: String = UUID.randomUUID().toString()
    ) : Message()

    data class Assistant(
        val sections: List<AssistantSection> = emptyList(),
        val isStreaming: Boolean = false,
        override val timestamp: Long = System.currentTimeMillis(),
        override val id: String = UUID.randomUUID().toString(),
        // Flattened fields for streaming message building
        val thinkingText: String = "",
        val bodyText: String = "",
        val toolCall: ToolCallData? = null,
        val fileLinks: List<FileLinkData> = emptyList(),
        val error: ErrorData? = null
    ) : Message() {

        fun isEmpty(): Boolean =
            thinkingText.isEmpty() && bodyText.isEmpty() && toolCall == null &&
            fileLinks.isEmpty() && error == null

        fun toSections(): List<AssistantSection> {
            if (sections.isNotEmpty()) return sections
            val result = mutableListOf<AssistantSection>()
            if (thinkingText.isNotEmpty()) {
                result.add(AssistantSection.Thinking("", thinkingText))
            }
            if (bodyText.isNotEmpty()) {
                result.add(AssistantSection.Body(listOf(MessagePart.Text(bodyText))))
            }
            if (toolCall != null) {
                val status = when (toolCall.status) {
                    "running" -> ToolStatus.RUNNING
                    "completed" -> ToolStatus.COMPLETED
                    "failed" -> ToolStatus.FAILED
                    else -> ToolStatus.RUNNING
                }
                // P2-4: include tool output so the expanded tool card shows the
                // actual tool result, not just the input arguments.
                result.add(AssistantSection.ToolCall(toolCall.toolName, status, toolCall.input, toolCall.output))
            }
            for (fl in fileLinks) {
                result.add(AssistantSection.FileLink(fl.id, fl.filename, fl.size, fl.contentType))
            }
            if (error != null) {
                result.add(AssistantSection.ErrorCard(error.message))
            }
            return result
        }

        data class ToolCallData(
            val toolId: String = "",
            val toolName: String = "",
            val input: String = "",
            val output: String = "",
            val status: String = "running"
        )

        data class FileLinkData(
            val id: String = "",
            val filename: String = "",
            val size: String = "",
            val contentType: String? = null
        )

        data class ErrorData(
            val message: String = ""
        )

        class Builder {
            var thinkingText: String = ""
            var bodyText: String = ""
            var toolCall: ToolCallData? = null
            var fileLinks: MutableList<FileLinkData> = mutableListOf()
            var error: ErrorData? = null

            /**
             * Build the final Assistant message.
             *
             * P2-9: while streaming, pass `streaming = true` to skip section
             * expansion — the UI renders the flattened fields (bodyText etc.)
             * directly, avoiding an O(n) bodyText copy + toSections() rebuild on
             * every text_chunk (O(n²) overall for long replies). Sections are
             * generated exactly once when streaming completes via build().
             */
            fun build(streaming: Boolean = false): Assistant {
                val msg = Assistant(
                    thinkingText = thinkingText,
                    bodyText = bodyText,
                    toolCall = toolCall,
                    fileLinks = fileLinks.toList(),
                    error = error,
                    isStreaming = streaming
                )
                // Populate sections for UI rendering (only at streaming completion)
                return if (streaming) msg else msg.copy(sections = msg.toSections())
            }
        }
    }
}
