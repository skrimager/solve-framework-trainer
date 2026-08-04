import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { ROUTES } from "@/lib/routes";

// Request a reminder of the username(s) on file for a Command Center account.
// Same generic-response shape as manager-forgot-password.tsx: the server
// never reveals whether the email matched an account, so this page has one
// success state regardless of the outcome.
const BLUE = "#2563EB";
const ORANGE = "#E06D00";

export default function ManagerForgotUsername() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [, navigate] = useLocation();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await apiRequest("POST", "/api/manager/forgot-username", { email });
    } catch {
      // Same generic confirmation either way — see manager-forgot-password.tsx.
    } finally {
      setIsSubmitting(false);
      setSubmitted(true);
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
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "#0A1A30" }} data-testid="text-forgot-username-title">
            Recover your username
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter the email on file for your Command Center account.
          </p>
        </div>
        <Card className="border-2 bg-white" style={{ borderColor: BLUE, boxShadow: "0 8px 40px rgba(37,99,235,0.12)" }}>
          <CardHeader>
            <CardTitle className="font-mono text-sm uppercase tracking-[0.2em]" style={{ color: "#0A1A30" }}>
              Manager Account Recovery
            </CardTitle>
            <CardDescription>We'll email the username(s) on file if an account matches.</CardDescription>
          </CardHeader>
          <CardContent>
            {submitted ? (
              <div className="space-y-4">
                <p className="text-sm text-foreground" data-testid="text-forgot-username-confirmation">
                  If an account exists for that email, we've sent the username(s) on file.
                </p>
                <Button
                  type="button"
                  className="w-full"
                  style={{ backgroundColor: BLUE, color: "white" }}
                  onClick={() => navigate(ROUTES.commandCenter)}
                  data-testid="button-back-to-manager-login"
                >
                  Back to sign in
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="forgot-username-email">Email</Label>
                  <Input
                    id="forgot-username-email"
                    type="email"
                    data-testid="input-forgot-username-email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full font-mono uppercase tracking-[0.18em]"
                  style={{ backgroundColor: BLUE, color: "white" }}
                  disabled={isSubmitting}
                  data-testid="button-submit-forgot-username"
                >
                  {isSubmitting ? "Sending..." : "Send username reminder"}
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
