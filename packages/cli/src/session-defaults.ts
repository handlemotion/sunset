import type { EngineId, Host, ModelSelection } from "@sunset/host";

import type { ResolvedConfig } from "./config.js";

async function configuredModel(
  host: Host,
  engine: EngineId,
  modelId: string,
): Promise<ModelSelection> {
  try {
    const capabilities = await host.capabilities();
    const models = capabilities.engines.find(
      (entry) => entry.id === engine,
    )?.models;
    const model = models?.find(
      (entry) => entry.id === modelId || entry.aliases.includes(modelId),
    );
    const variant = model?.variants.find((entry) => entry.isDefault);
    if (model && variant) return { id: model.id, params: variant.params };
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
