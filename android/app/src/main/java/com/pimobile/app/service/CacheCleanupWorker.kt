package com.pimobile.app.service

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.File

/**
 * B6: 7天过期缓存清理 — 扫描 externalCache/pi-files 与 cache/pi-files，
 * 删除 lastModified < 7天的旧文件，避免 pi-files 无限增长。
 */
class CacheCleanupWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        try {
            val expiryMs = 7L * 24 * 60 * 60 * 1000
            val cutoff = System.currentTimeMillis() - expiryMs
            var deleted = 0
            var scanned = 0

            val roots = listOfNotNull(
                applicationContext.externalCacheDir,
                applicationContext.cacheDir,
            )

            for (root in roots) {
                val piFiles = File(root, "pi-files")
                if (!piFiles.exists()) continue
                // 递归扫描所有 session 子目录
                val files = piFiles.walkTopDown().filter { it.isFile }
                for (f in files) {
                    scanned++
                    try {
                        if (f.lastModified() < cutoff) {
                            if (f.delete()) deleted++
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to delete $f", e)
                    }
                }
                // 清理空 session 目录
                piFiles.listFiles()?.forEach { sessionDir ->
                    if (sessionDir.isDirectory && sessionDir.listFiles()?.isEmpty() == true) {
                        sessionDir.delete()
                    }
                }
            }

            Log.d(TAG, "Cache cleanup: scanned=$scanned deleted=$deleted cutoff=${java.util.Date(cutoff)}")
            return Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "Cache cleanup failed", e)
            return Result.failure()
        }
    }

    companion object {
        private const val TAG = "CacheCleanupWorker"
    }
}
