package com.pimobile.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.json.JSONException

/**
 * QA-11: PiMessageParser 全容错路径测试。
 *
 * 覆盖 P2-3 承诺：所有字段读取走 optXxx + 默认值——缺字段/类型错必须返回
 * 默认值而绝不抛 JSONException 把整条消息降级成 ErrorMessage。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PiMessageParserTest {

    // ── text_chunk / thinking_chunk ──

    @Test
    fun `text_chunk with text`() {
        val msg = PiMessageParser.parse("""{"type":"text_chunk","text":"hello"}""")
        assertEquals(TextChunk("hello"), msg)
    }

    @Test
    fun `text_chunk missing text defaults to empty`() {
        val msg = PiMessageParser.parse("""{"type":"text_chunk"}""")
        assertEquals(TextChunk(""), msg)
    }

    @Test
    fun `text_chunk null text defaults to empty`() {
        val msg = PiMessageParser.parse("""{"type":"text_chunk","text":null}""")
        assertEquals(TextChunk(""), msg)
    }

    @Test
    fun `thinking_chunk missing text defaults to empty`() {
        val msg = PiMessageParser.parse("""{"type":"thinking_chunk"}""")
        assertEquals(ThinkingChunk(""), msg)
    }

    // ── tool_start / tool_output ──

    @Test
    fun `tool_start missing fields uses defaults`() {
        val msg = PiMessageParser.parse("""{"type":"tool_start"}""") as ToolStartMessage
        assertEquals("", msg.tool_id)
        assertEquals("", msg.tool_name)
        assertEquals("{}", msg.input)
    }

    @Test
    fun `tool_output missing status defaults to running`() {
        val msg = PiMessageParser.parse("""{"type":"tool_output","tool_id":"t1"}""") as ToolOutputMessage
        assertEquals("t1", msg.tool_id)
        assertEquals("running", msg.status)
    }

    // ── state_update（cost 缺失必须零值，不抛） ──

    @Test
    fun `state_update missing cost defaults to zeroed CostInfo`() {
        val msg = PiMessageParser.parse("""{"type":"state_update","context_window":100,"message_count":5}""")
        assertTrue(msg is StateUpdate)
        msg as StateUpdate
        assertEquals(0, msg.cost.input)
        assertEquals(0, msg.cost.output)
        assertEquals(0, msg.cost.total)
        assertEquals(100, msg.context_window)
        assertEquals(5, msg.message_count)
        assertNull(msg.context_usage)
    }

    @Test
    fun `state_update null cost object does not throw`() {
        val msg = PiMessageParser.parse("""{"type":"state_update","cost":null}""")
        assertTrue(msg is StateUpdate)
        assertEquals(0, (msg as StateUpdate).cost.total)
    }

    @Test
    fun `state_update full fields parsed`() {
        val msg = PiMessageParser.parse(
            """{"type":"state_update","cost":{"input":10,"output":20,"total":30},"context_window":2000,"message_count":42,"thinking_level":"medium","context_usage":{"tokens":800,"context_window":2000,"percent":40}}"""
        ) as StateUpdate
        assertEquals(30, msg.cost.total)
        assertEquals("medium", msg.thinking_level)
        assertEquals(800, msg.context_usage?.tokens)
        assertEquals(40, msg.context_usage?.percent)
    }

    // ── session_list（缺失/空数组 → 空列表，不抛） ──

    @Test
    fun `session_list missing sessions returns empty list`() {
        val msg = PiMessageParser.parse("""{"type":"session_list"}""")
        assertTrue(msg is SessionList)
        assertTrue((msg as SessionList).sessions.isEmpty())
    }

    @Test
    fun `session_list empty array returns empty list`() {
        val msg = PiMessageParser.parse("""{"type":"session_list","sessions":[]}""")
        assertTrue(msg is SessionList)
        assertTrue((msg as SessionList).sessions.isEmpty())
    }

    @Test
    fun `session_list with entry parses all fields`() {
        val msg = PiMessageParser.parse(
            """{"type":"session_list","sessions":[{"session_id":"abc","name":"Demo","current":true,"msg_count":7,"project":"/p","status":"active","last_active":123,"parent_session":"parent-1"}]}"""
        ) as SessionList
        assertEquals(1, msg.sessions.size)
        val s = msg.sessions[0]
        assertEquals("abc", s.session_id)
        assertEquals("Demo", s.name)
        assertEquals(true, s.current)
        assertEquals(7, s.msg_count)
        assertEquals("active", s.status)
        assertEquals("parent-1", s.parent_session)
    }

    @Test
    fun `session_list missing session_id falls back to name`() {
        val msg = PiMessageParser.parse(
            """{"type":"session_list","sessions":[{"name":"NoId"}]}"""
        ) as SessionList
        assertEquals("NoId", msg.sessions[0].session_id)
    }

    // ── session_switched（QS-09：session_id 可选） ──

    @Test
    fun `session_switched with session_id parses it`() {
        val msg = PiMessageParser.parse("""{"type":"session_switched","name":"Demo","session_id":"abc"}""")
        assertEquals(SessionSwitched("Demo", "abc"), msg)
    }

    @Test
    fun `session_switched without session_id keeps null`() {
        val msg = PiMessageParser.parse("""{"type":"session_switched","name":"Demo"}""")
        assertEquals(SessionSwitched("Demo", null), msg)
    }

    // ── error / file_available / message_history ──

    @Test
    fun `error message parsed`() {
        val msg = PiMessageParser.parse("""{"type":"error","message":"boom"}""")
        assertEquals(ErrorMessage("boom"), msg)
    }

    @Test
    fun `error missing message defaults`() {
        val msg = PiMessageParser.parse("""{"type":"error"}""")
        assertEquals(ErrorMessage("Unknown error"), msg)
    }

    @Test
    fun `file_available missing optional content_type`() {
        val msg = PiMessageParser.parse("""{"type":"file_available","id":"x","name":"f.txt","size":10}""")
        assertTrue(msg is FileAvailableMessage)
        assertEquals("f.txt", (msg as FileAvailableMessage).name)
        assertNull(msg.content_type)
    }

    @Test
    fun `message_history missing messages returns empty list`() {
        val msg = PiMessageParser.parse("""{"type":"message_history","name":"Demo"}""")
        assertTrue(msg is MessageHistory)
        assertTrue((msg as MessageHistory).messages.isEmpty())
    }

    @Test
    fun `message_history entries become maps`() {
        val msg = PiMessageParser.parse(
            """{"type":"message_history","name":"Demo","messages":[{"role":"user","text":"hi"}]}"""
        ) as MessageHistory
        assertEquals(1, msg.messages.size)
        val m0 = msg.messages[0] as Map<*, *>
        assertEquals("user", m0["role"])
        assertEquals("hi", m0["text"])
    }

    // ── 未知 type → UnknownMessage（P3-7，不是 ErrorMessage） ──

    @Test
    fun `unknown type maps to UnknownMessage not ErrorMessage`() {
        val msg = PiMessageParser.parse("""{"type":"totally_new_type","data":1}""")
        assertTrue(msg is UnknownMessage)
    }

    @Test
    fun `missing type maps to UnknownMessage`() {
        val msg = PiMessageParser.parse("""{"data":1}""")
        assertTrue(msg is UnknownMessage)
    }

    // ── 非法 JSON → 抛 JSONException（上层捕获转 ErrorMessage） ──

    @Test(expected = JSONException::class)
    fun `malformed json throws JSONException`() {
        PiMessageParser.parse("{not valid json")
    }
}
