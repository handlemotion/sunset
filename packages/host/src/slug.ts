import { HostError } from "./errors.js";

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug) || slug.includes("..")) {
    throw new HostError(`invalid slug: ${slug}`, "invalid_slug");
  }
  return slug;
}
