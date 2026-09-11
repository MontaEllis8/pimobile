import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveUnifiedPath } from "./pathResolver.js";
import { getContentType } from "./contentType.js";
import { sessionLogger } from "./logger.js";
import { stat, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * L0+ — mobile_share_image: direct original-path share without write→D:/tmp copy.
 * id仍为 Buffer.from(abs).toString("hex")，复用 resolveUnifiedPath，不改 HMAC。
 */

const mobileShareSchema = Type.Object({
  path: Type.String({
    description:
      "Absolute path to the file to share, e.g. D:/worksave/10-pi/tmp/cv-real.png, D:/worksave/10-pi/output/report.pdf, D:/tmp/cv-mobile-1.png. If user said tmp/cv-real or cv-real without extension, expand to D:/worksave/10-pi/tmp/cv-real.png (try .png/.jpg/.pdf). Do NOT use /tmp bare — use D:/tmp or absolute under D:/worksave/10-pi.",
  }),
  caption: Type.Optional(
    Type.String({ description: "Optional short caption to show alongside the file card" })
  ),
});

const TOOL_DESCRIPTION = [
  "Share any local file to the user's phone as a downloadable OPEN card (file_available).",
  "Use this IMMEDIATELY when the user asks to share/send/show an image, photo, picture, screenshot, PDF, HTML or any file —",
  "including Chinese: 发图片, 发个图, 来张图, 发一下图, 发tmp图, 来张cv-real, 把图发我, 发文件, 来份pdf, 发图, 看图 etc.,",
  "and English: share image, send image, send file, show picture.",
  "You MUST call this tool instead of just describing the path in text or copying via write.",
  "Do NOT copy the file to D:/tmp with write — share the original absolute path directly via this tool.",
  "If the user gives a short name like tmp/cv-real or cv-real without extension, expand to D:/worksave/10-pi/tmp/cv-real.png (try .png, .jpg, .jpeg, .webp, .pdf, .html).",
  "If the exact file is unclear, first run bash: ls D:/worksave/10-pi/tmp && ls D:/tmp && ls D:/worksave/10-pi/output, then call this tool with the best match.",
  "Supported absolute roots: D:/worksave/10-pi/tmp/*, D:/tmp/*, D:/worksave/10-pi/output/*, D:/worksave/10-pi/* .",
  "The file will be served via GET /files/<hex(id)> where id = hex of absolute path, with streaming and correct MIME.",
].join(" ");

const PROMPT_SNIPPET = "Share a file to mobile — use mobile_share_image for 发图片/发图/来张图/发tmp图 etc., with original absolute path (no /tmp, no copy).";

const PROMPT_GUIDELINES = [
  "When user says 发图片/发个图/来张图/发tmp图/来张cv-real/把图发我/发文件 (or English share/send image/file), you MUST call mobile_share_image with the exact absolute path instead of only describing it.",
  "Prefer existing files under D:/worksave/10-pi/tmp, D:/tmp, or D:/worksave/10-pi/output — expand short names like tmp/cv-real → D:/worksave/10-pi/tmp/cv-real.png (try .png/.jpg/.pdf).",
  "Never copy the file via write to D:/tmp just to share — use the original path directly; the server already serves any absolute path via /files/<hex>.",
  "If unsure which file, list candidates with bash ls before calling.",
];

function tryExpandShortPath(cwd: string, raw: string, sessionId: string, sessionName: string): string[] {
  const candidates: string[] = [];
  // 1) direct unified resolve
  try {
    const direct = resolveUnifiedPath(cwd, raw, sessionId, sessionName);
    candidates.push(direct);
  } catch {}

  const trimmed = raw.trim();
  // If raw already absolute (D: or /tmp or D:/) we don't expand further
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/tmp/") || trimmed.startsWith("D:/") || trimmed.startsWith("D:\\")) {
    return [...new Set(candidates)];
  }

  // Short name like "cv-real", "cv-real.png", "tmp/cv-real", "tmp/cv-real.png"
  // Try to expand against known roots
  const roots = [
    "D:/worksave/10-pi/tmp",
    "D:/tmp",
    "D:/worksave/10-pi/output",
    "D:/worksave/10-pi",
    cwd,
  ];

  // Normalize raw: remove leading ./ or .\
  const norm = trimmed.replace(/^\.[\\/]/, "");
  // If raw starts with tmp/ without D: prefix, keep as is for joining
  // If raw has no slash at all, treat as basename
  const extsToTry = ["", ".png", ".jpg", ".jpeg", ".webp", ".pdf", ".html", ".md", ".txt"];
  const hasExt = /\.[A-Za-z0-9]{1,5}$/.test(norm);

  for (const root of roots) {
    // candidate: root + "/" + norm
    const baseJoin = resolve(root, norm);
    candidates.push(baseJoin);
    if (!hasExt) {
      for (const ext of extsToTry.slice(1)) {
        candidates.push(resolve(root, norm + ext));
      }
    }
    // Also if norm contains slash, try basename alone in each root
    const baseName = norm.split(/[\\/]/).pop() || norm;
    if (baseName !== norm) {
      candidates.push(resolve(root, baseName));
      if (!hasExt) {
        for (const ext of extsToTry.slice(1)) {
          candidates.push(resolve(root, baseName + ext));
        }
      }
    }
  }

  // Also handle "tmp/cv-real" where tmp should map to D:/worksave/10-pi/tmp
  if (norm.startsWith("tmp/") || norm.startsWith("tmp\\")) {
    const rest = norm.replace(/^tmp[\\/]/, "");
    const tmpRoots = ["D:/worksave/10-pi/tmp", "D:/tmp"];
    for (const r of tmpRoots) {
      candidates.push(resolve(r, rest));
      if (!hasExt) {
        for (const ext of extsToTry.slice(1)) {
          candidates.push(resolve(r, rest + ext));
        }
      }
    }
  }

  return [...new Set(candidates)];
}

