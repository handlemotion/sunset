import type {
  EngineId,
  Host,
  HostCapabilities,
  ModelSelection,
} from "@sunset/host";

import type { ResolvedConfig } from "./config.js";

/**
 * Resolves a configured model id (or alias) against an engine's catalog,
 * expanding it to the canonical id with its default variant's params.
 */
export function modelSelection(
  capabilities: HostCapabilities,
  engine: EngineId,
  modelId: string,
): ModelSelection {
  const models = capabilities.engines.find(
    (entry) => entry.id === engine,
  )?.models;
  const model = models?.find(
    (entry) => entry.id === modelId || entry.aliases.includes(modelId),
  );
  const variant = model?.variants.find((entry) => entry.isDefault);
  if (model && variant) return { id: model.id, params: variant.params };
  return { id: modelId, params: [] };
}

async function configuredModel(
  host: Host,
  engine: EngineId,
  modelId: string,
): Promise<ModelSelection> {
  try {
    return modelSelection(await host.capabilities(), engine, modelId);
  } catch {
    // Host session creation remains authoritative if catalog discovery fails.
  }
  return { id: modelId, params: [] };
}

export function withSessionDefaults(host: Host, config: ResolvedConfig): Host {
  const defaultEngine = config.defaultEngine;
  const defaultModel = config.defaultModel;
  if (!defaultEngine && !defaultModel) return host;
  const create = host.sessions.create;
  return {
    ...host,
    sessions: {
      ...host.sessions,
      create: async (input) => {
        const engine = input.engine ?? defaultEngine ?? "devin";
        const model =
          input.model === undefined && defaultModel
            ? await configuredModel(host, engine, defaultModel)
            : input.model;
        return create({
          ...input,
          ...(input.engine === undefined && defaultEngine
            ? { engine: defaultEngine }
            : {}),
          ...(input.model === undefined && model ? { model } : {}),
        });
      },
    },
  };
}
