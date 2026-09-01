package com.pimobile.app.ui.chat.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pimobile.app.ui.theme.LocalAppColors

/**
 * A simple Markdown view that renders text with:
 *   - Headings (# ## ###)
 *   - Lists (- * 1.)
 *   - Code blocks (```...```) with copy button
 *   - Inline code (`...`)
 *   - Bold (**...**) and italic (*...*)
 *   - Plain text paragraphs
 */
/**
 * Intermediate block types produced by the QA-06 line scanner.
 * Pure data — rendering happens separately so parsing stays composable-free.
 */
private sealed class MdBlock {
    data class Paragraph(val text: String) : MdBlock()
    data class Code(val code: String, val language: String) : MdBlock()
    data class InlineCode(val code: String) : MdBlock()
}

/**
 * QA-06: single-pass line scanner. The old version split on "\n\n" FIRST,
 * which tore apart blank lines inside code blocks (the fence state machine
 * never saw them — code with blank lines rendered wrong). Every line now flows
 * through the inCodeBlock state machine, so blank lines inside ``` blocks are
 * preserved verbatim, while blank lines outside still delimit paragraphs.
 */
private fun parseMarkdownBlocks(text: String): List<MdBlock> {
    val blocks = mutableListOf<MdBlock>()
    var inCodeBlock = false
    var codeLanguage = ""
    val codeBlockLines = mutableListOf<String>()
    val paragraphLines = mutableListOf<String>()

    fun flushParagraph() {
        if (paragraphLines.isNotEmpty()) {
            blocks.add(MdBlock.Paragraph(paragraphLines.joinToString("\n")))
            paragraphLines.clear()
        }
    }

    for (line in text.split("\n")) {
        val trimmedStart = line.trimStart()
        when {
            // Code block fence (start or end)
            trimmedStart.startsWith("```") -> {
                if (!inCodeBlock) {
                    flushParagraph()
                    inCodeBlock = true
                    codeBlockLines.clear()
                    codeLanguage = trimmedStart.removePrefix("```").trim()
                } else {
                    inCodeBlock = false
                    blocks.add(MdBlock.Code(codeBlockLines.joinToString("\n"), codeLanguage))
                }
            }
            // Inline code line
            trimmedStart.startsWith("`") && !inCodeBlock -> {
                flushParagraph()
                blocks.add(MdBlock.InlineCode(line.trim('`')))
            }
            // Inside code block — accumulate verbatim (blank lines included)
            inCodeBlock -> codeBlockLines.add(line)
            // Blank line outside code block → paragraph boundary
            line.isBlank() -> flushParagraph()
            // Normal paragraph line
            else -> paragraphLines.add(line)
        }
    }

    flushParagraph()

    // Unclosed code block
    if (inCodeBlock && codeBlockLines.isNotEmpty()) {
        blocks.add(MdBlock.Code(codeBlockLines.joinToString("\n"), codeLanguage))
    }
    return blocks
}

@Composable
fun MarkdownView(
    text: String,
    modifier: Modifier = Modifier
) {
    val colors = LocalAppColors.current

    val blocks = parseMarkdownBlocks(text)
    if (blocks.isEmpty()) {
        // No structural markdown (plain text without blank-line paragraphs)
        Text(
            text = text,
            color = colors.textPrimary,
            fontSize = 14.sp,
            lineHeight = 20.sp,
        )
        return
    }

    Column(modifier = modifier) {
        for (block in blocks) {
            when (block) {
                is MdBlock.Paragraph -> {
                    RenderParagraph(block.text, colors)
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is MdBlock.Code -> {
                    CodeBlockView(
                        code = block.code,
                        language = block.language,
                        colors = colors
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is MdBlock.InlineCode -> {
                    Text(
                        text = block.code,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        color = colors.codeBackground,
                        modifier = Modifier
                            .background(
                                colors.surfaceContainer,
                                RoundedCornerShape(4.dp)
                            )
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                }
            }
        }
    }
}

@Composable
private fun CodeBlockView(
    code: String,
    language: String,
    colors: com.pimobile.app.ui.theme.AppColors
) {
    val clipboardManager = LocalClipboardManager.current

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.codeBackground, RoundedCornerShape(8.dp))
            .padding(8.dp)
    ) {
        // Header with language label and copy button
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = language.ifEmpty { "code" },
                fontSize = 11.sp,
                color = colors.textSecondary,
                fontFamily = FontFamily.Monospace
            )
            IconButton(
                onClick = {
                    clipboardManager.setText(AnnotatedString(code))
                },
                modifier = Modifier.size(24.dp)
            ) {
                Icon(
                    Icons.Default.ContentCopy,
                    contentDescription = "Copy",
                    tint = colors.textSecondary,
                    modifier = Modifier.size(14.dp)
                )
            }
        }

        Spacer(modifier = Modifier.height(4.dp))

        // Code content
        SelectionContainer {
            Text(
                text = code,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = colors.textPrimary,
                lineHeight = 18.sp,
                modifier = Modifier.horizontalScroll(rememberScrollState())
            )
        }
    }
}