async function findExistingFile(cwd: string, raw: string, sessionId: string, sessionName: string): Promise<string | null> {
  const tried = tryExpandShortPath(cwd, raw, sessionId, sessionName);
  for (const p of tried) {
    try {
      const st = await stat(p);
      if (st.isFile()) {
        // Guard placeholder
        if (st.size === 43) {
          try {
            const head = await readFile(p, "utf-8");
            if (head.includes("PLACEHOLDER_WILL_BE_OVERWRITTEN_WITH_BINARY")) continue;
          } catch {}
        }
        if (st.size > 0) return p;
      }
    } catch {}
  }
  // Last resort: scan known tmp dirs for prefix match (e.g. cv-real matches cv-real.png)
  const scanDirs = ["D:/worksave/10-pi/tmp", "D:/tmp", "D:/worksave/10-pi/output"];
  const needle = raw.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "").toLowerCase();
  for (const d of scanDirs) {
    try {
      if (!existsSync(d)) continue;
      const files = readdirSync(d);
      const hit = files.find((f) => f.toLowerCase().startsWith(needle) || f.toLowerCase() === needle.toLowerCase());
      if (hit) {
        const full = resolve(d, hit);
        try {
          const st = await stat(full);
          if (st.isFile() && st.size !== 43) return full;
        } catch {}
      }
    } catch {}
  }
  return null;
}

