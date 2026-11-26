import { fetchWithTimeout } from "./fetchWithTimeout";

/**
 * Checks if a landing page responds with HTTP 200-299 within the timeout.
 */
export async function checkLandingPageHealth(url: string, timeoutMs = 10000): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: { "User-Agent": "AdAutopilot-HealthCheck/1.0" } },
      timeoutMs
    );
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
