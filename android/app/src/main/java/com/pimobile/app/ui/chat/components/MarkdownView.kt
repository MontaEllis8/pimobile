package com.pimobile.app.ui.chat.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Divider
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.clickable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.window.Dialog
import coil.request.ImageRequest
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pimobile.app.ui.theme.LocalAppColors
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableBody
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Image
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser
import coil.compose.AsyncImage

/**
 * MarkdownView rendered via commonmark-java AST.
 * Replaces the hand-rolled line scanner (320 lines) with a spec-compliant parser.
 * Supports: headings, bold/italic, lists, code blocks, inline code, links, tables, thematic breaks.
 */
@Composable
fun MarkdownView(
    text: String,
    modifier: Modifier = Modifier
) {
    val colors = LocalAppColors.current
    if (text.isBlank()) return

    // Parser with GFM tables extension. Remembered per composition, reparsed only when text changes.
    val parser = remember {
        Parser.builder()
            .extensions(listOf(TablesExtension.create()))
            .build()
    }
    val document = remember(text, parser) { parser.parse(text) }

    // Fast path: empty document -> plain text
    if (document.firstChild == null) {
        Text(
            text = text,
            color = colors.textPrimary,
            fontSize = 14.sp,
            lineHeight = 20.sp,
            modifier = modifier
        )
        return
    }

    Column(modifier = modifier) {
        var node: Node? = document.firstChild
        while (node != null) {
            when (node) {
                is Heading -> {
                    MarkdownHeading(node, colors)
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is Paragraph -> {
                    MarkdownParagraph(node, colors)
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is BulletList -> {
                    MarkdownBulletList(node, colors)
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is OrderedList -> {
                    MarkdownOrderedList(node, colors)
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is FencedCodeBlock -> {
                    CodeBlockView(
                        code = node.literal ?: "",
                        language = node.info ?: "",
                        colors = colors
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is IndentedCodeBlock -> {
                    CodeBlockView(
                        code = node.literal ?: "",
                        language = "",
                        colors = colors
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is ThematicBreak -> {
                    HorizontalDivider(
                        color = colors.outlineVariant,
                        modifier = Modifier.padding(vertical = 4.dp)
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                }
                is BlockQuote -> {
                    MarkdownBlockQuote(node, colors)
                    Spacer(modifier = Modifier.height(8.dp))
                }
                is TableBlock -> {
                    MarkdownTable(node, colors)
                    Spacer(modifier = Modifier.height(8.dp))
                }
                else -> {
                    // Fallback: render its literal or children as paragraph
                    val fallback = nodeToPlainText(node)
                    if (fallback.isNotBlank()) {
                        Text(
                            text = fallback,
                            color = colors.textPrimary,
                            fontSize = 14.sp,
                            lineHeight = 20.sp
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                    }
                }
            }
            node = node.next
        }
    }
}

@Composable
private fun MarkdownHeading(node: Heading, colors: com.pimobile.app.ui.theme.AppColors) {
    val level = node.level
    val fontSize = when (level) {
        1 -> 20.sp
        2 -> 17.sp
        else -> 15.sp
    }
    val annotated = buildInlineAnnotatedString(node, colors)
    val uriHandler = LocalUriHandler.current
    ClickableText(
        text = annotated,
        style = androidx.compose.ui.text.TextStyle(
            fontSize = fontSize,
            fontWeight = FontWeight.Bold,
            color = colors.textPrimary,
            lineHeight = (fontSize.value * 1.4).sp
        ),
        onClick = { offset ->
            annotated.getStringAnnotations("URL", offset, offset).firstOrNull()?.let {
                try { uriHandler.openUri(it.item) } catch (_: Exception) {}
            }
        }
    )
}

@Composable
private fun MarkdownParagraph(node: Paragraph, colors: com.pimobile.app.ui.theme.AppColors) {
    val annotated = buildInlineAnnotatedString(node, colors)
    val uriHandler = LocalUriHandler.current
    // Collect Image nodes for inline preview (data:image / https)
    val imageDests = mutableListOf<Pair<String,String>>() // dest to alt
    var n: Node? = node.firstChild
    while (n != null) {
        if (n is Image) {
            val dest = n.destination ?: ""
            val alt = (n.firstChild as? Text)?.literal ?: ""
            if (dest.startsWith("data:image") || dest.startsWith("http://") || dest.startsWith("https://")) {
                imageDests.add(dest to alt)
            }
        }
        n = n.next
    }
    Column {
        ClickableText(
            text = annotated,
            style = androidx.compose.ui.text.TextStyle(
                fontSize = 14.sp,
                lineHeight = 20.sp,
                color = colors.textPrimary
            ),
            onClick = { offset ->
                annotated.getStringAnnotations("URL", offset, offset).firstOrNull()?.let {
                    try { uriHandler.openUri(it.item) } catch (_: Exception) {}
                }
            }
        )
        imageDests.forEach { (dest, alt) ->
            var showDialog by remember(dest) { mutableStateOf(false) }
            Spacer(modifier = Modifier.height(6.dp))
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(dest).crossfade(true).build(),
                contentDescription = alt.ifBlank { "image" },
                modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp).clip(RoundedCornerShape(8.dp)).clickable { showDialog = true },
                contentScale = ContentScale.Crop
            )
            if (showDialog) {
                Dialog(onDismissRequest = { showDialog = false }) {
                    Box(modifier = Modifier.fillMaxWidth().wrapContentHeight().background(colors.surfaceColor, RoundedCornerShape(12.dp)).padding(8.dp)) {
                        AsyncImage(
                            model = dest,
                            contentDescription = alt,
                            modifier = Modifier.fillMaxWidth().wrapContentHeight(),
                            contentScale = ContentScale.Fit
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownBulletList(node: BulletList, colors: com.pimobile.app.ui.theme.AppColors) {
    Column {
        var item: Node? = node.firstChild
        while (item != null) {
            if (item is ListItem) {
                Row(modifier = Modifier.padding(start = 8.dp, bottom = 2.dp)) {
                    Text("•", fontSize = 14.sp, color = colors.textSecondary)
                    Spacer(modifier = Modifier.width(8.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        renderListItemContent(item, colors)
                    }
                }
                Spacer(modifier = Modifier.height(2.dp))
            }
            item = item.next
        }
    }
}

@Composable
private fun MarkdownOrderedList(node: OrderedList, colors: com.pimobile.app.ui.theme.AppColors) {
    Column {
        var index = node.startNumber
        var item: Node? = node.firstChild
        while (item != null) {
            if (item is ListItem) {
                Row(modifier = Modifier.padding(start = 8.dp, bottom = 2.dp)) {
                    Text("$index.", fontSize = 14.sp, color = colors.textSecondary)
                    Spacer(modifier = Modifier.width(8.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        renderListItemContent(item, colors)
                    }
                }
                index++
                Spacer(modifier = Modifier.height(2.dp))
            }
            item = item.next
        }
    }
}

@Composable
private fun renderListItemContent(item: ListItem, colors: com.pimobile.app.ui.theme.AppColors) {
    // ListItem typically contains Paragraph(s) or other blocks
    var child: Node? = item.firstChild
    var first = true
    while (child != null) {
        when (child) {
            is Paragraph -> {
                // Single paragraph list item -> inline render
                val annotated = buildInlineAnnotatedString(child, colors)
                val uriHandler = LocalUriHandler.current
                ClickableText(
                    text = annotated,
                    style = androidx.compose.ui.text.TextStyle(
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        color = colors.textPrimary
                    ),
                    onClick = { offset ->
                        annotated.getStringAnnotations("URL", offset, offset).firstOrNull()?.let {
                            try { uriHandler.openUri(it.item) } catch (_: Exception) {}
                        }
                    }
                )
            }
            is FencedCodeBlock -> {
                if (!first) Spacer(modifier = Modifier.height(4.dp))
                CodeBlockView(code = child.literal ?: "", language = child.info ?: "", colors = colors)
            }
            is BulletList -> MarkdownBulletList(child, colors)
            is OrderedList -> MarkdownOrderedList(child, colors)
            else -> {
                val txt = nodeToPlainText(child)
                if (txt.isNotBlank()) {
                    Text(txt, fontSize = 14.sp, color = colors.textPrimary, lineHeight = 20.sp)
                }
            }
        }
        first = false
        child = child.next
    }
}

@Composable
private fun MarkdownBlockQuote(node: BlockQuote, colors: com.pimobile.app.ui.theme.AppColors) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.surfaceContainer, RoundedCornerShape(8.dp))
            .border(1.dp, colors.outlineVariant, RoundedCornerShape(8.dp))
            .padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 8.dp)
    ) {
        var child: Node? = node.firstChild
        while (child != null) {
            when (child) {
                is Paragraph -> MarkdownParagraph(child, colors)
                is Heading -> MarkdownHeading(child, colors)
                is BulletList -> MarkdownBulletList(child, colors)
                is OrderedList -> MarkdownOrderedList(child, colors)
                else -> {
                    val txt = nodeToPlainText(child)
                    if (txt.isNotBlank()) Text(txt, fontSize = 14.sp, color = colors.textSecondary)
                }
            }
            child = child.next
        }
    }
}

@Composable
private fun MarkdownTable(node: TableBlock, colors: com.pimobile.app.ui.theme.AppColors) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, colors.outlineVariant, RoundedCornerShape(8.dp))
            .horizontalScroll(rememberScrollState())
    ) {
        var section: Node? = node.firstChild
        var isFirstSection = true
        while (section != null) {
            when (section) {
                is TableHead, is TableBody -> {
                    var row: Node? = section.firstChild
                    while (row != null) {
                        if (row is TableRow) {
                            val isHeader = section is TableHead
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(
                                        if (isHeader) colors.surfaceContainer else colors.surfaceColor
                                    )
                                    .padding(vertical = 6.dp)
                            ) {
                                var cell: Node? = row.firstChild
                                while (cell != null) {
                                    if (cell is TableCell) {
                                        val cellText = buildInlineAnnotatedString(cell, colors)
                                        val uriHandler = LocalUriHandler.current
                                        Box(
                                            modifier = Modifier
                                                .weight(1f)
                                                .padding(horizontal = 8.dp)
                                        ) {
                                            ClickableText(
                                                text = cellText,
                                                style = androidx.compose.ui.text.TextStyle(
                                                    fontSize = 13.sp,
                                                    fontWeight = if (isHeader) FontWeight.Bold else FontWeight.Normal,
                                                    color = colors.textPrimary,
                                                    lineHeight = 18.sp
                                                ),
                                                onClick = { offset ->
                                                    cellText.getStringAnnotations("URL", offset, offset).firstOrNull()?.let {
                                                        try { uriHandler.openUri(it.item) } catch (_: Exception) {}
                                                    }
                                                }
                                            )
                                        }
                                    }
                                    cell = cell.next
                                }
                            }
                            HorizontalDivider(color = colors.outlineVariant, thickness = 0.5.dp)
                        }
                        row = row.next
                    }
                    // Divider between head and body
                    if (isFirstSection && section is TableHead) {
                        HorizontalDivider(color = colors.outlineVariant, thickness = 1.dp)
                    }
                    isFirstSection = false
                }
            }
            section = section.next
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

// ── Inline helpers ──

@Composable
private fun buildInlineAnnotatedString(node: Node, colors: com.pimobile.app.ui.theme.AppColors): AnnotatedString {
    // colors needed for link color
    return buildAnnotatedString {
        appendInlines(node, colors)
    }
}

private fun AnnotatedString.Builder.appendInlines(node: Node, colors: com.pimobile.app.ui.theme.AppColors) {
    var child: Node? = node.firstChild
    while (child != null) {
        when (child) {
            is Text -> append(child.literal)
            is Code -> {
                // Inline code: monospace + subtle background
                withStyle(
                    SpanStyle(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        background = colors.surfaceContainer,
                        color = colors.textPrimary
                    )
                ) {
                    append(" ${child.literal} ")
                }
            }
            is StrongEmphasis -> {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = colors.textPrimary)) {
                    appendInlines(child, colors)
                }
            }
            is Emphasis -> {
                withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = colors.textPrimary)) {
                    appendInlines(child, colors)
                }
            }
            is Link -> {
                val dest = child.destination ?: ""
                pushStringAnnotation("URL", dest)
                withStyle(
                    SpanStyle(
                        color = colors.primaryAccent,
                        textDecoration = TextDecoration.Underline
                    )
                ) {
                    appendInlines(child, colors)
                }
                pop()
            }
            is Image -> {
                val dest = child.destination ?: ""
                if (dest.startsWith("data:image")) {
                    val kb = dest.length / 1024
                    withStyle(SpanStyle(color = colors.primaryAccent, fontStyle = FontStyle.Italic)) {
                        append("[图片 ${kb}KB]")
                    }
                } else {
                    val altFromChild = child.firstChild?.let { (it as? Text)?.literal } ?: ""
                    val display = altFromChild.ifBlank { dest.take(30) }
                    if (dest.isNotBlank()) pushStringAnnotation("URL", dest)
                    withStyle(
                        SpanStyle(
                            color = colors.primaryAccent,
                            textDecoration = TextDecoration.Underline
                        )
                    ) {
                        append(display.ifBlank { "[图片]" })
                    }
                    if (dest.isNotBlank()) pop()
                }
            }
            is SoftLineBreak -> append(" ")
            is HardLineBreak -> append("\n")
            else -> {
                // For unknown inline wrappers, recurse
                if (child.firstChild != null) {
                    appendInlines(child, colors)
                } else {
                    val txt = nodeToPlainText(child)
                    if (txt.isNotBlank()) append(txt)
                }
            }
        }
        child = child.next
    }
}

private fun nodeToPlainText(node: Node): String {
    // Fallback plain text extraction for unexpected block types
    val sb = StringBuilder()
    var child: Node? = node.firstChild
    if (child == null) {
        // Leaf node like Text
        if (node is Text) return node.literal ?: ""
        if (node is Code) return node.literal ?: ""
        return ""
    }
    while (child != null) {
        when (child) {
            is Text -> sb.append(child.literal)
            is Code -> sb.append(child.literal)
            is SoftLineBreak -> sb.append(" ")
            is HardLineBreak -> sb.append("\n")
            else -> {
                if (child.firstChild != null) sb.append(nodeToPlainText(child))
            }
        }
        child = child.next
    }
    return sb.toString()
}
