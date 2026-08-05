import { useState } from "react";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { wrongCredentialTypeRedirect, ROUTES } from "@/lib/routes";
import { Lock, User, Eye, EyeOff } from "lucide-react";

// Manager command-center login. Same backend flow as the consultant login
// (single POST /api/login; role is backend-derived), but deliberately styled
// as a cinematic dark "mission control room": a full-bleed navy backdrop with
// a glowing horizon arc, a world-map dot field, and a glassmorphism access
// panel. Signing in swaps this route to the manager dashboard (see
// CommandCenter in App.tsx), so this component never navigates on its own
// success.
const ORANGE = "#E06D00";
const TAGLINE = "PRACTICE. PERFORMANCE. PERIOD.";

// Ambient, non-interactive gauge showing a static placeholder metric. Purely
// decorative background dressing, not real data.
function SuccessGauge() {
  const pct = 92;
  const r = 40;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(148,197,255,0.15)" strokeWidth="6" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke={ORANGE}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 50 50)"
        opacity="0.85"
      />
      <text x="50" y="47" textAnchor="middle" fontSize="20" fontWeight="700" fill="#F3F6FC">
        {pct}%
      </text>
      <text
        x="50"
        y="63"
        textAnchor="middle"
        fontSize="8"
        letterSpacing="1.5"
        fill="rgba(148,197,255,0.7)"
      >
        SUCCESS
      </text>
    </svg>
  );
}

// Ambient bar-chart cluster, static placeholder heights only.
function BarCluster() {
  const bars = [40, 65, 50, 80, 60];
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full" aria-hidden="true">
      {bars.map((h, i) => (
        <rect
          key={i}
          x={6 + i * 19}
          y={58 - h * 0.55}
          width="12"
          height={h * 0.55}
          rx="2"
          fill={i % 2 === 0 ? ORANGE : "rgba(148,197,255,0.5)"}
          opacity="0.75"
        />
      ))}
    </svg>
  );
}

// Ambient sparkline, static placeholder path only.
function Sparkline() {
  return (
    <svg viewBox="0 0 100 40" className="w-full h-full" aria-hidden="true">
      <polyline
        points="2,32 18,24 34,28 50,14 66,18 82,6 98,10"
        fill="none"
        stroke="rgba(148,197,255,0.8)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="98" cy="10" r="3" fill={ORANGE} />
    </svg>
  );
}

// Inline SVG world-map dot field with a few glowing "tracked location" pips.
// Pure decoration, positions are illustrative silhouettes, not real geodata.
function WorldMapDots() {
  const dots: [number, number][] = [
    [40, 60], [55, 55], [70, 62], [90, 58], [110, 50], [130, 60], [150, 55],
    [45, 90], [65, 95], [85, 88], [105, 92], [125, 85], [145, 90], [165, 80],
    [60, 120], [80, 125], [100, 118], [120, 128], [140, 115], [160, 122],
    [175, 65], [190, 75], [200, 100], [185, 130], [155, 145], [95, 150],
  ];
  const glowing = new Set([1, 4, 9, 14, 19, 22]);
  return (
    <svg viewBox="0 0 220 180" className="w-full h-full" aria-hidden="true">
      {dots.map(([x, y], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={glowing.has(i) ? 2.6 : 1.4}
          fill={glowing.has(i) ? ORANGE : "rgba(148,197,255,0.45)"}
          opacity={glowing.has(i) ? 0.9 : 0.5}
        >
          {glowing.has(i) && (
            <animate attributeName="opacity" values="0.9;0.35;0.9" dur="2.6s" repeatCount="indefinite" />
          )}
        </circle>
      ))}
    </svg>
  );
}

// Faint desk/chair silhouettes for the very bottom edge of the room.
function DeskSilhouettes() {
  return (
    <svg
      viewBox="0 0 1440 120"
      preserveAspectRatio="none"
      className="w-full h-full"
      aria-hidden="true"
    >
      <rect x="60" y="70" width="180" height="10" rx="3" fill="#050C1C" opacity="0.8" />
      <rect x="90" y="40" width="20" height="35" rx="4" fill="#050C1C" opacity="0.8" />
      <rect x="190" y="40" width="20" height="35" rx="4" fill="#050C1C" opacity="0.8" />
      <path d="M120 100 q20 -45 60 -10 v20 h-60 z" fill="#050C1C" opacity="0.7" />

      <rect x="620" y="65" width="200" height="10" rx="3" fill="#050C1C" opacity="0.8" />
      <rect x="650" y="35" width="22" height="35" rx="4" fill="#050C1C" opacity="0.8" />
      <rect x="760" y="35" width="22" height="35" rx="4" fill="#050C1C" opacity="0.8" />
      <path d="M690 100 q22 -48 64 -10 v18 h-64 z" fill="#050C1C" opacity="0.7" />

      <rect x="1180" y="72" width="180" height="10" rx="3" fill="#050C1C" opacity="0.8" />
      <rect x="1210" y="42" width="20" height="35" rx="4" fill="#050C1C" opacity="0.8" />
      <rect x="1310" y="42" width="20" height="35" rx="4" fill="#050C1C" opacity="0.8" />
      <path d="M1240 100 q20 -45 60 -10 v20 h-60 z" fill="#050C1C" opacity="0.7" />
    </svg>
  );
}

