type Task<T> = () => Promise<T>;

export class RepoLock {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(repoRoot: string, task: Task<T>): Promise<T> {
    const previous = this.chains.get(repoRoot) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => gate);
    this.chains.set(repoRoot, chained);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.chains.get(repoRoot) === chained) {
        this.chains.delete(repoRoot);
      }
    }
  }
}
