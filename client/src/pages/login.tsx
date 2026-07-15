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
import trainerPhoto from "@assets/trainer-photo-1.png";

export default function Login() {
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
          <div
            className="mx-auto w-24 h-24 rounded-3xl flex items-center justify-center shadow-lg"
            style={{ backgroundColor: "#0A1A30", boxShadow: "0 8px 30px rgba(224,109,0,0.35)" }}
            aria-hidden="true"
          >
            <SolveMark />
          </div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-app-title">Practice Scenarios</h1>
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
              Manager?{" "}
              <button
                type="button"
                onClick={() => navigate("/manager-login")}
                className="font-medium hover:underline"
                data-testid="link-manager-login"
              >
                Command center login
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

function SolveMark() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" aria-label="SOLVE Framework logo">
      <path
        d="M4 16c0-2 1.5-3 3-3s2 1 3 1 1.5-1 3-1 3 1 3 3"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="15.5" cy="8" r="3.25" fill="#E06D00" />
    </svg>
  );
}
