import { afterEach, expect, it, vi } from "vitest";

import { BoxClient } from "./box.js";

afterEach(() => vi.restoreAllMocks());

it("passes an independent kill timeout to Box and bounds the remote wait", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.command.slice(0, 3)).toEqual([
        "timeout",
        "--signal=KILL",
        "0.02s",
      ]);
      const signal = init?.signal;
      if (!signal) throw new Error("missing deadline");
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("bounded_timeout")),
          {
            once: true,
          },
        ),
      );
    });
  await expect(
    new BoxClient("test", "box").exec(["sleep", "100"], 20),
  ).rejects.toThrow("bounded_timeout");
  expect(fetch).toHaveBeenCalledOnce();
});
