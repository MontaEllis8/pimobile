import { getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";

export const FALLBACK_PROVIDER = "opencode-go";
// NOTE 2026-09-05 (SDK 0.85.0 upgrade): ox-alpha-free returns empty turns (dead free model,
// also removed from user's enabledModels) — fallback switched to deepseek-v4-flash.
export const FALLBACK_MODEL = "deepseek-v4-flash";

/**
 * Resolve the default model from ~/.pi/agent/settings.json with fallbacks.
 * Priority: settings.json defaultModel/defaultProvider → enabledModels → getAvailableSnapshot → FALLBACK
 */
export async function resolveDefaultModel(
  modelRuntime: ModelRuntime
): Promise<{ provider: string; model: string } | null> {
  // 1. Try reading ~/.pi/agent/settings.json defaultModel
  try {
    const { join } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      if (raw) {
        const settings = JSON.parse(raw);
        const defaultModelStr: string | undefined = settings.defaultModel;
        const defaultProviderStr: string | undefined = settings.defaultProvider;
        if (typeof defaultModelStr === "string" && defaultModelStr.trim().length > 0) {
          const trimmed = defaultModelStr.trim();
          if (trimmed.includes("/")) {
            const [p, m] = trimmed.split("/", 2);
            if (p && m) {
              const candidate = modelRuntime.getModel(p, m);
              if (candidate) return { provider: p, model: m };
            }
          } else if (typeof defaultProviderStr === "string" && defaultProviderStr.trim().length > 0) {
            const candidate = modelRuntime.getModel(defaultProviderStr.trim(), trimmed);
            if (candidate) return { provider: defaultProviderStr.trim(), model: trimmed };
          } else {
            // Search any provider that has this model id
            const all = modelRuntime.getModels() as any[];
            const found = all.find((mdl: any) => (mdl.id || mdl.model) === trimmed);
            if (found) return { provider: found.provider || FALLBACK_PROVIDER, model: trimmed };
          }
        }
        // Fallback: enabledModels list
        if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) {
          for (const entry of settings.enabledModels) {
            if (typeof entry === "string" && entry.includes("/")) {
              const [p, m] = entry.split("/", 2);
              if (p && m) {
                const candidate = modelRuntime.getModel(p, m);
                if (candidate) return { provider: p, model: m };
              }
            }
          }
        }
      }
    }
  } catch {
    // ignore and fallback
  }

  // 2. Fallback to first model that has a configured provider (via getAvailableSnapshot if available)
  try {
    const snap = (modelRuntime as any).getAvailableSnapshot?.() as any[] | undefined;
    if (Array.isArray(snap) && snap.length > 0) {
      const first = snap[0];
      const provider = first.provider || FALLBACK_PROVIDER;
      const model = first.id || first.model || first.name;
      if (provider && model) return { provider, model };
    }
  } catch {
    // ignore
  }

  // 3. Ultimate fallback
  const fallback = modelRuntime.getModel(FALLBACK_PROVIDER, FALLBACK_MODEL);
  if (fallback) return { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL };

  // Last resort: first from getModels
  try {
    const all = modelRuntime.getModels() as any[];
    if (all.length > 0) {
      const first = all[0];
      return { provider: first.provider || FALLBACK_PROVIDER, model: first.id || first.model || FALLBACK_MODEL };
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Filter models for mobile client (three-level priority):
 * 1) enabledModels from settings.json (with defaultModel pinning)
 * 2) providers with configured key in auth.json
 * 3) fallback: current session model + first 3
 */
