/**
 * Checks if a landing page responds with HTTP 200-299 within the timeout.
 */
export async function checkLandingPageHealth(url: string, timeoutMs = 10000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "AdAutopilot-HealthCheck/1.0" },
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
