import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

import type { EngineId, ModelCapability, ModelSelection } from "@sunset/domain";

import { ENGINES, resolveEngineSpawn } from "./engines.js";
import { stdioConnector } from "./client.js";

const EFFORT = {
  id: "effort",
  displayName: "Reasoning effort",
  values: [
    { value: "low", displayName: "Low" },
    { value: "medium", displayName: "Medium" },
    { value: "high", displayName: "High" },
    { value: "xhigh", displayName: "Extra high" },
    { value: "max", displayName: "Max" },
    { value: "ultra", displayName: "Ultra" },
  ],
};

function codexModel(
  upstream: string,
  displayName: string,
  isDefault = false,
): ModelCapability {
  return {
    id: `codex:${upstream}`,
    displayName,
    aliases: [upstream],
    parameters: [EFFORT],
    variants: [
      {
        params: [{ id: "effort", value: "medium" }],
        displayName: `${displayName} (medium)`,
        isDefault,
      },
    ],
  };
}

// Fallback when the live catalog probe fails: known codex families with the
// standard effort ladder. The adapter's session/new response is authoritative.
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const DEFAULT_CODEX_CATALOG: ModelCapability[] = [
  codexModel("gpt-6-astra", "GPT-6 Astra", true),
  codexModel("gpt-5.6-sol", "GPT-5.6 Sol"),
  codexModel("gpt-5.6-terra", "GPT-5.6 Terra"),
  codexModel("gpt-5.6-luna", "GPT-5.6 Luna"),
  codexModel("gpt-5.5", "GPT-5.5"),
];

/**
 * Map a Sunset codex selection to the adapter's modelId: `slug[effort]`,
 * e.g. `codex:gpt-6-astra` + effort `medium` → `gpt-6-astra[medium]`.
 */
export function codexModelId(model: ModelSelection): string {
  const slug = upstreamModelId("codex", model.id);
  const effort = model.params.find((param) => param.id === "effort")?.value;
  return effort ? `${slug}[${effort}]` : slug;
}

/** Strip the `codex:` namespace before passing a model id to the adapter. */
export function upstreamModelId(engine: EngineId, id: string): string {
  return engine === "codex" && id.startsWith("codex:") ? id.slice(6) : id;
}

const DEVIN_FALLBACK: ModelCapability[] = [
  {
    id: "default",
    displayName: "Devin default",
    aliases: [],
    parameters: [],
    variants: [{ params: [], displayName: "Default", isDefault: true }],
  },
];

type DevinModelEntry = {
  id?: string;
  name?: string;
  slug?: string;
  display_name?: string;
  family?: string;
};

function collectDevinModels(value: unknown, out: DevinModelEntry[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectDevinModels(entry, out);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id === "string" ||
    typeof record.slug === "string" ||
    typeof record.name === "string"
  ) {
    out.push(record as DevinModelEntry);
    return;
  }
  for (const entry of Object.values(record)) collectDevinModels(entry, out);
}

function devinCatalog(json: string): ModelCapability[] {
  const entries: DevinModelEntry[] = [];
  collectDevinModels(JSON.parse(json), entries);
  const models: ModelCapability[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = (entry.id ?? entry.slug ?? entry.name ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = entry.display_name ?? entry.name ?? id;
    models.push({
      id,
      displayName: entry.family
        ? `${entry.family} · ${displayName}`
        : displayName,
      aliases: entry.name && entry.name !== id ? [entry.name] : [],
      parameters: [],
      variants: [{ params: [], displayName, isDefault: models.length === 0 }],
    });
  }
  return models.length ? models : DEVIN_FALLBACK;
}

function runCatalogCommand(command: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = command;
    if (!bin) return reject(new Error("catalog_command_empty"));
    execFile(bin, args, { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

type CodexCatalogEntry = {
  modelId?: string;
  name?: string;
  description?: string;
};

/** Parse `slug[effort]` model ids into grouped capabilities. */
function codexCatalog(entries: CodexCatalogEntry[], currentModelId?: string) {
  const bySlug = new Map<string, { name: string; efforts: string[] }>();
  for (const entry of entries) {
    const match = entry.modelId?.match(/^(.+?)\[([a-z]+)\]$/);
    const slug = match ? match[1]! : entry.modelId;
    if (!slug) continue;
    const effort = match?.[2];
    const name = (entry.name ?? slug).replace(/\s*\([a-z]+\)\s*$/i, "");
    const group = bySlug.get(slug) ?? { name, efforts: [] };
    if (effort && !group.efforts.includes(effort)) group.efforts.push(effort);
    bySlug.set(slug, group);
  }
  const currentSlug = currentModelId?.match(/^(.+?)\[/)?.[1] ?? currentModelId;
  const models: ModelCapability[] = [];
  for (const [slug, group] of bySlug) {
    const efforts = group.efforts.length ? group.efforts : CODEX_EFFORTS;
    models.push({
      id: `codex:${slug}`,
      displayName: group.name,
      aliases: [slug],
      parameters: [EFFORT],
      variants: efforts.map((effort) => ({
        params: [{ id: "effort", value: effort }],
        displayName: `${group.name} (${effort})`,
        isDefault: slug === currentSlug,
      })),
    });
  }
  if (!models.some((model) => model.variants.some((v) => v.isDefault))) {
    models[0]?.variants.forEach((v, i) => (v.isDefault = i === 0));
  }
  return models;
}

const CODEX_CATALOG_TTL_MS = 60 * 60 * 1000;

let codexCatalogCache: {
  fetchedAt: number;
  result: Promise<ModelCapability[]>;
} | null = null;

/** Internal test hook: drop the cached codex catalog to force a re-probe. */
export function resetCatalogCache(): void {
  codexCatalogCache = null;
}

/**
 * Probe the codex adapter for its live catalog — `session/new` returns
 * `models.availableModels`. Falls back to the static list on any failure.
 */
function probeCodexCatalog(): Promise<ModelCapability[]> {
  return (async () => {
    try {
      const spawn = await resolveEngineSpawn("codex");
      const conn = await stdioConnector({
        command: spawn.command,
        args: spawn.args,
      })({
        cwd: tmpdir(),
        onUpdate: () => undefined,
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onClose: () => undefined,
      });
      try {
        await conn.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "sunset", title: "Sunset", version: "0.0.1" },
        });
        const created = (await conn.request("session/new", {
          cwd: tmpdir(),
          mcpServers: [],
        })) as {
          models?: {
            availableModels?: CodexCatalogEntry[];
            currentModelId?: string;
          };
        };
        const models = codexCatalog(
          created.models?.availableModels ?? [],
          created.models?.currentModelId,
        );
        return models.length ? models : DEFAULT_CODEX_CATALOG;
      } finally {
        conn.close();
      }
    } catch {
      return DEFAULT_CODEX_CATALOG;
    }
  })();
}

function listCodexModels(): Promise<ModelCapability[]> {
  if (
    !codexCatalogCache ||
    Date.now() - codexCatalogCache.fetchedAt >= CODEX_CATALOG_TTL_MS
  ) {
    codexCatalogCache = {
      fetchedAt: Date.now(),
      result: probeCodexCatalog(),
    };
  }
  return codexCatalogCache.result;
}

export async function listModels(engine: EngineId): Promise<ModelCapability[]> {
  if (engine === "codex") return listCodexModels();
  const command = ENGINES.devin.catalogCommand;
  if (!command) return DEVIN_FALLBACK;
  const output = await runCatalogCommand(command);
  return devinCatalog(output);
}
