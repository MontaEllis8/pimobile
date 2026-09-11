// ── Android → Server (ClientMessage: 8 核心上行 + 5 辅助) ──

export type ClientMessage =
  | { type: "user_message"; content: string }
  | { type: "abort" }
  // QS-09: session_id 可选 — 旧客户端不传则回落 name 匹配（向后兼容）
  | { type: "switch_session"; name: string; session_id?: string }
  | { type: "new_session"; name?: string; cwd?: string }
  | { type: "delete_session"; name: string; session_id?: string }
  | { type: "rename_session"; old: string; new: string; session_id?: string }
  | { type: "compact" }
  | { type: "cycle_thinking" }
  | { type: "set_model"; provider: string; model: string }
  | { type: "get_sessions" }
  | { type: "get_state" }
  | { type: "get_models" }
  | { type: "get_commands" };

// ── Server → Android (ServerMessage: 7 核心下行 + 6 折叠/辅助) ──

export type ServerMessage =
  | { type: "thinking_chunk"; text: string }
  | { type: "text_chunk"; text: string }
  | { type: "tool_start"; tool_id: string; tool_name: string; input: string }
  | { type: "tool_output"; tool_id: string; output: string; status: "running" | "completed" | "failed" }
  | { type: "message_end" }
  | { type: "state_update"; cost: { input: number; output: number; total: number }; context_window: number; message_count: number; thinking_level: string; context_usage?: { tokens: number; context_window: number; percent: number } }
  | { type: "session_list"; sessions: SessionInfo[] }
  // QS-09: session_switched 携带稳定 session_id（新客户端可立即绑定 builder key）
  | { type: "session_switched"; name: string; session_id?: string }
  | { type: "error"; message: string }
  | { type: "file_available"; id: string; name: string; size: number; content_type?: string }
  | { type: "message_history"; name: string; messages: HistoryEntry[]; has_more?: boolean; total?: number }
  | { type: "model_list"; models: ModelInfo[] }
  | { type: "command_list"; commands: CommandInfo[] };

export interface SessionInfo {
  session_id: string;   // Stable UUID from SDK
  name: string;          // Display name (human readable)
  current?: boolean;
  msg_count: number;
  project: string;
  status: string;
  display_name?: string;
  last_active: number;
  parent_session?: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  context_window: number;
}

export interface CommandInfo {
  name: string;
  description?: string;
  source: string;
}

export interface HistoryEntry {
  role: string;
  text: string;
  thinking?: string;
  files?: { id: string; name: string; size: number; content_type: string }[];
  /** Real message time in epoch ms, sourced from the persisted session entry's
   *  ISO timestamp. May be absent for synthesized messages (e.g. compaction summary),
   *  in which case the client falls back to "now". */
  timestamp?: number;
}
