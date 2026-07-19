import { ReactNode } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { LogOut, ArrowLeft, ClipboardCheck, Award } from "lucide-react";
import solveLogo from "@assets/solve-framework-logo.png";

export function AppShell({
  title,
  children,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  /** Compact mode: shrinks header, removes page padding — used by full-height screens like the roleplay chat so content fills the viewport correctly under the on-screen keyboard. */
  compact?: boolean;
}) {
  const { user, setUser } = useAuth();
  const [, navigate] = useLocation();

  return (
    <div className={compact ? "flex flex-col" : "min-h-dvh bg-background"} style={compact ? { height: "100%" } : undefined}>
      <header className="border-b bg-card shrink-0">
        <div className={`max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-4 ${compact ? "py-2" : "py-4"}`}>
          <div className="flex items-center gap-3 min-w-0">
            <img src={solveLogo} alt="The SOLVE Framework" className="h-8 w-auto shrink-0" data-testid="img-solve-logo" />
            <div className="min-w-0">
              <h1 className="text-sm font-semibold leading-tight truncate" data-testid="text-page-title">{title}</h1>
              {!compact && <p className="text-xs text-muted-foreground truncate">SOLVE Platform™ - discovery training</p>}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {/* Persistent path into SOLVE Academy, reachable from day one at any
                level (not gated behind Advanced) so every consultant can find
                the certification path from their first session. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/academy")}
              className="gap-1.5"
              style={{ borderColor: "#0A1A30", color: "#0A1A30" }}
              data-testid="link-nav-academy"
            >
              <Award className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Academy</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/real-conversations")}
              className="gap-1.5"
              style={{ borderColor: "#0A1A30", color: "#0A1A30" }}
              data-testid="link-nav-real-conversations"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Real Conversations</span>
            </Button>
            <a
              href="https://solveframework.com"
              className="text-xs font-medium hidden sm:inline-flex items-center gap-1 hover:underline"
              style={{ color: "#E06D00" }}
              data-testid="link-back-to-solveframework"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to SOLVE Framework
            </a>
            <span className="text-xs text-muted-foreground hidden sm:inline" data-testid="text-current-user">
              {user?.displayName} · {user?.role}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setUser(null);
                navigate("/");
              }}
              aria-label="Sign out"
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>
      {compact ? (
        <main className="flex-1 min-h-0 max-w-5xl w-full mx-auto px-2 sm:px-6 py-2 sm:py-6 flex flex-col">{children}</main>
      ) : (
        <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6">{children}</main>
      )}
    </div>
  );
}
