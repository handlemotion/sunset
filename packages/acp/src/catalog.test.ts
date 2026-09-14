import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./engines.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./engines.js")>();
  return {
    ...original,
    resolveEngineSpawn: vi.fn(async () => ({
      command: "codex-acp",
      args: [],
    })),
  };
});

vi.mock("./client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client.js")>();
  return {
    ...original,
    stdioConnector: vi.fn(() => async () => ({
      request: vi.fn(async (method: string) => {
        if (method === "initialize") return { protocolVersion: 1 };
        if (method === "session/new") {
          return {
            sessionId: "catalog-probe",
            models: {
              availableModels: [
                { modelId: "gpt-test[low]", name: "GPT Test" },
                { modelId: "gpt-test[high]", name: "GPT Test" },
              ],
              currentModelId: "gpt-test[low]",
            },
          };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      notify: vi.fn(),
      close: vi.fn(),
    })),
  };
});

import { listModels, resetCatalogCache } from "./catalog.js";
import { stdioConnector } from "./client.js";

describe("codex catalog cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCatalogCache();
    vi.mocked(stdioConnector).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one in-flight probe and re-probes after one hour", async () => {
    const [first, second] = await Promise.all([
      listModels("codex"),
      listModels("codex"),
    ]);
    expect(first).toBe(second);
    expect(first[0]?.id).toBe("codex:gpt-test");
    expect(stdioConnector).toHaveBeenCalledTimes(1);

    await listModels("codex");
    expect(stdioConnector).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    const third = await listModels("codex");
    expect(third[0]?.id).toBe("codex:gpt-test");
    expect(stdioConnector).toHaveBeenCalledTimes(2);

    resetCatalogCache();
    await listModels("codex");
    expect(stdioConnector).toHaveBeenCalledTimes(3);
  });
});
