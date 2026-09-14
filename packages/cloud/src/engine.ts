import {
  createEngine,
  DEFAULT_CODEX_CATALOG,
  ENGINES,
  upstreamModelId,
  type AcpConnectionHandle,
  type AcpConnector,
  type CreateEngineInput,
  type Engine,
  type EngineSessionHandle,
} from "@sunset/acp";
import type { ModelCapability } from "@sunset/domain";
import { cloudConnector, type CloudConnectorOptions } from "./connector.js";

export type CloudEngineOptions = Omit<
  CloudConnectorOptions,
  "engine" | "model"
> & {
  /** Engine id as defined in @sunset/acp ENGINES ("devin" | "codex"). */
  engine: keyof typeof ENGINES;
};

const DEVIN_DEFAULT: ModelCapability[] = [
  {
    id: "default",
    displayName: "Devin default",
    aliases: [],
    parameters: [],
    variants: [{ params: [], displayName: "Default", isDefault: true }],
  },
];

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

const EFFORT_PARAMETER = {
  id: "effort",
  displayName: "Reasoning effort",
  values: CODEX_EFFORTS.map((value) => ({
    value,
    displayName: value[0]!.toUpperCase() + value.slice(1),
  })),
};

/**
 * Map an ACP `session/new` models block to the domain catalog shape. For
 * codex, upstream ids look like `slug[effort]`; they are grouped into one
 * capability per slug with effort variants so a selected variant round-trips
 * through `codexModelId` back to `slug[effort]` at `session/set_model`.
 */
