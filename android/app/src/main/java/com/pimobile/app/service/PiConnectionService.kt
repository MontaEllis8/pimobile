package com.pimobile.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.pimobile.app.MainActivity
import com.pimobile.app.R

/**
 * Foreground service that keeps the app process alive at FOREGROUND_SERVICE
 * priority so that Doze does not freeze the WebSocket on lock-screen.
 *
 * P0-5 A3 fix: Android 15 (targetSdk 35) enforces 6h timeout for dataSync FGS.
 * Implemented onTimeout() to stop gracefully + show "paused" notification.
 * Also adds contentIntent (tap returns to app) and POST_NOTIFICATIONS fallback.
 */
class PiConnectionService : Service() {

    companion object {
        private const val CHANNEL_ID = "pi_connection"
        private const val NOTIFICATION_ID = 1
        private const val TIMEOUT_NOTIFICATION_ID = 2
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        // POST_NOTIFICATIONS 被拒时仍需尝试前台，但捕获 SecurityException 降级
        try {
            startForeground(NOTIFICATION_ID, buildNotification())
        } catch (e: SecurityException) {
            // Android 13+ 通知权限被拒：无通知运行降级，避免崩溃（P0-5）
            // FGS 仍可运行，但用户看不到保活横幅；日志提示
            android.util.Log.w("PiConnectionService", "POST_NOTIFICATIONS denied, running without foreground notification", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Android 15 dataSync 6h 超时合规 (P0-5 A3) ──
    override fun onTimeout(startId: Int) {
        handleTimeout(startId)
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        handleTimeout(startId)
    }

    private fun handleTimeout(startId: Int) {
        android.util.Log.w("PiConnectionService", "dataSync FGS timeout (6h) reached, stopping service startId=$startId")
        // 显示“已暂停”通知，带点击回 app
        try {
            val nm = getSystemService(NotificationManager::class.java)
            // 复用同 channel，IMPORTANCE_LOW 仍可见于通知栏
            val paused = buildTimeoutNotification()
            // 权限被拒时 notify 会抛 SecurityException，捕获降级
            try {
                nm.notify(TIMEOUT_NOTIFICATION_ID, paused)
            } catch (e: SecurityException) {
                android.util.Log.w("PiConnectionService", "cannot show timeout notification (permission denied)", e)
            }
        } catch (e: Exception) {
            android.util.Log.e("PiConnectionService", "failed to show timeout notification", e)
        }
        stopSelf(startId)
        // 若仍需保活，由 WorkManager 或用户下次打开 app 重启；此处不自拉
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "连接保活",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "保持 Pi Mobile 与服务端的连接"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Pi Mobile")
            .setContentText("连接保活中")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun buildTimeoutNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Pi Mobile")
            .setContentText("连接保活已暂停（超过 6 小时）— 点击返回应用可恢复")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
