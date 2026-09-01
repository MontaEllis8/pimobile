package com.pimobile.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray

/**
 * SettingsDataStore manages persistent app settings using DataStore Preferences.
 */
class SettingsDataStore(private val context: Context) {

    companion object {
        private val Context.dataStore: DataStore<Preferences> by preferencesDataStore("pi_settings")
        val KEY_SERVER_ADDRESS = stringPreferencesKey("server_address")
        val KEY_AUTH_TOKEN = stringPreferencesKey("auth_token")
        val KEY_DARK_THEME = booleanPreferencesKey("dark_theme")
        val KEY_PINNED_IDS = stringPreferencesKey("pinned_ids")
        val KEY_DEFAULT_CWD = stringPreferencesKey("default_cwd")
        val KEY_EXPANDED_GROUPS = stringPreferencesKey("expanded_groups")
        val KEY_GROUPS_INITIALIZED = booleanPreferencesKey("groups_initialized")

        /**
         * P3-6/QA-05: sets were stored comma-separated, which silently breaks
         * when a value contains a comma (e.g. a path like "a,b/c"). New values
         * are stored as JSON arrays; old comma-separated values are still read
         * (migrated lazily on the next write).
         */
        private fun decodeSet(raw: String?): Set<String> {
            if (raw.isNullOrBlank()) return emptySet()
            if (raw.startsWith("[")) {
                return try {
                    val arr = JSONArray(raw)
                    buildSet {
                        for (i in 0 until arr.length()) {
                            val v = arr.optString(i)
                            if (v.isNotBlank()) add(v)
                        }
                    }
                } catch (_: Exception) {
                    // Corrupt JSON — fall back to empty (do not lose old data path)
                    emptySet()
                }
            }
            // Legacy comma-separated format
            return raw.split(",").filter { it.isNotBlank() }.toSet()
        }

        private fun encodeSet(values: Set<String>): String {
            val arr = JSONArray()
            values.sorted().forEach { arr.put(it) }
            return arr.toString()
        }
    }

    val serverAddress: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_SERVER_ADDRESS] ?: ""
    }

    val authToken: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_AUTH_TOKEN] ?: ""
    }

    val isDarkTheme: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[KEY_DARK_THEME] ?: true  // Dark theme by default
    }

    val pinnedIds: Flow<Set<String>> = context.dataStore.data.map { prefs ->
        decodeSet(prefs[KEY_PINNED_IDS])
    }

    val defaultCwd: Flow<String> = context.dataStore.data.map { prefs ->
        prefs[KEY_DEFAULT_CWD] ?: ""
    }

    val expandedGroups: Flow<Set<String>> = context.dataStore.data.map { prefs ->
        decodeSet(prefs[KEY_EXPANDED_GROUPS])
    }

    val groupsInitialized: Flow<Boolean> = context.dataStore.data.map { prefs ->
        prefs[KEY_GROUPS_INITIALIZED] ?: false
    }

    suspend fun setServerAddress(address: String) {
        context.dataStore.edit { prefs ->
            prefs[KEY_SERVER_ADDRESS] = address
        }
    }

    suspend fun setAuthToken(token: String) {
        context.dataStore.edit { prefs ->
            prefs[KEY_AUTH_TOKEN] = token
        }
    }

    suspend fun setDarkTheme(isDark: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[KEY_DARK_THEME] = isDark
        }
    }

    suspend fun setDefaultCwd(cwd: String) {
        context.dataStore.edit { prefs ->
            prefs[KEY_DEFAULT_CWD] = cwd
        }
    }

    suspend fun togglePinnedId(id: String) {
        context.dataStore.edit { prefs ->
            val current = decodeSet(prefs[KEY_PINNED_IDS]).toMutableSet()
            if (id in current) current.remove(id) else current.add(id)
            prefs[KEY_PINNED_IDS] = encodeSet(current)
        }
    }

    suspend fun setExpandedGroups(groups: Set<String>) {
        context.dataStore.edit { prefs ->
            prefs[KEY_EXPANDED_GROUPS] = encodeSet(groups)
        }
    }

    suspend fun setGroupsInitialized(value: Boolean) {
        context.dataStore.edit { prefs ->
            prefs[KEY_GROUPS_INITIALIZED] = value
        }
    }
}
