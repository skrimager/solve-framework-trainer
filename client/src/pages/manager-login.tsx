import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { wrongCredentialTypeRedirect } from "@/lib/routes";

// Manager command-center login. Same backend flow as the consultant login
// (single POST /api/login; role is backend-derived), but deliberately styled to
// look nothing like the dark orange consultant screen: a bright, light "control
// room" with blue and orange accents. Signing in swaps this route to the manager
// dashboard (see CommandCenter in App.tsx), so this component never navigates on
// its own success.
const BLUE = "#2563EB";
const ORANGE = "#E06D00";

export default function ManagerLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [wrongType, setWrongType] = useState<{ redirectTo: string; message: string } | null>(null);
  const { setUser } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setWrongType(null);
    try {
      const res = await apiRequest("POST", "/api/login", { username, password });
      const loggedInUser = await res.json();
      // Credentials are valid; if they belong to a consultant account, don't sign
      // them in here. Point them at Practice to sign in there (no cross-form
      // auto-submit of credentials).
      const mismatch = wrongCredentialTypeRedirect("manager", loggedInUser.role);
      if (mismatch) {
        setWrongType(mismatch);
        return;
      }
      setUser(loggedInUser);
    } catch (err: any) {
      toast({
        title: "Access denied",
        description: "Check your username and password and try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="relative min-h-dvh flex items-center justify-center px-4 py-10 overflow-hidden"
      style={{ backgroundColor: "#F5F8FF" }}
    >
      {/* Light command-center grid overlay in blue */}
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
          <img
            src="/solve-logo-square.png"
            alt="SOLVE Framework"
            className="mx-auto h-[72px] w-auto max-w-full rounded-xl"
            data-testid="img-solve-logo"
          />
          <div className="flex items-center justify-center gap-2">
            <span
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ backgroundColor: ORANGE, boxShadow: "0 0 8px rgba(224,109,0,0.6)" }}
              aria-hidden="true"
            />
            <span
              className="font-mono text-[11px] uppercase tracking-[0.25em]"
              style={{ color: BLUE }}
              data-testid="text-command-status"
            >
              Office Command · Live
            </span>
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ color: "#0A1A30" }}
            data-testid="text-manager-title"
          >
            Command Center · Manager Login
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-manager-hero">
            See who's practicing, who's improving, who's ready.
          </p>
        </div>
        <Card
          className="border-2 bg-white"
          style={{
            borderColor: BLUE,
            boxShadow: "0 8px 40px rgba(37,99,235,0.12)",
          }}
        >
          <CardHeader>
            <CardTitle className="font-mono text-sm uppercase tracking-[0.2em]" style={{ color: "#0A1A30" }}>
              Manager Access
            </CardTitle>
            <CardDescription>Sign in to your office command center.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label
                  htmlFor="manager-username"
                  className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground"
                >
                  Username
                </Label>
                <Input
                  id="manager-username"
                  data-testid="input-manager-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="manager-password"
                  className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground"
                >
                  Password
                </Label>
                <Input
                  id="manager-password"
                  type="password"
                  data-testid="input-manager-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full font-mono uppercase tracking-[0.18em]"
                style={{ backgroundColor: BLUE, color: "white" }}
                disabled={isSubmitting}
                data-testid="button-manager-login"
              >
                {isSubmitting ? "Authorizing..." : "Enter command center"}
              </Button>
            </form>
            {wrongType && (
              <div
                className="mt-4 rounded-md border p-3 text-sm"
                style={{ borderColor: ORANGE, backgroundColor: "rgba(224,109,0,0.08)" }}
                data-testid="text-wrong-credential-type"
              >
                <p className="text-foreground">{wrongType.message}</p>
                <button
                  type="button"
                  onClick={() => navigate(wrongType.redirectTo)}
                  className="mt-2 font-medium hover:underline"
                  style={{ color: ORANGE }}
                  data-testid="button-go-practice"
                >
                  Go to Practice
                </button>
              </div>
            )}
          </CardContent>
        </Card>
        <p className="text-center text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => navigate("/practice")}
            className="font-medium hover:underline"
            style={{ color: ORANGE }}
            data-testid="link-consultant-login"
          >
            Looking for the consultant practice login? →
          </button>
        </p>
      </div>
    </div>
  );
}
