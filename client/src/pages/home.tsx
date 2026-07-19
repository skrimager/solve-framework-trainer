import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GraduationCap, LayoutDashboard, PlayCircle, ArrowLeft } from "lucide-react";

// Root chooser. Minimal, on-brand entry point that routes each kind of visitor to
// the right place: consultants to practice, managers to the command center, and
// prospects to the free demo. Uses the same dark navy + orange tokens as the rest
// of the app so it reads as one product, not a new visual system.
export default function Home() {
  const [, navigate] = useLocation();

  const options = [
    {
      to: "/practice",
      icon: GraduationCap,
      title: "I'm here to practice",
      description: "Consultant discovery practice and certification.",
      testId: "link-choose-practice",
    },
    {
      to: "/command-center",
      icon: LayoutDashboard,
      title: "I'm a manager",
      description: "Command Center: see who's practicing and improving.",
      testId: "link-choose-command-center",
    },
    {
      to: "/demo",
      icon: PlayCircle,
      title: "Try the free demo",
      description: "A guided taste of a live discovery conversation.",
      testId: "link-choose-demo",
    },
  ] as const;

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md mx-auto space-y-6">
        <div className="text-center space-y-4">
          <div
            className="mx-auto w-20 h-20 rounded-3xl flex items-center justify-center shadow-lg"
            style={{ backgroundColor: "#0A1A30", boxShadow: "0 8px 30px rgba(224,109,0,0.35)" }}
            aria-hidden="true"
          >
            <SolveMark />
          </div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-home-title">
            Welcome to SOLVE Platform™
          </h1>
          <p className="text-sm text-muted-foreground">Where would you like to go?</p>
        </div>

        <Card className="border-2" style={{ borderColor: "#E06D00" }}>
          <CardHeader>
            <CardTitle className="text-lg">Choose your entrance</CardTitle>
            <CardDescription>Pick the option that describes you.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {options.map((opt) => (
              <Button
                key={opt.to}
                type="button"
                variant="outline"
                className="w-full h-auto justify-start gap-3 py-4 text-left"
                onClick={() => navigate(opt.to)}
                data-testid={opt.testId}
              >
                <opt.icon className="w-5 h-5 shrink-0" style={{ color: "#E06D00" }} />
                <span className="flex flex-col">
                  <span className="font-semibold">{opt.title}</span>
                  <span className="text-xs text-muted-foreground">{opt.description}</span>
                </span>
              </Button>
            ))}
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
  );
}

function SolveMark() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-label="SOLVE Framework logo">
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
