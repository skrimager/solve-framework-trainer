import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";
import { postLoginPath, wrongCredentialTypeRedirect } from "@/lib/routes";
import trainerPhoto from "@assets/trainer-photo-1.png";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [wrongType, setWrongType] = useState<{ redirectTo: string; message: string } | null>(null);
  const { user, setUser } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    if (user) {
      navigate(postLoginPath(user.role));
    }
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setWrongType(null);
    try {
      const res = await apiRequest("POST", "/api/login", { username, password });
      const loggedInUser = await res.json();
      // Credentials are valid; if they belong to a manager account, don't sign
      // them in on the consultant form. Point them at the Command Center to sign
      // in there (no cross-form auto-submit of credentials).
      const mismatch = wrongCredentialTypeRedirect("consultant", loggedInUser.role);
      if (mismatch) {
        setWrongType(mismatch);
        return;
      }
      setUser(loggedInUser);
    } catch (err: any) {
      toast({
        title: "Login failed",
        description: "Check your username and password and try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-4xl grid md:grid-cols-2 gap-8 items-center">
        <div className="hidden md:block">
          <div className="relative rounded-2xl overflow-hidden border border-card-border">
            <img
              src={trainerPhoto}
              alt="Consultative discovery conversation between a trainer and client"
              className="w-full h-full object-cover aspect-[4/3]"
              data-testid="img-training-photo"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-background/10 to-transparent" />
            <p className="absolute bottom-4 left-4 right-4 text-sm text-foreground/90 font-medium">
              Practice real discovery conversations. Get SOLVE Framework Certified.
            </p>
          </div>
        </div>
        <div className="w-full max-w-sm mx-auto space-y-6">
        <div className="text-center space-y-4">
          <img
            src="/solve-wordmark-bigtag-transparent.png"
            alt="SOLVE Framework - Practice. Performance. Period."
            className="mx-auto h-[72px] w-auto max-w-full"
            data-testid="img-solve-logo"
          />
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-app-title">Consultant Practice Login</h1>
          <p className="text-sm text-muted-foreground">Consultant access to SOLVE Platform™ discovery practice.</p>
        </div>
        <Card className="border-2" style={{ borderColor: "#E06D00" }}>
          <CardHeader>
            <CardTitle className="text-lg">Consultant Access</CardTitle>
            <CardDescription>Sign in with your pilot credentials to start practicing.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  data-testid="input-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  data-testid="input-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                style={{ backgroundColor: "#E06D00", color: "white" }}
                disabled={isSubmitting}
                data-testid="button-login"
              >
                {isSubmitting ? "Signing in..." : "Sign in"}
              </Button>
            </form>
            {wrongType && (
              <div
                className="mt-4 rounded-md border p-3 text-sm"
                style={{ borderColor: "#E06D00", backgroundColor: "rgba(224,109,0,0.08)" }}
                data-testid="text-wrong-credential-type"
              >
                <p className="text-foreground">{wrongType.message}</p>
                <button
                  type="button"
                  onClick={() => navigate(wrongType.redirectTo)}
                  className="mt-2 font-medium hover:underline"
                  style={{ color: "#E06D00" }}
                  data-testid="button-go-command-center"
                >
                  Go to the Command Center
                </button>
              </div>
            )}
            <p className="mt-4 text-center text-sm text-muted-foreground">
              New here?{" "}
              <button
                type="button"
                onClick={() => navigate("/register")}
                className="font-medium hover:underline"
                style={{ color: "#E06D00" }}
                data-testid="link-register"
              >
                Create an account
              </button>
            </p>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => navigate("/command-center")}
                className="font-medium hover:underline"
                data-testid="link-manager-login"
              >
                Are you a manager? Command Center is here →
              </button>
            </p>
          </CardContent>
        </Card>
        <div className="text-center">
          <a
            href="https://solveframework.com"
            className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
            style={{ color: "#E06D00" }}
            data-testid="link-back-to-solveframework"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to SOLVE Framework
          </a>
        </div>
        </div>
      </div>
    </div>
  );
}
