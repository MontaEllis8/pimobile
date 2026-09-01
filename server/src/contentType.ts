/**
 * Map file extension to MIME type.
 * N16/QS-05: extracted from the duplicated copies in session.ts and
 * server.ts so the mapping has a single source of truth.
 */
export function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html", htm: "text/html",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf",
    js: "text/javascript", ts: "text/typescript", mjs: "text/javascript",
    json: "application/json", xml: "application/xml",
    css: "text/css",
    txt: "text/plain", md: "text/markdown", csv: "text/csv",
    py: "text/x-python", rs: "text/x-rust", go: "text/x-go",
    java: "text/x-java", kt: "text/x-kotlin",
  };
  return map[ext] || "application/octet-stream";
}
