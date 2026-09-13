import { z } from "zod";

const BOX_API = "https://us-east-1.box.upstash.com";
const DEFAULT_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export type BoxNetworkPolicy = {
  mode: "custom";
  allowed_domains: string[];
  denied_cidrs: string[];
};

export type BoxOptions = {
  apiKey: string;
  runtime?: string;
  labels?: string[];
  networkPolicy?: BoxNetworkPolicy;
};

export type BoxExecResult = {
  exitCode: number;
  output: string;
  error: string;
};

export class BoxClient {
  constructor(
    private readonly apiKey: string,
    readonly id: string,
  ) {}

  static async persistent(
    options: BoxOptions & { name: string },
  ): Promise<BoxClient> {
    let response = await fetch(
      `${BOX_API}/v2/box/${encodeURIComponent(options.name)}`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: { "x-box-api-key": options.apiKey },
      },
    );
    if (response.status === 404) {
      response = await fetch(`${BOX_API}/v2/box`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json",
          "x-box-api-key": options.apiKey,
        },
        body: JSON.stringify({
          name: options.name,
          labels: options.labels ?? ["sunset"],
          runtime: options.runtime ?? "node",
          keep_alive: false,
          ...(options.networkPolicy
            ? { network_policy: options.networkPolicy }
            : {}),
        }),
      });
    }
    if (!response.ok) throw new Error(`box_${response.status}`);
    let data = z
      .object({ id: z.string(), status: z.string() })
      .parse(await response.json());
    for (let count = 0; data.status === "creating" && count < 150; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      data = await new BoxClient(options.apiKey, data.id).request(
        "GET",
        "",
        undefined,
        z.object({ id: z.string(), status: z.string() }),
      );
    }
    if (data.status === "paused") {
      await new BoxClient(options.apiKey, data.id).request("POST", "/resume");
    } else if (!new Set(["idle", "running"]).has(data.status)) {
      throw new Error("box_unavailable");
    }
    return new BoxClient(options.apiKey, data.id);
  }

  static async ephemeral(
    options: BoxOptions & { ttl?: number },
  ): Promise<BoxClient> {
    const response = await fetch(`${BOX_API}/v2/box`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "x-box-api-key": options.apiKey,
      },
      body: JSON.stringify({
        ephemeral: true,
        ttl: options.ttl ?? 1_800,
        runtime: options.runtime ?? "node",
        labels: options.labels ?? ["sunset", "ephemeral"],
        ...(options.networkPolicy
          ? { network_policy: options.networkPolicy }
          : {}),
      }),
    });
    if (!response.ok) throw new Error(`box_${response.status}`);
    const data = z.object({ id: z.string() }).parse(await response.json());
    return new BoxClient(options.apiKey, data.id);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    schema?: z.ZodType<T, z.ZodTypeDef, unknown>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const response = await fetch(`${BOX_API}/v2/box/${this.id}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "x-box-api-key": this.apiKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`box_${response.status}`);
    if (!schema) return undefined as T;
    return schema.parse(await response.json());
  }

  exec(command: string[], timeoutMs = 10_000): Promise<BoxExecResult> {
    return this.request(
      "POST",
      "/exec",
      {
        command: [
          "timeout",
          "--signal=KILL",
          `${Math.max(0.001, timeoutMs / 1_000)}s`,
          ...command,
        ],
      },
      z
        .object({
          exit_code: z.number(),
          output: z.string(),
          error: z.string().optional(),
        })
        .transform(({ exit_code, output, error }) => ({
          exitCode: exit_code,
          output,
          error: error ?? "",
        })),
      timeoutMs + 1_000,
    );
  }

  write(path: string, content: string, encoding?: "base64"): Promise<void> {
    return this.request("POST", "/files/write", {
      path,
      content,
      ...(encoding ? { encoding } : {}),
    });
  }

  async read(path: string): Promise<string | null> {
    const response = await fetch(
      `${BOX_API}/v2/box/${this.id}/files/read?path=${encodeURIComponent(path)}`,
      {
        headers: { "x-box-api-key": this.apiKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`box_${response.status}`);
    return z.object({ content: z.string() }).parse(await response.json())
      .content;
  }

  delete(): Promise<void> {
    return this.request("DELETE", "");
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

/** Fetch a repository tarball at a SHA from GitHub, base64-encoded. */
export async function repositoryBundle(input: {
  repo: string;
  sha: string;
  token: string;
  maxBytes?: number;
}): Promise<string> {
  const response = await fetch(
    `https://api.github.com/repos/${input.repo}/tarball/${input.sha}`,
    {
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "sunset",
      },
    },
  );
  if (!response.ok) throw new Error(`github_bundle_${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > (input.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES)) {
    throw new Error("repository_bundle_too_large");
  }
  return arrayBufferToBase64(buffer);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name}_missing`);
  return normalized;
}
