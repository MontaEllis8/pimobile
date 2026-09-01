package com.pimobile.app.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pimobile.app.AppContainer
import com.pimobile.app.data.SessionData
import com.pimobile.app.data.SessionGroup
import com.pimobile.app.data.SessionInfo
import com.pimobile.app.data.SessionStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SessionsUiState(
    val searchInput: String = "",
    val groupedSessions: List<SessionGroup> = emptyList(),
    val pinnedSessions: List<SessionInfo> = emptyList(),
    val expandedGroups: Set<String> = emptySet(),
    val scrollToIndex: Int = 0,
    val activeSessionId: String? = null
)

class SessionsViewModel : ViewModel() {
    private val repository = AppContainer.repository
    private val settingsDataStore = AppContainer.settingsDataStore

    private val _uiState = MutableStateFlow(SessionsUiState())
    val uiState: StateFlow<SessionsUiState> = _uiState.asStateFlow()

    private val _expandedGroups = MutableStateFlow<Set<String>>(emptySet())
    private var groupsLoaded = false
    private var dataStoreLoaded = false
    private var groupsInitialized = false
    val expandedGroups: StateFlow<Set<String>> = _expandedGroups.asStateFlow()

    private var pinnedIds: Set<String> = emptySet()

    init {
        viewModelScope.launch {
            repository.sessions.collect { sessionDataList ->
                updateSessions(sessionDataList)
            }
        }
        viewModelScope.launch {
            settingsDataStore.pinnedIds.collect { ids ->
                pinnedIds = ids
                val current = repository.sessions.value
                if (current.isNotEmpty()) { updateSessions(current) }
            }
        }
        // Load persisted expanded groups from DataStore.
        // Gated by dataStoreLoaded so updateSessions' initial-expand decision
        // never runs before the persisted (possibly empty) set arrives -
        // the race that previously lost user collapses.
        viewModelScope.launch {
            settingsDataStore.expandedGroups
                .combine(settingsDataStore.groupsInitialized) { groups, initialized ->
                    groups to initialized
                }
                .collect { (groups, initialized) ->
                    _expandedGroups.value = groups
                    groupsInitialized = initialized
                    dataStoreLoaded = true
                    val current = repository.sessions.value
                    if (current.isNotEmpty()) updateSessions(current)
                }
        }
        repository.requestSessions()
    }

