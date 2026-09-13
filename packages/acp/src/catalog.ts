import { execFile } from "node:child_process";

import type { EngineId, ModelCapability } from "@sunset/domain";

import { ENGINES } from "./engines.js";

const EFFORT = {
  id: "effort",
  displayName: "Reasoning effort",
  values: [
    { value: "low", displayName: "Low" },
    { value: "medium", displayName: "Medium" },
    { value: "high", displayName: "High" },
    { value: "xhigh", displayName: "Extra high" },
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

// codex-acp 0.16.0 bundles codex ~0.124; models newer than its app-server
// (gpt-5.6-*, gpt-6-*) are rejected by the API. Keep only verified entries.
export const DEFAULT_CODEX_CATALOG: ModelCapability[] = [
  codexModel("gpt-5.5", "GPT-5.5", true),
];

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

export async function listModels(engine: EngineId): Promise<ModelCapability[]> {
  if (engine === "codex") return DEFAULT_CODEX_CATALOG;
  const command = ENGINES.devin.catalogCommand;
  if (!command) return DEVIN_FALLBACK;
  const output = await runCatalogCommand(command);
  return devinCatalog(output);
}