@Composable
private fun RenderParagraph(
    text: String,
    colors: com.pimobile.app.ui.theme.AppColors
) {
    val lines = text.split("\n")
    val firstLine = lines.first().trimStart()

    // Heading: # ## ###
    val headingMatch = Regex("^(#{1,3})\\s+(.+)\$").find(firstLine)
    if (headingMatch != null) {
        val level = headingMatch.groupValues[1].length
        val content = headingMatch.groupValues[2]
        RenderHeading(content, level, colors)
        return
    }

    // List: detect if any line starts with -/* or 1.
    val hasBulletList = lines.any { it.trimStart().startsWith("- ") || it.trimStart().startsWith("* ") }
    val hasNumberedList = lines.any { Regex("^\\d+\\.\\s").containsMatchIn(it.trimStart()) }

    if (hasBulletList || hasNumberedList) {
        RenderList(lines, colors)
        return
    }

    // Default: inline markdown
    RenderInlineMarkdown(text, colors)
}

@Composable
private fun RenderHeading(
    content: String,
    level: Int,
    colors: com.pimobile.app.ui.theme.AppColors
) {
    val fontSize = when (level) {
        1 -> 20.sp
        2 -> 17.sp
        else -> 15.sp
    }
    Text(
        text = content,
        fontSize = fontSize,
        fontWeight = FontWeight.Bold,
        color = colors.textPrimary,
        lineHeight = (fontSize.value * 1.4).sp
    )
}

@Composable
private fun RenderList(
    lines: List<String>,
    colors: com.pimobile.app.ui.theme.AppColors
) {
    val bulletPattern = Regex("^[-*]\\s+(.+)")
    val numberedPattern = Regex("^(\\d+)\\.\\s+(.+)")
    var numberIndex = 1

    Column {
        lines.forEach { line ->
            val trimmed = line.trimStart()
            when {
                bulletPattern.matches(trimmed) -> {
                    val match = bulletPattern.find(trimmed)!!
                    val content = match.groupValues[1]
                    Row(modifier = Modifier.padding(start = 8.dp)) {
                        Text("•", fontSize = 14.sp, color = colors.textSecondary)
                        Spacer(modifier = Modifier.width(8.dp))
                        RenderInlineMarkdown(content, colors)
                    }
                }
                numberedPattern.matches(trimmed) -> {
                    val match = numberedPattern.find(trimmed)!!
                    val num = match.groupValues[1]
                    val content = match.groupValues[2]
                    Row(modifier = Modifier.padding(start = 8.dp)) {
                        Text("$num.", fontSize = 14.sp, color = colors.textSecondary)
                        Spacer(modifier = Modifier.width(8.dp))
                        RenderInlineMarkdown(content, colors)
                    }
                    numberIndex = num.toIntOrNull()?.plus(1) ?: numberIndex + 1
                }
                else -> {
                    // Continuation line or non-list text — render as-is
                    RenderInlineMarkdown(trimmed, colors)
                }
            }
            Spacer(modifier = Modifier.height(2.dp))
        }
    }
}

@Composable
private fun RenderInlineMarkdown(
    text: String,
    colors: com.pimobile.app.ui.theme.AppColors
) {
    // Simple inline markdown: **bold**, *italic*
    val segments = mutableListOf<Pair<String, SpanStyle>>()
    var remaining = text
    val defaultColor = colors.textPrimary

    while (remaining.isNotEmpty()) {
        when {
            remaining.contains("**") -> {
                val start = remaining.indexOf("**")
                val end = remaining.indexOf("**", start + 2)
                if (start > 0) {
                    segments.add(remaining.substring(0, start) to SpanStyle(color = defaultColor))
                }
                if (end > start + 2) {
                    segments.add(
                        remaining.substring(start + 2, end) to SpanStyle(
                            fontWeight = FontWeight.Bold,
                            color = defaultColor
                        )
                    )
                    remaining = remaining.substring(end + 2)
                } else {
                    segments.add(remaining to SpanStyle(color = defaultColor))
                    remaining = ""
                }
            }
            remaining.contains("*") && !remaining.contains("**") -> {
                val start = remaining.indexOf("*")
                val end = remaining.indexOf("*", start + 1)
                if (start > 0) {
                    segments.add(remaining.substring(0, start) to SpanStyle(color = defaultColor))
                }
                if (end > start + 1) {
                    segments.add(
                        remaining.substring(start + 1, end) to SpanStyle(
                            fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                            color = defaultColor
                        )
                    )
                    remaining = remaining.substring(end + 1)
                } else {
                    segments.add(remaining to SpanStyle(color = defaultColor))
                    remaining = ""
                }
            }
            else -> {
                segments.add(remaining to SpanStyle(color = defaultColor))
                remaining = ""
            }
        }
    }

    val annotatedString = buildAnnotatedString {
        segments.forEach { (text, style) ->
            withStyle(style) { append(text) }
        }
    }

    Text(
        text = annotatedString,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    )
}