function catalogFromProbe(models: unknown, engine: string): ModelCapability[] {
  if (models === null || typeof models !== "object") return [];
  const { availableModels, currentModelId } = models as {
    availableModels?: unknown;
    currentModelId?: unknown;
  };
  if (!Array.isArray(availableModels)) return [];

  if (engine === "codex") {
    const bySlug = new Map<string, { name: string; efforts: string[] }>();
    for (const entry of availableModels) {
      if (entry === null || typeof entry !== "object") continue;
      const { modelId, name } = entry as { modelId?: unknown; name?: unknown };
      const match =
        typeof modelId === "string"
          ? modelId.match(/^(.+?)\[([a-z]+)\]$/)
          : null;
      const slug = match ? match[1]! : modelId;
      if (typeof slug !== "string" || slug.length === 0) continue;
      const effort = match?.[2];
      const display =
        (typeof name === "string" ? name : slug).replace(
          /\s*\([a-z]+\)\s*$/i,
          "",
        ) || slug;
      const group = bySlug.get(slug) ?? { name: display, efforts: [] };
      if (effort && !group.efforts.includes(effort)) group.efforts.push(effort);
      bySlug.set(slug, group);
    }
    const currentSlug =
      typeof currentModelId === "string"
        ? (currentModelId.match(/^(.+?)\[/)?.[1] ?? currentModelId)
        : undefined;
    const out: ModelCapability[] = [];
    for (const [slug, group] of bySlug) {
      const efforts = group.efforts.length ? group.efforts : CODEX_EFFORTS;
      out.push({
        id: `codex:${slug}`,
        displayName: group.name,
        aliases: [slug],
        parameters: [EFFORT_PARAMETER],
        variants: efforts.map((effort) => ({
          params: [{ id: "effort", value: effort }],
          displayName: `${group.name} (${effort})`,
          isDefault: slug === currentSlug,
        })),
      });
    }
    if (!out.some((m) => m.variants.some((v) => v.isDefault))) {
      out[0]?.variants.forEach((v, i) => {
        v.isDefault = i === 0;
      });
    }
    return out;
  }

  const out: ModelCapability[] = [];
  for (const entry of availableModels) {
    if (entry === null || typeof entry !== "object") continue;
    const { modelId, name, description } = entry as {
      modelId?: unknown;
      name?: unknown;
      description?: unknown;
    };
    if (typeof modelId !== "string" || modelId.length === 0) continue;
    const displayName =
      typeof name === "string" && name.length > 0 ? name : modelId;
    out.push({
      id: modelId,
      displayName,
      ...(typeof description === "string" ? { description } : {}),
      aliases: [],
      parameters: [],
      variants: [
        { params: [], displayName, isDefault: modelId === currentModelId },
      ],
    });
  }
  if (!out.some((model) => model.variants.some((v) => v.isDefault))) {
    out[0]?.variants.forEach((variant, index) => {
      variant.isDefault = index === 0;
    });
  }
  return out;
}

/** Wrap a handle so `wait()` is attached eagerly: the runtime's internal
 * prompt promise is observed as soon as the run exists, so a transport drop
 * between `send` and a delayed `wait` cannot become an unhandled rejection.
 * The returned wait promise is shared across calls. */
function wrapHandle(handle: EngineSessionHandle): EngineSessionHandle {
  return {
    providerSessionId: handle.providerSessionId,
    send: async (prompt, options) => {
      const run = await handle.send(prompt, options);
      const waited = run.wait();
      return {
        runId: run.runId,
        stream: (o) => run.stream(o),
        wait: () => waited,
        cancel: () => run.cancel(),
      };
    },
    dispose: () => handle.dispose(),
  };
}

/**
 * Engine implementation backed by the cloud worker. Reuses the shared ACP
 * runtime (`createEngine`) with a WebSocket connector, so session/run/
 * permission semantics match the local host.
 *
 * Resume semantics: every `resume` opens a *fresh* ephemeral box and forwards
 * `providerSessionId` to `session/resume`/`session/load` — it does NOT
 * reattach to the previous sandbox. A previous box cannot be reattached (the
 * exec-session socket owns the process) and is deleted on close; only
 * provider-side session history is resumable. Resuming into a box whose agent
 * has no record of the id fails with `session_resume_failed`.
 */
export function createCloudEngine(options: CloudEngineOptions): Engine {
  const definition = ENGINES[options.engine];
  if (!definition) {
    throw new Error(`unsupported_cloud_engine:${String(options.engine)}`);
  }

  // The connector signature carries no model, so bind the resolved upstream
  // id per call — the runtime maps it identically via upstreamModelId. The
  // acquired handle is captured so a rejected setup (initialize/session/new/
  // resume/set_model) still closes the connection and releases the box.
  const engineFor = (
    input: CreateEngineInput,
  ): { engine: Engine; release: () => void } => {
    const model = input.model.id
      ? upstreamModelId(definition.id, input.model.id)
      : undefined;
    let acquired: AcpConnectionHandle | undefined;
    const base = cloudConnector({
      ...options,
      engine: definition.id,
      ...(model ? { model } : {}),
    });
    const connector: AcpConnector = async (connectorInput) =>
      (acquired = await base(connectorInput));
    return {
      engine: createEngine(definition, { connector }),
      release: () => acquired?.close(),
    };
  };

  const guarded =
    (
      open: (
        engine: Engine,
        input: CreateEngineInput,
      ) => Promise<EngineSessionHandle>,
    ) =>
    async (input: CreateEngineInput): Promise<EngineSessionHandle> => {
      const { engine, release } = engineFor(input);
      try {
        return wrapHandle(await open(engine, input));
      } catch (error) {
        release();
        throw error;
      }
    };

  /**
   * Remote catalog probe: opens a throwaway cloud session and reads
   * `session/new`'s model list. Never spawns a local CLI. Falls back to the
   * static catalog when the probe cannot run.
   */
  const probeCatalog = async (): Promise<ModelCapability[]> => {
    const fallback =
      definition.id === "codex" ? DEFAULT_CODEX_CATALOG : DEVIN_DEFAULT;
    let conn: AcpConnectionHandle;
    try {
      conn = await cloudConnector({ ...options, engine: definition.id })({
        cwd: "/",
        onUpdate: () => undefined,
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onClose: () => undefined,
      });
    } catch {
      return fallback;
    }
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
        cwd: "/",
        mcpServers: [],
      })) as { models?: unknown };
      const models = catalogFromProbe(created.models, definition.id);
      return models.length > 0 ? models : fallback;
    } catch {
      return fallback;
    } finally {
      conn.close();
    }
  };

  return {
    id: definition.id,
    listModels: () => probeCatalog(),
    supportedModes: () => createEngine(definition).supportedModes(),
    create: guarded((engine, input) => engine.create(input)),
    resume: guarded((engine, input) =>
      engine.resume(input as CreateEngineInput & { providerSessionId: string }),
    ),
  };
}
