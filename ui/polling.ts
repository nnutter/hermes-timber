import { record } from "./contracts";

const NORMAL_POLL_MS = 15_000;
const MAX_POLL_MS = 300_000;

export function pollDelay(consecutiveFailures: number): number {
  return Math.min(
    NORMAL_POLL_MS * 2 ** Math.min(consecutiveFailures, 5),
    MAX_POLL_MS,
  );
}

/** Electron may serialize HTTP failures as an Error message rather than fields. */
export function authenticationFailure(error: unknown): boolean {
  if (record(error)) {
    const status = error.status ?? error.statusCode;
    if (status === 401 || status === 403) return true;
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b(?:401|403)(?=[:\s]|$)|\bno_cookie\b|\bunauthenticated\b|silent sign-in for this gateway failed|OAuth session partition is unavailable/i.test(
    text,
  );
}
