package com.pimobile.app

import android.app.Application
import com.pimobile.app.data.PiRepository
import com.pimobile.app.data.SettingsDataStore

/**
 * AppContainer — simple manual DI container.
 * Provides singleton instances accessible throughout the app.
 */
object AppContainer {
    private var _repository: PiRepository? = null
    private var _settingsDataStore: SettingsDataStore? = null

    val repository: PiRepository
        get() = _repository ?: throw IllegalStateException("AppContainer not initialized")

    val settingsDataStore: SettingsDataStore
        get() = _settingsDataStore ?: throw IllegalStateException("AppContainer not initialized")

    /**
     * Initialize the container with the Application context.
     * Must be called once from Application.onCreate(). Idempotent:
     * subsequent calls are no-ops so Activity recreations never rebuild
     * the repository / WebSocket connection.
     */
    fun init(app: Application) {
        if (_repository != null) return
        _settingsDataStore = SettingsDataStore(app)
        _repository = PiRepository(app)
    }
}
