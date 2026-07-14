import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// Manager command-center login. Same backend flow as the consultant login at
// "/" (single POST /api/login; role is backend-derived), just wrapped in a
// distinct dark "control room" chrome so managers have a recognizable entry
// point separate from the light consultant screen and the lime admin vault.
export default function ManagerLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { user, setUser } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    if (user) {
      navigate(user.role === "consultant" ? "/scenarios" : "/dashboard");
    }
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/login", { username, password });
      const loggedInUser = await res.json();
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
      style={{ backgroundColor: "#05162D" }}
    >
      {/* Command-center grid overlay */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(224,109,0,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(224,109,0,0.08) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at center, black 40%, transparent 85%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 40%, transparent 85%)",
        }}
      />
      <div className="relative w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ backgroundColor: "#0A1A30", boxShadow: "0 8px 30px rgba(224,109,0,0.35)" }}
            aria-hidden="true"
          >
            <span className="text-2xl font-bold" style={{ color: "#F1830D" }}>S</span>
          </div>
          <div className="flex items-center justify-center gap-2">
            <span
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ backgroundColor: "#F1830D", boxShadow: "0 0 8px #F1830D" }}
              aria-hidden="true"
            />
            <span
              className="font-mono text-[11px] uppercase tracking-[0.25em] text-white/70"
              data-testid="text-command-status"
            >
              Office Command · Live
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white" data-testid="text-manager-title">
            Command Center
          </h1>
          <p className="text-sm text-white/60">Oversee your team's live discovery practice.</p>
        </div>
        <Card
          className="border-2"
          style={{
            borderColor: "#E06D00",
            backgroundColor: "#0A1A30",
            boxShadow: "0 8px 40px rgba(224,109,0,0.15)",
          }}
        >
          <CardHeader>
            <CardTitle className="font-mono text-sm uppercase tracking-[0.2em] text-white">
              Manager Access
            </CardTitle>
            <CardDescription className="text-white/60">
              Sign in to your office command center.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label
                  htmlFor="manager-username"
                  className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/70"
                >
                  Username
                </Label>
                <Input
                  id="manager-username"
                  data-testid="input-manager-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="bg-white/5 text-white border-white/20"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="manager-password"
                  className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/70"
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
                  className="bg-white/5 text-white border-white/20"
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full font-mono uppercase tracking-[0.18em]"
                style={{ backgroundColor: "#E06D00", color: "white" }}
                disabled={isSubmitting}
                data-testid="button-manager-login"
              >
                {isSubmitting ? "Authorizing..." : "Enter command center"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-center text-xs text-white/50">
          Not a manager?{" "}
          <button
            type="button"
            onClick={() => navigate("/")}
            className="font-medium hover:underline"
            style={{ color: "#F1830D" }}
            data-testid="link-consultant-login"
          >
            Consultant login
          </button>
        </p>
      </div>
    </div>
  );
}
