import { getContentType } from "./contentType.js";
import { sessionLogger } from "./logger.js";
import type { ServerMessage } from "./protocol.js";
import { resolveUnifiedPath } from "./pathResolver.js";

/**
 * Helpers for file produce/capture, truncation and notification.
 * Keeps pending read/write path maps and composes file_available messages.
 */
export function createFileHelpers(
  cwd: string,
  getRegisterFn: () => ((id: string, filePath: string) => void) | null,
  getSend: () => ((msg: ServerMessage) => void) | null,
  getSessionId: () => string,
  getSessionName: () => string
) {
  const pendingReadPaths: Map<string, string> = new Map();
  const pendingWriteEditPaths: Map<string, string> = new Map();

  function truncateToolOutput(text: string): string {
    const LIMIT = 4096;
    if (text.length <= LIMIT) return text;
    const kb = ((text.length - LIMIT) / 1024).toFixed(1);
    return text.slice(0, LIMIT) + `\n…[truncated ${kb} KB, full in history]`;
  }

  async function detectAndNotifyFile(
    toolName: string,
    outputText: string,
    explicitPath?: string,
    opts: { notify?: boolean } = {}
  ): Promise<void> {
    let filePath: string | null = null;

    if (explicitPath) {
      filePath = resolveUnifiedPath(cwd, explicitPath, getSessionId(), getSessionName());
    } else if (toolName === "write") {
      const match = outputText.match(/(?:wrote\s+\d+\s+bytes?\s+to\s+)(.+)$/m);
      if (match) {
        filePath = resolveUnifiedPath(cwd, match[1].trim(), getSessionId(), getSessionName());
      }
    } else if (toolName === "edit") {
      const match = outputText.match(/(?:replaced\s+\d+\s+block.*?\s+in\s+)(.+)$/m);
      if (match) {
        filePath = resolveUnifiedPath(cwd, match[1].trim(), getSessionId(), getSessionName());
      }
    }

    if (!filePath) {
      sessionLogger(getSessionId() || getSessionName()).warn(
        { toolName, outputPreview: outputText.slice(0, 160) },
        "[file-notify] produced no path"
      );
      return;
    }

    try {
      const { stat, readFile } = await import("node:fs/promises");
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return;

      const size = fileStat.size;
      if (size === 43) {
        try {
          const head = await readFile(filePath, "utf-8");
          if (head.includes("PLACEHOLDER_WILL_BE_OVERWRITTEN_WITH_BINARY")) {
            sessionLogger(getSessionId() || getSessionName()).warn(
              { filePath, size },
              "[file-notify] placeholder detected — skip file_available, wait for bash cp/base64"
            );
            const idPlaceholder = Buffer.from(filePath).toString("hex");
            getRegisterFn()?.(idPlaceholder, filePath);
            try {
              const altPlace = filePath.replace(/\\/g, "/");
              if (altPlace !== filePath) getRegisterFn()?.(Buffer.from(altPlace).toString("hex"), filePath);
            } catch {}
            return;
          }
        } catch {}
      }

      const filename = filePath.split(/[\\/]/).pop() || "file";
      const content_type = getContentType(filename);
      const id = Buffer.from(filePath).toString("hex");

      getRegisterFn()?.(id, filePath);
      try {
        const alt = filePath.replace(/\\/g, "/");
        if (alt !== filePath) getRegisterFn()?.(Buffer.from(alt).toString("hex"), filePath);
      } catch {}

      sessionLogger(getSessionId() || getSessionName()).info(
        { filePath, id, size, content_type },
        "[file-notify] file_available registered (helpers)"
      );

      if (opts.notify === false) return;

      const send = getSend();
      if (send) {
        send({
          type: "file_available",
          id,
          name: filename,
          size,
          content_type,
        });
      }
    } catch (e) {
      sessionLogger(getSessionId() || getSessionName()).warn(
        { err: e, filePath },
        "[file-notify] stat/read failed (helpers)"
      );
    }
  }

  return {
    pendingReadPaths,
    pendingWriteEditPaths,
    truncateToolOutput,
    detectAndNotifyFile,
  };
}
