/**
 * Default timeout for outbound HTTP calls (MASTER_SPEC 1.4-3).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15000;

/**
 * fetch() wrapper that always aborts after `timeoutMs`.
 * All outbound HTTP calls in Cloud Functions must go through this helper
 * (enforced by scripts/harness rule SPEC-1.4.3/fetch-needs-timeout).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
