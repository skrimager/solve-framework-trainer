// Device fingerprinting for the free demo's fair-use caps. Uses the open-source
// (MIT) FingerprintJS v3 build to derive a stable per-browser visitorId. This is
// a behind-the-scenes abuse signal only: it adds no UI and never blocks the
// legitimate first-time flow. The visitorId is sent with the session-start call
// so the server can cap sessions per device regardless of how many emails are
// tried. Failures are swallowed (returns undefined) so fingerprinting can never
// break the demo; the server simply falls back to the per-email and per-IP caps.
import FingerprintJS from "@fingerprintjs/fingerprintjs";

let cached: Promise<string | undefined> | null = null;

export function getDeviceFingerprint(): Promise<string | undefined> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const agent = await FingerprintJS.load();
      const result = await agent.get();
      return result.visitorId;
    } catch {
      return undefined;
    }
  })();
  return cached;
}
