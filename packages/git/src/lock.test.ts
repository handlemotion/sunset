import { describe, expect, it } from "vitest";

import { RepoLock } from "./lock.js";

function size(lock: RepoLock): number {
  return (lock as unknown as { chains: Map<string, Promise<unknown>> }).chains
    .size;
}

describe("RepoLock", () => {
  it("serializes followers and removes completed chains for distinct repositories", async () => {
    const lock = new RepoLock();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = lock.run("repo-a", async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    const follower = lock.run("repo-a", async () => {
      order.push("follower");
    });
    await lock.run("repo-b", async () => {
      order.push("other-repo");
    });

    expect(order).toEqual(["first-start", "other-repo"]);
    releaseFirst?.();
    await Promise.all([first, follower]);
    expect(order).toEqual([
      "first-start",
      "other-repo",
      "first-end",
      "follower",
    ]);

    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        lock.run(`repo-${index}`, async () => undefined),
      ),
    );
    expect(size(lock)).toBe(0);
  });
});
