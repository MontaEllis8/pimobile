import {
  createAgentSession as _createAgentSession,
  getAgentDir as _getAgentDir,
  ModelRuntime as _ModelRuntime,
  SessionManager as _SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createMobileShareTool } from "./mobileShareTool.js";

/**
 * Anti-corruption layer for @earendil-works/pi-coding-agent.
 * Centralizes all direct SDK imports so a future 0.85→0.86 bump
 * only touches this file.
 */

export async function createModelRuntime(): Promise<ModelRuntime> {
  return _ModelRuntime.create();
}

export async function createSdkSession(
  cwd: string,
  sessionManager: SessionManager,
  modelRuntime: ModelRuntime
) {
  // L0+ mobile_share_image — direct original path share (no write→D:/tmp copy)
  // path支持任意绝对路径（D:/worksave/10-pi/tmp/xxx.png、D:/worksave/10-pi/output/xxx.pdf），
  // id仍为 Buffer.from(abs).toString("hex")，复用 resolveUnifiedPath。
  // 自动触发：tool description + promptGuidelines 覆盖中文 发图片/来张图 等，已注入系统提示词。
  let mobileShareTool: any = null;
  try {
    mobileShareTool = createMobileShareTool({
      getCwd: () => cwd,
      getSessionId: () => {
        try {
          return (sessionManager as any)?.getSessionId?.() || "";
        } catch {
          return "";
        }
      },
      getSessionName: () => {
        try {
          return (sessionManager as any)?.getSessionName?.() || cwd;
        } catch {
          return cwd;
        }
      },
    });
  } catch {}
  const customTools = mobileShareTool ? [mobileShareTool] : undefined;
  return _createAgentSession({
    cwd,
    sessionManager,
    modelRuntime,
    ...(customTools ? { customTools } : {}),
  });
}

export function getAgentDirSafe(): string {
  return _getAgentDir();
}

// Re-export types / classes that callers may need for typing only
export { _ModelRuntime as ModelRuntimeClass, _SessionManager as SessionManagerClass };
export type { ModelRuntime, SessionManager };