export function createMobileShareTool(opts: {
  getCwd: () => string;
  getSessionId: () => string;
  getSessionName: () => string;
}) {
  return defineTool({
    name: "mobile_share_image",
    label: "Share file to mobile",
    description: TOOL_DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: mobileShareSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const rawPath = (params as any).path?.trim();
      const caption = (params as any).caption?.trim() || "";
      const cwd = (ctx as any)?.cwd || opts.getCwd();
      const sessionId = opts.getSessionId();
      const sessionName = opts.getSessionName();

      if (!rawPath) {
        throw new Error("path is required. Provide absolute path like D:/worksave/10-pi/tmp/cv-real.png");
      }
      if (signal?.aborted) {
        throw new Error("Aborted");
      }

      // Resolve / fuzzy find
      let absPath: string | null = null;
      try {
        const direct = resolveUnifiedPath(cwd, rawPath, sessionId, sessionName);
        // Check if direct exists
        try {
          const st = await stat(direct);
          if (st.isFile()) {
            if (st.size === 43) {
              try {
                const head = await readFile(direct, "utf-8");
                if (head.includes("PLACEHOLDER_WILL_BE_OVERWRITTEN_WITH_BINARY")) {
                  throw new Error(`File ${direct} is a placeholder (43B). Real binary not yet written via bash cp/base64. Please first ensure file is fully written, then retry mobile_share_image.`);
                }
              } catch (e) {
                if (e instanceof Error && e.message.includes("placeholder")) throw e;
              }
            }
            absPath = direct;
          }
        } catch {}
      } catch (e) {
        sessionLogger(sessionId || sessionName).warn({ err: e, rawPath }, "[mobile_share] resolveUnifiedPath failed");
      }

      if (!absPath) {
        absPath = await findExistingFile(cwd, rawPath, sessionId, sessionName);
      }

      if (!absPath) {
        const tried = tryExpandShortPath(cwd, rawPath, sessionId, sessionName).slice(0, 8).join(", ");
        throw new Error(`File not found: ${rawPath}. Tried: ${tried}. Please check with bash ls D:/worksave/10-pi/tmp && ls D:/tmp`);
      }

      try {
        const st = await stat(absPath);
        if (!st.isFile()) {
          throw new Error(`Not a file: ${absPath}`);
        }
        if (st.size > 50 * 1024 * 1024) {
          throw new Error(`File too large (${st.size} bytes), max 50MB`);
        }
        if (st.size === 43) {
          try {
            const head = await readFile(absPath, "utf-8");
            if (head.includes("PLACEHOLDER_WILL_BE_OVERWRITTEN_WITH_BINARY")) {
              throw new Error(`File ${absPath} is placeholder 43B, not real content`);
            }
          } catch (e) {
            if (e instanceof Error && e.message.includes("placeholder")) throw e;
          }
        }

        const filename = absPath.split(/[\\/]/).pop() || "file";
        const content_type = getContentType(filename);
        const id = Buffer.from(absPath).toString("hex");
        const size = st.size;

        sessionLogger(sessionId || sessionName).info(
          { rawPath, absPath, id, size, content_type, caption },
          "[mobile_share] execute resolved & validated"
        );

        // The actual file_available emission is done in session.ts tool_execution_end handler
        // via pending map + detectAndNotifyFile, so we just return success text here.
        // But also return a hint for the LLM to include caption.
        const captionNote = caption ? ` Caption: ${caption}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Shared file ${filename} (${size} bytes, ${content_type}) via mobile card — id ${id.slice(0, 16)}... Original path: ${absPath}.${captionNote} The phone will show an OPEN card; no copy to D:/tmp needed.`,
            },
          ],
          details: { path: absPath, id, size, content_type, filename, caption },
        };
      } catch (e: any) {
        if (e instanceof Error && (e.message.includes("File not found") || e.message.includes("placeholder") || e.message.includes("Not a file") || e.message.includes("too large") || e.message.includes("path is required"))) {
          throw e;
        }
        sessionLogger(sessionId || sessionName).warn({ err: e, absPath }, "[mobile_share] stat failed");
        throw new Error(`Failed to share ${absPath}: ${e?.message || e}`);
      }
    },
  });
}

export const mobileShareToolMeta = {
  name: "mobile_share_image",
  snippet: PROMPT_SNIPPET,
  guidelines: PROMPT_GUIDELINES,
};
