import {
  resolveExecutionPolicy,
  type ExecutionPolicy,
  type ModelCapability,
  type ModelParameterValue,
  type ModelSelection,
} from "@sunset/domain";

import { HostError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function parameterValue(value: unknown): ModelParameterValue {
  if (!isRecord(value)) throw new Error("invalid model parameter value");
  return {
    id: stringValue(value.id, "model parameter id"),
    value: stringValue(value.value, "model parameter value"),
  };
}

export function parseModelCatalog(value: unknown): ModelCapability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("model catalog is empty or invalid");
  }
  const ids = new Set<string>();
  const models = value.map((item) => {
    if (!isRecord(item)) throw new Error("invalid model catalog entry");
    const id = stringValue(item.id, "model id");
    if (ids.has(id)) throw new Error(`duplicate model id: ${id}`);
    ids.add(id);
    if (!Array.isArray(item.aliases))
      throw new Error(`invalid aliases for ${id}`);
    if (!Array.isArray(item.parameters)) {
      throw new Error(`invalid parameters for ${id}`);
    }
    if (!Array.isArray(item.variants))
      throw new Error(`invalid variants for ${id}`);
    const model: ModelCapability = {
      id,
      displayName: stringValue(item.displayName, "model display name"),
      aliases: item.aliases.map((alias) => stringValue(alias, "model alias")),
      parameters: item.parameters.map((parameter) => {
        if (!isRecord(parameter) || !Array.isArray(parameter.values)) {
          throw new Error(`invalid parameter definition for ${id}`);
        }
        const definition = {
          id: stringValue(parameter.id, "parameter id"),
          values: parameter.values.map((entry) => {
            if (!isRecord(entry))
              throw new Error(`invalid parameter value for ${id}`);
            const mapped: { value: string; displayName?: string } = {
              value: stringValue(entry.value, "parameter value"),
            };
            const displayName = optionalString(
              entry.displayName,
              "parameter display name",
            );
            if (displayName !== undefined) mapped.displayName = displayName;
            return mapped;
          }),
        };
        const displayName = optionalString(
          parameter.displayName,
          "parameter display name",
        );
        return displayName === undefined
          ? definition
          : { ...definition, displayName };
      }),
      variants: item.variants.map((variant) => {
        if (!isRecord(variant) || !Array.isArray(variant.params)) {
          throw new Error(`invalid variant for ${id}`);
        }
        if (
          variant.isDefault !== undefined &&
          typeof variant.isDefault !== "boolean"
        ) {
          throw new Error(`invalid default variant marker for ${id}`);
        }
        return {
          params: variant.params.map(parameterValue),
          displayName: stringValue(variant.displayName, "variant display name"),
          ...(optionalString(variant.description, "variant description") ===
          undefined
            ? {}
            : { description: variant.description as string }),
          ...(variant.isDefault === undefined
            ? {}
            : { isDefault: variant.isDefault === true }),
        };
      }),
    };
    const description = optionalString(item.description, "model description");
    if (description !== undefined) model.description = description;
    const parameterIds = new Set<string>();
    for (const parameter of model.parameters) {
      if (parameterIds.has(parameter.id)) {
        throw new Error(`duplicate parameter ${parameter.id} for ${id}`);
      }
      parameterIds.add(parameter.id);
      const values = new Set<string>();
      for (const entry of parameter.values) {
        if (values.has(entry.value)) {
          throw new Error(
            `duplicate value ${entry.value} for ${id}.${parameter.id}`,
          );
        }
        values.add(entry.value);
      }
    }
    return model;
  });
  const selectors = new Set<string>();
  for (const model of models) {
    for (const selector of [model.id, ...model.aliases]) {
      if (selectors.has(selector)) {
        throw new Error(`duplicate model id or alias: ${selector}`);
      }
      selectors.add(selector);
    }
  }
  return models;
}

export function parseModelParameters(value: unknown): ModelParameterValue[] {
  if (!Array.isArray(value))
    throw new Error("invalid persisted model parameters");
  return value.map(parameterValue);
}

export function parseExecutionPolicy(value: unknown): ExecutionPolicy {
  if (
    !isRecord(value) ||
    typeof value.autoReview !== "boolean" ||
    !isRecord(value.sandbox) ||
    typeof value.sandbox.enabled !== "boolean" ||
    typeof value.agentRetries !== "boolean" ||
    !(value.toolAllowlist === null || Array.isArray(value.toolAllowlist)) ||
    !Array.isArray(value.toolDenylist)
  ) {
    throw new Error("invalid persisted execution policy");
  }
  return resolveExecutionPolicy({
    autoReview: value.autoReview,
    sandbox: { enabled: value.sandbox.enabled },
    agentRetries: value.agentRetries,
    toolAllowlist:
      value.toolAllowlist === null
        ? null
        : value.toolAllowlist.map((item) =>
            stringValue(item, "tool allowlist"),
          ),
    toolDenylist: value.toolDenylist.map((item) =>
      stringValue(item, "tool denylist"),
    ),
  });
}

export function resolveModelSelection(
  requested: ModelSelection | undefined,
  catalog: ModelCapability[],
): ModelSelection {
  const preferred =
    requested === undefined
      ? (catalog.find((model) =>
          model.variants.some((variant) => variant.isDefault),
        ) ?? catalog[0])
      : catalog.find(
          (model) =>
            model.id === requested.id || model.aliases.includes(requested.id),
        );
  if (!preferred) {
    throw new HostError(
      requested === undefined
        ? "no models are available"
        : `model is unavailable: ${requested.id}`,
      "model_unavailable",
    );
  }
  const params =
    requested?.params ??
    preferred.variants.find((variant) => variant.isDefault)?.params ??
    [];
  const selected = new Map<string, string>();
  for (const parameter of params) {
    if (selected.has(parameter.id)) {
      throw new HostError(
        `duplicate model parameter: ${parameter.id}`,
        "unsupported_model_parameter",
      );
    }
    const definition = preferred.parameters.find(
      (candidate) => candidate.id === parameter.id,
    );
    if (
      !definition ||
      !definition.values.some((value) => value.value === parameter.value)
    ) {
      throw new HostError(
        `unsupported model parameter ${parameter.id}=${parameter.value} for ${preferred.id}`,
        "unsupported_model_parameter",
      );
    }
    selected.set(parameter.id, parameter.value);
  }
  return {
    id: preferred.id,
    params: preferred.parameters.flatMap((parameter) => {
      const value = selected.get(parameter.id);
      return value === undefined ? [] : [{ id: parameter.id, value }];
    }),
  };
}

export function sanitizedCatalogError(error: unknown): {
  message: string;
  code?: string;
} {
  const mapped = {
    message: error instanceof Error ? error.message : "model discovery failed",
  };
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return { ...mapped, code: error.code };
  }
  return mapped;
}