    private fun updateSessions(sessionDataList: List<SessionData>) {
        val all = sessionDataList.map { sd ->
            val mappedStatus = when (sd.status) {
                "sleeping" -> SessionStatus.SLEEPING
                "running" -> SessionStatus.BACKGROUND
                "completed" -> SessionStatus.COMPLETED
                else -> SessionStatus.ACTIVE
            }
            // Display name: prefer server-provided display_name, fall back to generated name
            val displayName = sd.display_name?.take(40)
                ?: if (sd.name.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))) {
                    "Session ${sd.name.take(8)}"
                } else if (sd.name.length > 40) {
                    sd.name.take(40) + "..."
                } else {
                    sd.name
                }
            SessionInfo(
                id = sd.session_id.ifBlank { sd.name },
                name = sd.name,
                projectPath = sd.project,
                status = mappedStatus,
                lastActiveTime = sd.last_active,
                messageCount = sd.msg_count,
                isPinned = pinnedIds.contains(sd.session_id.ifBlank { sd.name }),
                displayName = displayName,
                parentId = sd.parent_session,
                parentSession = sd.parent_session
            )
        }

        val search = _uiState.value.searchInput.lowercase()

        val filtered = if (search.isNotBlank()) {
            all.filter { it.name.lowercase().contains(search) || it.projectPath.lowercase().contains(search) }
        } else {
            all
        }

        val pinned = filtered.filter { it.isPinned }.sortedByDescending { it.lastActiveTime }
        val rest = filtered.filter { !it.isPinned }

        val grouped = rest.groupBy { it.projectPath }.map {
            SessionGroup(path = it.key, sessions = sortHierarchically(it.value))
        }.sortedBy { it.path }

        // Auto-expand only on first load — persist user collapses across restarts
        if (!groupsLoaded && dataStoreLoaded) {
            if (!groupsInitialized) {
                _expandedGroups.value = grouped.map { it.path }.toSet()
                viewModelScope.launch {
                    settingsDataStore.setExpandedGroups(_expandedGroups.value)
                    settingsDataStore.setGroupsInitialized(true)
                }
            }
            groupsLoaded = true
        }

        // Find active session id for scroll-to-target
        val activeId = sessionDataList.find { it.current == true }?.session_id

        _uiState.value = _uiState.value.copy(
            groupedSessions = grouped,
            pinnedSessions = pinned,
            expandedGroups = _expandedGroups.value,
            activeSessionId = activeId
        )
    }

    private fun sortHierarchically(sessions: List<SessionInfo>): List<SessionInfo> {
        val result = mutableListOf<SessionInfo>()
        val placed = mutableSetOf<String>()

        fun childrenOf(id: String): List<SessionInfo> =
            sessions.filter { (it.parentId == id || it.parentSession == id) && it.id !in placed }
                .sortedByDescending { it.lastActiveTime }

        fun walk(parent: SessionInfo) {
            if (parent.id in placed) return
            placed.add(parent.id)
            result.add(parent)
            childrenOf(parent.id).forEach { walk(it) }
        }

        // Top-level sessions (no parent); recurse so grandchildren render too.
        val topLevel = sessions.filter { it.parentId == null && it.parentSession == null }
            .sortedByDescending { it.lastActiveTime }
        topLevel.forEach { walk(it) }

        // Orphans whose parent lives in another group: append instead of dropping.
        sessions.filter { it.id !in placed }
            .sortedByDescending { it.lastActiveTime }
            .forEach { result.add(it) }

        return result
    }

    fun saveScrollPosition(index: Int) {
        _uiState.value = _uiState.value.copy(scrollToIndex = index)
    }

    fun setSearchInput(text: String) {
        _uiState.value = _uiState.value.copy(searchInput = text)
        // Re-process current list
        viewModelScope.launch {
            val current = repository.sessions.value
            updateSessions(current)
        }
    }

    // QS-09: 传稳定 session_id（服务端优先按 id 匹配，避免同名会话切错/删错/改错）
    fun switchToSession(name: String, sessionId: String? = null) {
        repository.switchSession(name, sessionId)
    }

    fun createSession(name: String) {
        viewModelScope.launch {
            // Read default cwd from settings
            val defaultCwd = AppContainer.settingsDataStore.defaultCwd.first()
            val cwd = defaultCwd.ifBlank { null }
            repository.createSession(name, cwd)
        }
    }

    fun deleteSession(name: String, sessionId: String? = null) {
        repository.deleteSession(name, sessionId)
    }

    fun renameSession(oldName: String, newName: String, sessionId: String? = null) {
        repository.renameSession(oldName, newName, sessionId)
    }

    fun toggleGroup(path: String) {
        _expandedGroups.update { current ->
            if (path in current) current - path else current + path
        }
        _uiState.value = _uiState.value.copy(expandedGroups = _expandedGroups.value)
        viewModelScope.launch { settingsDataStore.setExpandedGroups(_expandedGroups.value) }
    }

    fun togglePin(id: String) {
        val current = _uiState.value

        // Merge all sessions from both lists
        val allItems = current.pinnedSessions + current.groupedSessions.flatMap { it.sessions }

        // Toggle isPinned for the target item
        val updatedItems = allItems.map {
            if (it.id == id) it.copy(isPinned = !it.isPinned) else it
        }

        // Rebuild pinned and grouped lists from scratch
        val newPinned = updatedItems.filter { it.isPinned }.sortedByDescending { it.lastActiveTime }
        val rest = updatedItems.filter { !it.isPinned }
        val newGrouped = rest.groupBy { it.projectPath }.map {
            SessionGroup(path = it.key, sessions = sortHierarchically(it.value))
        }.sortedBy { it.path }

        _uiState.value = current.copy(
            groupedSessions = newGrouped,
            pinnedSessions = newPinned
        )

        // Persist to DataStore
        viewModelScope.launch {
            settingsDataStore.togglePinnedId(id)
        }
    }
}
