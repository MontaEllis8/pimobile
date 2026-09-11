import { resolve } from "node:path";
import { sessionLogger } from "./logger.js";

/**
 * L0 fix — unify /tmp ambiguity between Node (path.resolve -> D:\tmp)
 * and Git Bash (/tmp -> C:\Users\...\AppData\Local\Temp).
 *
 * AI must NOT write to /tmp. Canonical locations:
 *  - D:/worksave/10-pi/tmp  (project tmp, visible to both)
 *  - D:/tmp                (unified alias)
 *
 * This helper auto-rewrites any raw path starting with /tmp/ to D:/tmp/
 * and logs original->resolved for audit (session.ts:936 / fileRegistry.ts:67).
 * Bash side is handled via handleBashFileUpdate -> copy C:\Temp -> D:\tmp.
 */
export function resolveUnifiedPath(
  cwd: string,
  rawPath: string,
  sessionId: string,
  sessionName: string
): string {
  const trimmed = rawPath.trim();
  // /tmp/<rest> -> D:/tmp/<rest>  (covers /tmp/cv-mobile-1.png)
  if (trimmed.startsWith("/tmp/")) {
    const rest = trimmed.slice(5); // after "/tmp/"
    const rewritten = `D:/tmp/${rest}`;
    const resolved = resolve(rewritten);
    sessionLogger(sessionId || sessionName).info(
      { original: trimmed, resolved, rewrite: "/tmp -> D:/tmp" },
      "[path-resolve] unified /tmp"
    );
    return resolved;
  }
  if (trimmed === "/tmp") {
    const resolved = resolve("D:/tmp");
    sessionLogger(sessionId || sessionName).info(
      { original: trimmed, resolved, rewrite: "/tmp -> D:/tmp" },
      "[path-resolve] unified /tmp"
    );
    return resolved;
  }
  // Also handle bash-expanded C:\Users\...\Temp that mirrors /tmp — keep as-is but log
  const resolved = resolve(cwd, trimmed);
  sessionLogger(sessionId || sessionName).info(
    { original: trimmed, resolved },
    "[path-resolve]"
  );
  return resolved;
}

/**
 * Extract candidate file paths from a bash command string.
 * Used after bash tool_execution_end to re-trigger file_available for cp/base64 pipelines.
 */
export function extractBashFileTargets(command: string): string[] {
  const out: string[] = [];
  // Common patterns: cp src dst,  base64 -d > dst,  cat > dst,  > dst,  -o dst
  // Simplistic: find every token that looks like a path with /tmp or D:/tmp or D:/worksave or .png/.jpg
  const re = /(?:\/tmp\/[^\s"'`]+|D:\/tmp\/[^\s"'`]+|D:\\tmp\\[^\s"'`]+|D:\/worksave[^\s"'`]+|C:\/Users[^\s"'`]+|[^\s"'`]+\.(?:png|jpg|jpeg|webp|pdf|html|md|txt|json|csv))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const raw = m[0].replace(/^[`'"]|[`'"]$/g, "").replace(/[,;]$/, "");
    // strip trailing punctuation
    const p = raw.replace(/[\)\]]$/, "");
    if (p.length > 2) out.push(p);
  }
  // Also split by shell redirects:  > <filename>
  const redirectRe = />\s*([^\s;|&]+)/g;
  while ((m = redirectRe.exec(command)) !== null) {
    const p = m[1].replace(/^[`'"]|[`'"]$/g, "");
    if (p.length > 2 && !out.includes(p)) out.push(p);
  }
  // De-duplicate
  return [...new Set(out)];
}
