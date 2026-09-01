package com.pimobile.app

import android.app.Application
import android.content.Intent
import android.os.Build
import android.util.Log
import com.pimobile.app.service.PiConnectionService
import com.pimobile.app.ui.theme.ThemeState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class PiApplication : Application() {
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        AppContainer.init(this)
        // P1-2 + P2-7: single process-level startup coroutine. Reads DataStore
        // ONCE for both the theme (P1-2) and the auto-connect settings (P2-7),
        // in order, rather than firing two concurrent DataStore reads with
        // their own races.
        //
        // P2-7 specifically: the only auto-connect previously lived in
        // ChatViewModel.init (Activity-scoped). If the system restarted the
        // foreground service via START_STICKY without an Activity on screen —
        // e.g. after a low-memory kill — AppContainer rebuilt the repository
        // but nothing called connect(), so the service was "running" while the
        // WebSocket stayed dead. Moving auto-connect here to the process scope
        // means the socket reconnects regardless of UI state.
        appScope.launch {
            val ds = AppContainer.settingsDataStore
            // Restore theme before first composition (no dark flash on light users).
            ThemeState.isDarkTheme.value = ds.isDarkTheme.first()
            // Auto-connect if server settings are configured. Wrapped so a bad
            // address / IO error can never crash onCreate (which would kill the
            // whole process and the foreground service with it).
            try {
                val address = ds.serverAddress.first()
                val token = ds.authToken.first()
                if (address.isNotBlank()) {
                    AppContainer.repository.connect(address, token)
                }
            } catch (e: Exception) {
                Log.e("PiApplication", "auto-connect failed on startup", e)
            }
        }
        // Start foreground service to keep the process at FOREGROUND_SERVICE priority
        // so the WebSocket survives lock-screen/Doze. minSdk is 26 (O) so
        // startForegroundService is always available, but guard for safety.
        val intent = Intent(this, PiConnectionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }
}
