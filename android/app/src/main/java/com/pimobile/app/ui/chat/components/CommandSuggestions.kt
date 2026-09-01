package com.pimobile.app.ui.chat.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pimobile.app.data.CommandInfo

private val WHITELIST_COMMANDS = listOf(
    CommandInfo("/compact", "⚡ 压缩会话上下文", "builtin"),
    CommandInfo("/fork", "🌿 从当前节点派生子会话", "builtin"),
    CommandInfo("/new", "✨ 新建工程会话", "builtin"),
    CommandInfo("/think", "🧠 调节思考等级 (off/low/med/high)", "builtin"),
)

@Composable
fun CommandSuggestions(
    query: String,
    commands: List<CommandInfo>,
    onCommandSelected: (String) -> Unit
) {
    if (!query.startsWith("/")) return

    val effectiveCommands = if (commands.isEmpty()) WHITELIST_COMMANDS else commands
    val filtered = effectiveCommands.filter { it.name.startsWith(query) }
    if (filtered.isEmpty()) return

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp)
    ) {
        LazyRow(
            modifier = Modifier.padding(6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(filtered) { cmd ->
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.clickable { onCommandSelected(cmd.name) }
                ) {
                    Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                        Text(
                            text = cmd.name,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary
                        )
                        cmd.description?.let { desc ->
                            Text(
                                text = desc,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }
    }
}