export async function getFilteredModels(
  modelRuntime: ModelRuntime,
  currentModel?: { provider: string; model: string } | null
): Promise<Array<{ id: string; provider: string; name: string; context_window: number }>> {
  const allModels = modelRuntime.getModels() as any[];

  // ── Priority 1: enabledModels from settings.json ──
  try {
    const { join } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      if (raw) {
        const settings = JSON.parse(raw);
        if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) {
          const filtered: Array<{ id: string; provider: string; name: string; context_window: number }> = [];
          for (const entry of settings.enabledModels) {
            if (typeof entry === "string" && entry.includes("/")) {
              const [p, m] = entry.split("/", 2);
              const candidate = allModels.find((mdl: any) => mdl.provider === p && (mdl.id === m || mdl.model === m || mdl.name === m));
              if (candidate) {
                filtered.push({
                  id: candidate.id || candidate.model || candidate.name,
                  provider: candidate.provider || "",
                  name: candidate.name || candidate.id || "",
                  context_window: candidate.contextWindow ?? candidate.context_window ?? 0,
                });
              } else {
                const cand2 = modelRuntime.getModel(p, m) as any;
                if (cand2) {
                  filtered.push({
                    id: (cand2 as any).id || m,
                    provider: (cand2 as any).provider || p,
                    name: (cand2 as any).name || m,
                    context_window: (cand2 as any).contextWindow ?? 0,
                  });
                }
              }
            }
          }
          if (filtered.length > 0) {
            // If defaultModel is configured, ensure it is at the front
            if (typeof settings.defaultModel === "string" && settings.defaultModel.trim().length > 0) {
              let dmProvider: string | null = null;
              let dmId: string | null = null;
              const trimmed = settings.defaultModel.trim();
              if (trimmed.includes("/")) {
                const [p, m] = trimmed.split("/", 2);
                dmProvider = p;
                dmId = m;
              } else if (typeof settings.defaultProvider === "string" && settings.defaultProvider.trim().length > 0) {
                dmProvider = settings.defaultProvider.trim();
                dmId = trimmed;
              } else {
                const found = allModels.find((mdl: any) => mdl.id === trimmed || mdl.model === trimmed);
                if (found) {
                  dmProvider = found.provider;
                  dmId = trimmed;
                }
              }
              if (dmProvider && dmId) {
                const idx = filtered.findIndex((f) => f.provider === dmProvider && f.id === dmId);
                if (idx > 0) {
                  const [item] = filtered.splice(idx, 1);
                  filtered.unshift(item);
                } else if (idx === -1) {
                  const cand = allModels.find((mdl: any) => mdl.provider === dmProvider && (mdl.id === dmId || mdl.model === dmId));
                  if (cand) {
                    filtered.unshift({
                      id: cand.id || cand.model || dmId!,
                      provider: cand.provider || dmProvider!,
                      name: cand.name || cand.id || dmId!,
                      context_window: cand.contextWindow ?? cand.context_window ?? 0,
                    });
                  } else {
                    const cand2 = modelRuntime.getModel(dmProvider, dmId) as any;
                    if (cand2) {
                      filtered.unshift({
                        id: (cand2 as any).id || dmId!,
                        provider: (cand2 as any).provider || dmProvider!,
                        name: (cand2 as any).name || dmId!,
                        context_window: (cand2 as any).contextWindow ?? 0,
                      });
                    }
                  }
                }
              }
            }
            return filtered;
          }
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "[models] Failed to read settings.json");
  }

  // ── Priority 2: providers with configured Key in auth.json ──
  const configuredProviders = new Set<string>();
  try {
    const { join } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");
    const authPath = join(getAgentDir(), "auth.json");
    if (existsSync(authPath)) {
      const raw = readFileSync(authPath, "utf-8");
      if (raw) {
        const auth = JSON.parse(raw);
        for (const [provider, entry] of Object.entries(auth)) {
          if (entry && typeof entry === "object" && (entry as any).key) {
            configuredProviders.add(provider.toLowerCase());
          }
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "[models] Failed to read auth.json");
  }

  const usable: Array<{ id: string; provider: string; name: string; context_window: number }> = [];
  for (const m of allModels) {
    const providerLower = (m.provider || "").toLowerCase();
    if (configuredProviders.has(providerLower)) {
      usable.push({
        id: m.id || m.model || m.name,
        provider: m.provider || "",
        name: m.name || m.id || "",
        context_window: m.contextWindow ?? m.context_window ?? 0,
      });
    }
  }

  if (usable.length >= 2) {
    return usable;
  }

  // ── Priority 3: fallback — current session model + first 3 available ──
  if (usable.length === 0 && allModels.length > 0) {
    const fallback: Array<{ id: string; provider: string; name: string; context_window: number }> = [];
    if (currentModel) {
      const cur = allModels.find((m: any) => m.provider === currentModel.provider && (m.id === currentModel.model || m.model === currentModel.model));
      if (cur) {
        fallback.push({
          id: cur.id || cur.model || cur.name,
          provider: cur.provider || "",
          name: cur.name || cur.id || "",
          context_window: cur.contextWindow ?? cur.context_window ?? 0,
        });
      }
    }
    for (const m of allModels) {
      if (fallback.length >= 3) break;
      const candidate = {
        id: m.id || m.model || m.name,
        provider: m.provider || "",
        name: m.name || m.id || "",
        context_window: m.contextWindow ?? m.context_window ?? 0,
      };
      if (!fallback.some((f) => f.id === candidate.id && f.provider === candidate.provider)) {
        fallback.push(candidate);
      }
    }
    return fallback;
  }

  return usable;
}
