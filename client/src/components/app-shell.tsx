import { ReactNode } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { LogOut, ArrowLeft } from "lucide-react";

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
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: "#0A1A30" }} aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M4 16c0-2 1.5-3 3-3s2 1 3 1 1.5-1 3-1 3 1 3 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="15.5" cy="8" r="3.25" fill="#E06D00" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold leading-tight truncate" data-testid="text-page-title">{title}</h1>
              {!compact && <p className="text-xs text-muted-foreground truncate">SOLVE Framework Trainer - discovery training</p>}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
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
