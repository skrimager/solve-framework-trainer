import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminApi } from "@/lib/adminApi";

export default function AdminLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, navigate] = useLocation();

  // If a valid admin session already exists, skip straight to the dashboard.
  useEffect(() => {
    adminApi.me().then((me) => {
      if (me) navigate("/admin");
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await adminApi.login(username, password);
      navigate("/admin");
    } catch {
      setError("Invalid username or password.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-10" style={{ backgroundColor: "#05162D" }}>
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-3">
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ backgroundColor: "#0A1A30", boxShadow: "0 8px 30px rgba(224,109,0,0.35)" }}
            aria-hidden="true"
          >
            <span className="text-2xl font-bold" style={{ color: "#F1830D" }}>S</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Solve Admin</h1>
          <p className="text-sm text-white/60">Internal administration console.</p>
        </div>
        <Card className="border-2" style={{ borderColor: "#E06D00", backgroundColor: "#0A1A30" }}>
          <CardHeader>
            <CardTitle className="text-lg text-white">Sign in</CardTitle>
            <CardDescription className="text-white/60">Authorized personnel only.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="admin-username" className="text-white/80">Username</Label>
                <Input
                  id="admin-username"
                  data-testid="input-admin-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  className="bg-white/5 text-white border-white/20"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-password" className="text-white/80">Password</Label>
                <Input
                  id="admin-password"
                  type="password"
                  data-testid="input-admin-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="bg-white/5 text-white border-white/20"
                  required
                />
              </div>
              {error && (
                <p className="text-sm" style={{ color: "#F1830D" }} data-testid="text-admin-login-error">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                style={{ backgroundColor: "#E06D00", color: "white" }}
                disabled={isSubmitting}
                data-testid="button-admin-login"
              >
                {isSubmitting ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
