package com.pimobile.app.data

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * FileDownloader — extracted from PiRepository (C1 God Object split).
 *
 * Owns HTTP download logic. PiRepository remains facade and delegates via
 * fileDownloader.downloadFile(...).
 */
class FileDownloader(
    private val appContext: Context,
    private val getBaseUrl: () -> String,
    private val getSessionId: () -> String,
    private val scope: CoroutineScope
) {
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    companion object {
        private const val TAG = "FileDownloader"
    }

    fun downloadFile(id: String, filename: String = "download", onDownloaded: (File) -> Unit = {}) {
        scope.launch(Dispatchers.IO) {
            try {
                val baseUrl = getBaseUrl()
                val url = "$baseUrl/files/$id"
                Log.d(TAG, "downloadFile: GET $url (filename=$filename, idLen=${id.length}, idPrefix=${id.take(20)})")
                val request = Request.Builder().url(url).build()
                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    val msg = "Download failed: HTTP ${response.code} for $filename"
                    Log.e(TAG, msg)
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }
                val body = response.body ?: run {
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(appContext, "Download: empty body for $filename", android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }
                val sessionId = getSessionId().ifBlank { "default" }
                val safeSessionId = sessionId.replace(Regex("""[<>:"/\\|?*]"""), "_")
                val cacheDir = File(appContext.externalCacheDir ?: appContext.cacheDir, "pi-files/$safeSessionId")
                cacheDir.mkdirs()
                val safeName = run {
                    val raw = filename.ifBlank { "download" }
                    raw.replace(Regex("""[<>:"/\\|?*]"""), "_")
                        .replace(Regex("""\.\.+"""), "_")
                        .trimStart('.', '/')
                        .ifBlank { "download" }
                }
                val outFile = File(cacheDir, safeName)
                if (!outFile.canonicalPath.startsWith(cacheDir.canonicalPath)) {
                    val msg = "Download rejected: filename escapes cache dir ($filename)"
                    Log.e(TAG, msg)
                    withContext(Dispatchers.Main) {
                        android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                }
                if (outFile.exists()) outFile.delete()
                outFile.outputStream().use { output ->
                    body.byteStream().use { input -> input.copyTo(output) }
                }
                Log.d(TAG, "downloadFile saved: ${outFile.absolutePath} (${outFile.length()} bytes)")
                withContext(Dispatchers.Main) {
                    onDownloaded(outFile)
                }
            } catch (e: Exception) {
                val msg = "Download error: ${e.message}"
                Log.e(TAG, msg)
                withContext(Dispatchers.Main) {
                    android.widget.Toast.makeText(appContext, msg, android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
}
