package com.pimobile.app.data

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Parses incoming WebSocket JSON messages into ServerMessage objects.
 * Uses org.json (built into Android) — no external dependencies needed.
 */
object PiMessageParser {
    private const val TAG = "PiMessageParser"

    /** Safe nullable string extraction: returns null when key is absent or JSON null */
    private fun JSONObject.optNullableString(key: String): String? {
        return if (has(key) && !isNull(key)) getString(key) else null
    }

    fun parse(json: String): ServerMessage {
        val obj = JSONObject(json)
        val type = obj.optString("type", "unknown")
        Log.d(TAG, "recv: type=$type, json.len=${json.length}")

        return when (type) {
            // P2-3: all field reads use optXxx + defaults — a missing field must
            // never throw JSONException and collapse the whole message into an
            // ErrorMessage.
            // ⚠️ org.json.optString returns the literal string "null" for a JSON
            // null value (NOT the fallback!) — text fields must go through
            // optNullableString so `"text":null` renders as empty, not "null".
            "text_chunk" -> TextChunk(obj.optNullableString("text") ?: "")
            "thinking_chunk" -> ThinkingChunk(obj.optNullableString("text") ?: "")

            "tool_start" -> ToolStartMessage(
                tool_id = obj.optString("tool_id", ""),
                tool_name = obj.optString("tool_name", ""),
                input = obj.optString("input", "{}")
            )

            "tool_output" -> ToolOutputMessage(
                tool_id = obj.optString("tool_id", ""),
                output = obj.optNullableString("output") ?: "",
                status = obj.optString("status", "running")
            )

            "message_end" -> MessageEnd()

            "state_update" -> {
                val costObj = obj.optJSONObject("cost")
                val ctxUsage = if (obj.has("context_usage") && !obj.isNull("context_usage")) {
                    val cu = obj.optJSONObject("context_usage")
                    if (cu != null) {
                        ContextUsageInfo(
                            tokens = cu.optInt("tokens", 0),
                            context_window = cu.optInt("context_window", 0),
                            percent = cu.optInt("percent", 0)
                        )
                    } else null
                } else null
                StateUpdate(
                    // cost missing → empty CostInfo (zeroed), never a parse error
                    cost = CostInfo(
                        input = costObj?.optInt("input", 0) ?: 0,
                        output = costObj?.optInt("output", 0) ?: 0,
                        total = costObj?.optInt("total", 0) ?: 0
                    ),
                    context_window = obj.optInt("context_window", 0),
                    message_count = obj.optInt("message_count", 0),
                    thinking_level = obj.optString("thinking_level", "off"),
                    context_usage = ctxUsage
                )
            }

            "session_list" -> {
                val arr = obj.optJSONArray("sessions")
                // sessions missing → empty list, never a parse error
                val sessions = if (arr != null) {
                    val list = mutableListOf<SessionData>()
                    for (i in 0 until arr.length()) {
                        val s = arr.optJSONObject(i) ?: continue
                        val dn = s.optString("display_name", "")
                        list.add(
                            SessionData(
                                session_id = s.optString("session_id", s.optString("name", "")),
                                name = s.optString("name", "unnamed"),
                                current = if (s.has("current") && !s.isNull("current")) s.optBoolean("current") else null,
                                msg_count = s.optInt("msg_count", 0),
                                project = s.optString("project", ""),
                                status = s.optNullableString("status"),
                                display_name = if (dn.isEmpty()) null else dn,
                                last_active = s.optLong("last_active", 0),
                                parent_session = s.optNullableString("parent_session")
                            )
                        )
                    }
                    list
                } else emptyList()
                SessionList(sessions)
            }

            // QS-09: session_switched 携带稳定 session_id（服务端可选回传）
            "session_switched" -> SessionSwitched(
                obj.optString("name", ""),
                if (obj.has("session_id")) obj.optString("session_id", "") else null
            )

            "error" -> ErrorMessage(obj.optNullableString("message") ?: "Unknown error")

            "file_available" -> FileAvailableMessage(
                id = obj.optString("id", ""),
                name = obj.optString("name", ""),
                size = obj.optLong("size", 0),
                content_type = obj.optNullableString("content_type")
            )

            "message_history" -> {
                val rawMessages = obj.optJSONArray("messages")
                val messages: List<Any> = if (rawMessages != null) {
                    val list = mutableListOf<Any>()
                    for (i in 0 until rawMessages.length()) {
                        val m = rawMessages.optJSONObject(i) ?: continue
                        list.add(jsonObjectToMap(m))
                    }
                    list
                } else emptyList()
                MessageHistory(
                    name = obj.optString("name", ""),
                    messages = messages,
                    has_more = if (obj.has("has_more") && !obj.isNull("has_more")) obj.optBoolean("has_more") else null,
                    total = if (obj.has("total") && !obj.isNull("total")) obj.optInt("total") else null
                )
            }

            "model_list" -> {
                val arr = obj.optJSONArray("models") ?: JSONArray()
                val models = mutableListOf<ModelData>()
                for (i in 0 until arr.length()) {
                    val m = arr.optJSONObject(i) ?: continue
                    models.add(
                        ModelData(
                            id = m.optString("id", ""),
                            provider = m.optString("provider", ""),
                            name = m.optString("name", ""),
                            context_window = m.optInt("context_window", 0)
                        )
                    )
                }
                ModelListMessage(models)
            }

            "command_list" -> {
                val arr = obj.optJSONArray("commands")
                // commands missing → empty list, never a parse error
                val commands = if (arr != null) {
                    val list = mutableListOf<CommandInfo>()
                    for (i in 0 until arr.length()) {
                        val c = arr.optJSONObject(i) ?: continue
                        list.add(
                            CommandInfo(
                                name = c.optString("name", ""),
                                description = c.optNullableString("description"),
                                source = c.optString("source", "")
                            )
                        )
                    }
                    list
                } else emptyList()
                CommandListMessage(commands)
            }

            // P3-7: unknown types are logged + ignored, NOT converted to an
            // ErrorMessage — a new server-side message (e.g. after an SDK
            // upgrade) would otherwise surface as a misleading error bubble.
            else -> {
                Log.w(TAG, "Ignoring unknown message type: $type")
                UnknownMessage()
            }
        }
    }

    /**
     * Recursively convert a JSONObject to a Map for easy access in PiRepository.
     * Nested JSONObjects become nested Maps; JSONArrays become Lists.
     */
    private fun jsonObjectToMap(obj: JSONObject): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (obj.isNull(key)) {
                map[key] = null
            } else {
                val value = obj.get(key)
                map[key] = when (value) {
                    is JSONObject -> jsonObjectToMap(value)
                    is JSONArray -> {
                        val list = mutableListOf<Any?>()
                        for (i in 0 until value.length()) {
                            val item = value.opt(i)
                            list.add(when (item) {
                                is JSONObject -> jsonObjectToMap(item)
                                is JSONArray -> {
                                    val inner = mutableListOf<Any?>()
                                    for (j in 0 until item.length()) {
                                        val innerItem = item.opt(j)
                                        inner.add(when (innerItem) {
                                            is JSONObject -> jsonObjectToMap(innerItem)
                                            is JSONArray -> emptyList<Any?>()  // skip 3+ level nesting
                                            JSONObject.NULL -> null
                                            else -> innerItem
                                        })
                                    }
                                    inner
                                }
                                JSONObject.NULL -> null
                                else -> item
                            })
                        }
                        list
                    }
                    else -> value
                }
            }
        }
        return map
    }
}