export default function ManagerLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      className="relative min-h-dvh flex flex-col overflow-hidden"
      style={{ backgroundColor: "#050C1C" }}
    >
      {/* Base room gradient: deep navy with a glowing arc suggesting a curved
          control-room ceiling/horizon near the top. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 140% 60% at 50% -10%, rgba(37,99,235,0.35), rgba(5,12,28,0) 60%), " +
            "radial-gradient(ellipse 90% 45% at 50% 0%, rgba(224,109,0,0.12), rgba(5,12,28,0) 65%), " +
            "linear-gradient(180deg, #050C1C 0%, #060F22 45%, #04080f 100%)",
        }}
      />
      {/* Glowing horizon rings, like control-room ceiling light rings. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[-140px] -translate-x-1/2 w-[1400px] max-w-[220vw]"
      >
        <svg viewBox="0 0 1400 300" className="w-full h-auto">
          <ellipse cx="700" cy="150" rx="640" ry="140" fill="none" stroke="rgba(148,197,255,0.18)" strokeWidth="1.5" />
          <ellipse cx="700" cy="150" rx="520" ry="112" fill="none" stroke="rgba(148,197,255,0.14)" strokeWidth="1.5" />
          <ellipse cx="700" cy="150" rx="400" ry="86" fill="none" stroke="rgba(224,109,0,0.22)" strokeWidth="1.5" />
        </svg>
      </div>
      {/* Faint grid overlay for control-room texture. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,197,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148,197,255,0.05) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse at center, black 35%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 35%, transparent 80%)",
        }}
      />
      {/* World-map dot field, tucked to the left side. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-1/3 w-[260px] h-[220px] opacity-40 hidden md:block"
      >
        <WorldMapDots />
      </div>
      {/* Desk/chair silhouettes along the very bottom edge. */}
      <div aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 right-0 h-[110px] opacity-60">
        <DeskSilhouettes />
      </div>

      <div className="relative flex-1 flex items-center justify-center px-4 py-12">
        <div className="relative w-full max-w-md">
          {/* Ambient decorative data visualizations, desktop only. */}
          <div
            aria-hidden="true"
            className="hidden lg:block absolute -left-52 top-6 w-40 h-40 opacity-50 blur-[0.5px]"
          >
            <SuccessGauge />
          </div>
          <div
            aria-hidden="true"
            className="hidden lg:block absolute -right-48 top-4 w-36 h-24 opacity-45 blur-[0.5px]"
          >
            <BarCluster />
          </div>
          <div
            aria-hidden="true"
            className="hidden lg:block absolute -right-44 bottom-16 w-36 h-16 opacity-45 blur-[0.5px]"
          >
            <Sparkline />
          </div>

          <div className="relative space-y-6">
            <div className="text-center space-y-4">
              <img
                src="/solve-logo-square.png"
                alt="SOLVE Framework"
                className="mx-auto h-16 w-auto max-w-full rounded-xl"
                data-testid="img-solve-logo"
              />
              <div>
                <h1
                  className="text-4xl sm:text-5xl font-bold tracking-wide uppercase leading-none"
                  style={{
                    fontFamily: "'Oxanium', var(--font-sans)",
                    color: "#F3F6FC",
                    textShadow: "0 0 24px rgba(148,197,255,0.35)",
                  }}
                  data-testid="text-manager-title"
                >
                  Command Center
                </h1>
                <p
                  className="mt-2 text-base sm:text-lg font-bold uppercase tracking-[0.35em]"
                  style={{ color: ORANGE, textShadow: "0 0 16px rgba(224,109,0,0.5)" }}
                  data-testid="text-manager-subtitle"
                >
                  Manager Login
                </p>
              </div>
              <div className="flex items-center justify-center gap-3 pt-1">
                <span className="h-px w-16 bg-gradient-to-r from-transparent to-[rgba(148,197,255,0.5)]" />
                <span className="h-1 w-1 rounded-full" style={{ backgroundColor: ORANGE }} />
                <span className="h-px w-16 bg-gradient-to-l from-transparent to-[rgba(148,197,255,0.5)]" />
              </div>
              <p
                className="text-[11px] sm:text-xs font-semibold uppercase tracking-[0.3em]"
                style={{ color: "rgba(148,197,255,0.75)" }}
                data-testid="text-manager-tagline"
              >
                {TAGLINE}
              </p>
            </div>

            <div
              className="relative rounded-2xl p-6 sm:p-7"
              style={{
                backgroundColor: "rgba(9,18,38,0.72)",
                border: "1px solid rgba(224,109,0,0.35)",
                boxShadow:
                  "0 0 0 1px rgba(148,197,255,0.08), 0 0 40px rgba(224,109,0,0.18), 0 20px 60px rgba(0,0,0,0.55)",
                backdropFilter: "blur(14px)",
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <Lock className="w-4 h-4" style={{ color: ORANGE }} aria-hidden="true" />
                <span
                  className="font-mono text-xs uppercase tracking-[0.25em]"
                  style={{ color: "#F3F6FC" }}
                >
                  Manager Access
                </span>
              </div>
              <p className="text-sm mb-5" style={{ color: "rgba(210,222,242,0.65)" }}>
                Sign in to your Command Center.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label
                    htmlFor="manager-username"
                    className="font-mono text-[11px] uppercase tracking-[0.2em]"
                    style={{ color: "rgba(210,222,242,0.6)" }}
                  >
                    User Name
                  </Label>
                  <div className="relative">
                    <User
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
                      style={{ color: "rgba(148,197,255,0.7)" }}
                      aria-hidden="true"
                    />
                    <Input
                      id="manager-username"
                      data-testid="input-manager-username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      required
                      className="pl-9 text-white placeholder:text-slate-500"
                      style={{
                        backgroundColor: "rgba(5,12,28,0.6)",
                        borderColor: "rgba(148,197,255,0.25)",
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label
                    htmlFor="manager-password"
                    className="font-mono text-[11px] uppercase tracking-[0.2em]"
                    style={{ color: "rgba(210,222,242,0.6)" }}
                  >
                    Password
                  </Label>
                  <div className="relative">
                    <Lock
                      className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
                      style={{ color: "rgba(148,197,255,0.7)" }}
                      aria-hidden="true"
                    />
                    <Input
                      id="manager-password"
                      type={showPassword ? "text" : "password"}
                      data-testid="input-manager-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      required
                      className="pl-9 pr-10 text-white placeholder:text-slate-500"
                      style={{
                        backgroundColor: "rgba(5,12,28,0.6)",
                        borderColor: "rgba(148,197,255,0.25)",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                      style={{ color: "rgba(148,197,255,0.7)" }}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      data-testid="button-toggle-password-visibility"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  data-testid="button-manager-login"
                  className="w-full rounded-md py-2.5 font-bold uppercase tracking-[0.18em] text-sm text-white transition-transform disabled:opacity-60 disabled:cursor-not-allowed hover:scale-[1.01]"
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${ORANGE}, #FF9A3D)`,
                    boxShadow: "0 0 24px rgba(224,109,0,0.55), 0 8px 24px rgba(224,109,0,0.25)",
                  }}
                >
                  {isSubmitting ? "Authorizing..." : "Enter Command Center"}
                </button>
                <div className="flex items-center justify-center gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => navigate(ROUTES.managerForgotPassword)}
                    className="font-medium hover:underline"
                    style={{ color: ORANGE }}
                    data-testid="link-forgot-password"
                  >
                    Forgot password?
                  </button>
                  <span className="h-3 w-px" style={{ backgroundColor: "rgba(224,109,0,0.4)" }} />
                  <button
                    type="button"
                    onClick={() => navigate(ROUTES.managerForgotUsername)}
                    className="font-medium hover:underline"
                    style={{ color: ORANGE }}
                    data-testid="link-forgot-username"
                  >
                    Forgot username?
                  </button>
                </div>
              </form>

              {wrongType && (
                <div
                  className="mt-4 rounded-md border p-3 text-sm"
                  style={{ borderColor: ORANGE, backgroundColor: "rgba(224,109,0,0.1)" }}
                  data-testid="text-wrong-credential-type"
                >
                  <p style={{ color: "#F3F6FC" }}>{wrongType.message}</p>
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
            </div>

            <p className="text-center text-xs" style={{ color: "rgba(210,222,242,0.55)" }}>
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
      </div>

      {/* Bottom strip: four words separated by dividers. */}
      <div
        className="relative border-t px-4 py-3"
        style={{ borderColor: "rgba(148,197,255,0.12)", backgroundColor: "rgba(4,8,18,0.6)" }}
      >
        <div
          className="flex items-center justify-center gap-3 sm:gap-6 text-[10px] sm:text-xs font-bold uppercase tracking-[0.25em] flex-wrap"
          style={{ color: ORANGE }}
          data-testid="text-bottom-strip"
        >
          <span>Train</span>
          <span className="h-3 w-px" style={{ backgroundColor: "rgba(224,109,0,0.4)" }} />
          <span>Practice</span>
          <span className="h-3 w-px" style={{ backgroundColor: "rgba(224,109,0,0.4)" }} />
          <span>Improve</span>
          <span className="h-3 w-px" style={{ backgroundColor: "rgba(224,109,0,0.4)" }} />
          <span>Achieve</span>
        </div>
      </div>
    </div>
  );
}
