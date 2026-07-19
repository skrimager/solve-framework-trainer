// Canonical hash routes for the app. Centralized so the route table, in-app
// links, and tests all agree on one source of truth.
export const ROUTES = {
  home: "/",
  practice: "/practice",
  commandCenter: "/command-center",
  academy: "/academy",
  demo: "/demo",
  scenarios: "/scenarios",
  register: "/register",
} as const;

// Old paths kept working so existing bookmarks, welcome-email links, and
// registration hand-offs never 404. Each maps to its new canonical equivalent
// and is wired up as a <Redirect> in the route table.
export const LEGACY_REDIRECTS: Record<string, string> = {
  "/login": ROUTES.practice,
  "/manager-login": ROUTES.commandCenter,
  "/dashboard": ROUTES.commandCenter,
  "/certification": ROUTES.academy,
};

export type LoginFormKind = "consultant" | "manager";

// Positive account-type mismatch, computed only AFTER a successful /api/login.
// The server has already validated the credentials, so the returned role is
// authoritative and safe to reveal to the person who just proved they own the
// account. Because this never runs on a failed login, it cannot be used to probe
// whether an unrelated email exists (no account enumeration): a wrong password
// still yields the generic 401 with no role hint.
export function wrongCredentialTypeRedirect(
  form: LoginFormKind,
  accountRole: string,
): { redirectTo: string; message: string } | null {
  if (form === "consultant" && accountRole !== "consultant") {
    return {
      redirectTo: ROUTES.commandCenter,
      message: "That's a manager account. Let's take you to the Command Center →",
    };
  }
  if (form === "manager" && accountRole === "consultant") {
    return {
      redirectTo: ROUTES.practice,
      message: "That's a consultant account. Let's take you to Practice →",
    };
  }
  return null;
}

// Where an authenticated user belongs, by role. Consultants practice; managers
// (and qa) run the command center.
export function postLoginPath(role: string): string {
  return role === "consultant" ? ROUTES.scenarios : ROUTES.commandCenter;
}
