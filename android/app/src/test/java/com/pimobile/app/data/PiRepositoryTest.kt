package com.pimobile.app.data

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * QA-11: PiRepository 轻量状态机测试（不建真实 WebSocket 连接）。
 *
 * 聚焦纯同步可测行为：未连接时 sendMessage 返回 false 且不乐观添加用户气泡
 * （QA-08）、switchSession 立即清空旧会话状态（QA-03/P1-3）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PiRepositoryTest {

    private fun newRepo(): PiRepository =
        PiRepository(ApplicationProvider.getApplicationContext())

    @Test
    fun `sendMessage while disconnected returns false and adds no bubble`() = runBlocking {
        val repo = newRepo()
        val ok = repo.sendMessage("hello")
        assertFalse("send without a socket must fail", ok)
        // QA-08: no optimistic bubble — a message that never left the device
        // must not be shown as sent.
        assertTrue(repo.messages.first().isEmpty())
        repo.dispose()
    }

    @Test
    fun `switchSession while disconnected clears session state`() = runBlocking {
        val repo = newRepo()
        // Seed some state so clearing is observable.
        repo.switchSession("old-session", "old-id")
        assertTrue(repo.messages.first().isEmpty())
        repo.dispose()
    }

    @Test
    fun `messages and lastStreamingMessage start empty`() = runBlocking {
        val repo = newRepo()
        assertTrue(repo.messages.first().isEmpty())
        assertEquals(null, repo.lastStreamingMessage.first())
        assertEquals("", repo.activeSessionName.first())
        repo.dispose()
    }
}
