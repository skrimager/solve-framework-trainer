import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { hashToSearch } from "@/lib/hashLocation";
import { ROUTES } from "@/lib/routes";

// Landing page for the link emailed by /api/manager/forgot-password:
// "#/reset-password?token=...". Same query-string-from-hash pattern already
// used by register.tsx (?code=), office-setup.tsx (?session_id=), and
// message-coach.tsx — wouter's hash router doesn't parse "?query" itself, so
// the token is read directly off window.location.hash via hashToSearch.
const BLUE = "#2563EB";
const ORANGE = "#E06D00";

export default function ManagerResetPassword() {
  const token = useMemo(
    () => new URLSearchParams(hashToSearch(window.location.hash)).get("token") ?? "",
    [],
  );
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "invalid">("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [, navigate] = useLocation();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setErrorMessage("Passwords don't match.");
      return;
    }
    setErrorMessage("");
    setIsSubmitting(true);
    try {
      await apiRequest("POST", "/api/manager/reset-password", { token, newPassword });
      setStatus("success");
    } catch (err: any) {
      setStatus("invalid");
      setErrorMessage(humanError(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="relative min-h-dvh flex items-center justify-center px-4 py-10 overflow-hidden"
      style={{ backgroundColor: "#F5F8FF" }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(37,99,235,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(37,99,235,0.06) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 40%, transparent 85%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 40%, transparent 85%)",
        }}
      />
      <div className="relative w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "#0A1A30" }} data-testid="text-reset-password-title">
            Choose a new password
          </h1>
        </div>
        <Card className="border-2 bg-white" style={{ borderColor: BLUE, boxShadow: "0 8px 40px rgba(37,99,235,0.12)" }}>
          <CardHeader>
            <CardTitle className="font-mono text-sm uppercase tracking-[0.2em]" style={{ color: "#0A1A30" }}>
              Manager Account Recovery
            </CardTitle>
            <CardDescription>This link can only be used once.</CardDescription>
          </CardHeader>
          <CardContent>
            {!token ? (
              <div className="space-y-4" data-testid="text-reset-password-missing-token">
                <p className="text-sm text-foreground">
                  This reset link is missing its token. Please request a new one.
                </p>
                <Button
                  type="button"
                  className="w-full"
                  style={{ backgroundColor: BLUE, color: "white" }}
                  onClick={() => navigate(ROUTES.managerForgotPassword)}
                  data-testid="button-request-new-reset-link"
                >
                  Request a new reset link
                </Button>
              </div>
            ) : status === "success" ? (
              <div className="space-y-4">
                <p className="text-sm text-foreground" data-testid="text-reset-password-success">
                  Your password has been reset. You can now sign in.
                </p>
                <Button
                  type="button"
                  className="w-full"
                  style={{ backgroundColor: BLUE, color: "white" }}
                  onClick={() => navigate(ROUTES.commandCenter)}
                  data-testid="button-go-to-sign-in"
                >
                  Go to sign in
                </Button>
              </div>
            ) : status === "invalid" ? (
              <div className="space-y-4">
                <p className="text-sm text-foreground" data-testid="text-reset-password-invalid">
                  {errorMessage || "This reset link is invalid or has expired."}
                </p>
                <Button
                  type="button"
                  className="w-full"
                  style={{ backgroundColor: BLUE, color: "white" }}
                  onClick={() => navigate(ROUTES.managerForgotPassword)}
                  data-testid="button-request-new-reset-link"
                >
                  Request a new reset link
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="reset-new-password">New password</Label>
                  <Input
                    id="reset-new-password"
                    type="password"
                    data-testid="input-new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reset-confirm-password">Confirm new password</Label>
                  <Input
                    id="reset-confirm-password"
                    type="password"
                    data-testid="input-confirm-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </div>
                {errorMessage && (
                  <p className="text-sm" style={{ color: ORANGE }} data-testid="text-reset-password-error">
                    {errorMessage}
                  </p>
                )}
                <Button
                  type="submit"
                  className="w-full font-mono uppercase tracking-[0.18em]"
                  style={{ backgroundColor: BLUE, color: "white" }}
                  disabled={isSubmitting}
                  data-testid="button-submit-reset-password"
                >
                  {isSubmitting ? "Resetting..." : "Reset password"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => navigate(ROUTES.commandCenter)}
            className="font-medium hover:underline"
            style={{ color: ORANGE }}
            data-testid="link-back-to-command-center"
          >
            ← Back to Command Center sign in
          </button>
        </p>
      </div>
    </div>
  );
}

function humanError(err: any): string {
  const msg = String(err?.message ?? "");
  // apiRequest throws "<status>: <body>"; surface the server's message when present.
  const match = msg.match(/^\d+:\s*([\s\S]*)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.message) return parsed.message;
    } catch {
      if (match[1]) return match[1];
    }
  }
  return "This reset link is invalid or has expired.";
}
