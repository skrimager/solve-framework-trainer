import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { wrongCredentialTypeRedirect, ROUTES } from "@/lib/routes";
import styles from "./manager-login.module.css";

// Manager command-center login. Cinematic command-room overhaul v2.
//
// This is a full visual rebuild of the background/decorative layer and the
// login card chrome to match a cinematic reference image and a 23-point
// written brief from the product owner (military/aerospace operations
// center feel, taller vertical composition, richer ceiling ring, more
// detailed world map and analytics panels, more realistic chair silhouettes,
// a monitor console row, and a calmer navy-forward color balance with orange
// as a controlled accent). All of this is achieved with layered CSS only
// (gradients, box-shadows, pseudo-elements, clip-path, filters) - no new
// markup-driven behavior and no new dependencies.
//
// Real functionality is unchanged from the previous version: same backend
// flow as the consultant login (single POST /api/login; role is
// backend-derived). Signing in swaps this route to the manager dashboard
// (see CommandCenter in App.tsx), so this component never navigates on its
// own success - it just updates auth state and CommandCenter re-renders into
// the dashboard.

function WorldMap() {
  return (
    <div className={styles.worldMap} aria-hidden="true">
      <div className={styles.mapNetwork}>
        <svg viewBox="0 0 600 260" width="100%" height="100%" aria-hidden="true">
          <g stroke="#1c8fdc" strokeWidth="0.7" opacity="0.55">
            <path d="M40 40 L140 70" />
            <path d="M140 70 L230 30" />
            <path d="M140 70 L210 130" />
            <path d="M230 30 L320 60" />
            <path d="M320 60 L400 25" />
            <path d="M320 60 L380 120" />
            <path d="M400 25 L470 55" />
            <path d="M210 130 L300 150" />
            <path d="M300 150 L380 120" />
            <path d="M380 120 L470 150" />
            <path d="M470 55 L540 90" />
            <path d="M470 150 L540 90" />
          </g>
          <g fill="#2fb6ff">
            <circle cx="40" cy="40" r="2.2" />
            <circle cx="140" cy="70" r="2.6" />
            <circle cx="230" cy="30" r="2.2" />
            <circle cx="320" cy="60" r="2.6" />
            <circle cx="400" cy="25" r="2.2" />
            <circle cx="470" cy="55" r="2.4" />
            <circle cx="210" cy="130" r="2.2" />
            <circle cx="300" cy="150" r="2.4" />
            <circle cx="380" cy="120" r="2.6" />
            <circle cx="470" cy="150" r="2.2" />
            <circle cx="540" cy="90" r="2.4" />
          </g>
        </svg>
      </div>
      <div className={styles.mapSilhouette} />
      <div className={styles.mapDotMatrix} />
      <span className={`${styles.mapDot} ${styles.mapDotOrange}`} style={{ left: "36%", top: "68%" }} />
      <span className={`${styles.mapDot} ${styles.mapDotOrange}`} style={{ left: "70%", top: "60%" }} />
      <span className={styles.mapDot} style={{ left: "22%", top: "58%" }} />
      <span className={styles.mapDot} style={{ left: "48%", top: "72%" }} />
      <span className={styles.mapDot} style={{ left: "58%", top: "55%" }} />
      <div className={styles.mapGrid} />
    </div>
  );
}

function LineChartCard() {
  return (
    <div className={`${styles.hudCard} ${styles.hudCardLarge}`}>
      <div className={styles.hudCardLabel}>PERFORMANCE TREND</div>
      <div className={styles.chartGrid} />
      <div className={styles.chartLine} />
    </div>
  );
}

function BarChart({ heights }: { heights: number[] }) {
  return (
    <div className={styles.barChart}>
      {heights.map((h, i) => (
        <span key={i} style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

function AnalyticsPanel() {
  return (
    <div className={styles.analyticsPanel}>
      <LineChartCard />
      <div className={styles.hudCard}>
        <div className={styles.hudCardLabel}>ACTIVITY</div>
        <BarChart heights={[23, 45, 36, 67, 54, 83, 72]} />
      </div>
      <div className={`${styles.hudCard} ${styles.hudCardRing}`}>
        <div className={styles.successRing}>
          <div className={styles.successRingContent}>
            <small>SUCCESS</small>
            <strong>92%</strong>
          </div>
        </div>
      </div>
      <div className={`${styles.hudCard} ${styles.hudCardLarge}`}>
        <div className={styles.hudCardLabel}>THROUGHPUT</div>
        <BarChart heights={[25, 34, 49, 43, 66, 80, 93, 76, 88, 61, 70, 84]} />
      </div>
    </div>
  );
}

function ConsoleRoom() {
  return (
    <div className={styles.consoleRoom}>
      <div className={styles.consoleFloor} />
      <div className={styles.consoleLine} />
      <div className={styles.deskRow} aria-hidden="true">
        <span className={styles.desk} />
        <span className={styles.desk} />
        <span className={styles.desk} />
      </div>
      <div className={`${styles.chair} ${styles.chairOne}`}>
        <span className={styles.chairBack} />
        <span className={styles.chairArmLeft} />
        <span className={styles.chairArmRight} />
        <span className={styles.chairSeat} />
        <span className={styles.chairBase} />
      </div>
      <div className={`${styles.chair} ${styles.chairTwo}`}>
        <span className={styles.chairBack} />
        <span className={styles.chairArmLeft} />
        <span className={styles.chairArmRight} />
        <span className={styles.chairSeat} />
        <span className={styles.chairBase} />
      </div>
      <div className={`${styles.chair} ${styles.chairThree}`}>
        <span className={styles.chairBack} />
        <span className={styles.chairArmLeft} />
        <span className={styles.chairArmRight} />
        <span className={styles.chairSeat} />
        <span className={styles.chairBase} />
      </div>
      <div className={`${styles.chair} ${styles.chairFour}`}>
        <span className={styles.chairBack} />
        <span className={styles.chairArmLeft} />
        <span className={styles.chairArmRight} />
        <span className={styles.chairSeat} />
        <span className={styles.chairBase} />
      </div>
      <div className={`${styles.chair} ${styles.chairFive}`}>
        <span className={styles.chairBack} />
        <span className={styles.chairArmLeft} />
        <span className={styles.chairArmRight} />
        <span className={styles.chairSeat} />
        <span className={styles.chairBase} />
      </div>
    </div>
  );
}

// CSS-only logo mark: an orange/blue gradient bordered square with an orange
// dot in the middle and a speech-bubble tail drawn as a CSS border-triangle.
// No image asset, matching the reference (it has no <img>).
function LogoMark() {
  return (
    <div className={styles.logoIcon} aria-hidden="true">
      <span className={styles.logoDot} />
    </div>
  );
}

export default function ManagerLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [wrongType, setWrongType] = useState<{ redirectTo: string; message: string } | null>(null);
  const { setUser } = useAuth();
  const [, navigate] = useLocation();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setStatusMessage("");
    setWrongType(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatusMessage(result.message || "Incorrect username or password.");
        return;
      }
      // Credentials are valid; if they belong to a consultant account, don't
      // sign them in here. Point them at Practice to sign in there (no
      // cross-form auto-submit of credentials).
      const mismatch = wrongCredentialTypeRedirect("manager", result.role);
      if (mismatch) {
        setWrongType(mismatch);
        return;
      }
      setUser(result);
    } catch (err) {
      setStatusMessage("Incorrect username or password.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.backgroundRoom} aria-hidden="true">
        <div className={styles.ceilingRing}>
          <span className={styles.ceilingRingOuter} />
          <span className={styles.ceilingRingArcs} />
          <span className={styles.ceilingRingInner} />
        </div>
        <WorldMap />
        <AnalyticsPanel />
        <ConsoleRoom />
      </div>
      <div className={styles.pageContent}>
        <header className={styles.brand}>
          <div className={styles.brandLockup}>
            <LogoMark />
            <div className={styles.brandName}>
              <div className={styles.solve}>
                SOLVE<span className={styles.period}>.</span>
              </div>
              <span className={styles.framework}>FRAMEWORK</span>
            </div>
          </div>
          <h1 className={styles.headline} data-testid="text-manager-title">
            COMMAND CENTER
          </h1>
          <div className={styles.loginHeading} data-testid="text-manager-subtitle">
            MANAGER LOGIN
          </div>
          <p className={styles.tagline} data-testid="text-manager-tagline">
            Practice. Performance. Period.
          </p>
        </header>

        <section className={styles.loginCard} aria-labelledby="manager-access-heading">
          <div className={styles.cardCorners} />
          <div className={styles.cardTitleRow}>
            <span className={styles.lockSymbol} aria-hidden="true" />
            <div>
              <h2 id="manager-access-heading">MANAGER ACCESS</h2>
              <p>Sign in to your Command Center</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className={styles.formGroup}>
              <label htmlFor="manager-username">User Name</label>
              <div className={styles.inputWrapper}>
                <span className={styles.fieldIcon} aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="7" r="4"></circle>
                    <path d="M4 21v-2.5A6.5 6.5 0 0 1 10.5 12h3A6.5 6.5 0 0 1 20 18.5V21"></path>
                  </svg>
                </span>
                <input
                  id="manager-username"
                  name="username"
                  type="text"
                  placeholder="Username"
                  autoComplete="username"
                  required
                  data-testid="input-manager-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="manager-password">Password</label>
              <div className={styles.inputWrapper}>
                <span className={styles.fieldIcon} aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <rect x="5" y="10" width="14" height="11" rx="2"></rect>
                    <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
                    <path d="M12 14v3"></path>
                  </svg>
                </span>
                <input
                  id="manager-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Password"
                  autoComplete="current-password"
                  required
                  data-testid="input-manager-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  className={styles.passwordToggle}
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  data-testid="button-toggle-password-visibility"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? (
                    <svg viewBox="0 0 24 24">
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
                      <circle cx="12" cy="12" r="2.5"></circle>
                      <path d="M4 4l16 16"></path>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24">
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
                      <circle cx="12" cy="12" r="2.5"></circle>
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button
              className={styles.submitButton}
              type="submit"
              disabled={isSubmitting}
              data-testid="button-manager-login"
            >
              {isSubmitting ? "Authorizing..." : "Enter Command Center"}
            </button>

            <div className={styles.formLinks}>
              <button
                type="button"
                onClick={() => navigate(ROUTES.managerForgotPassword)}
                data-testid="link-forgot-password"
              >
                Forgot password?
              </button>
              <span className={styles.formDivider} aria-hidden="true" />
              <button
                type="button"
                onClick={() => navigate(ROUTES.managerForgotUsername)}
                data-testid="link-forgot-username"
              >
                Forgot username?
              </button>
            </div>

            <p
              className={`${styles.statusMessage} ${statusMessage ? styles.statusMessageVisible : ""}`}
              role="status"
              aria-live="polite"
              data-testid="text-status-message"
            >
              {statusMessage}
            </p>

            {wrongType && (
              <p
                className={`${styles.statusMessage} ${styles.statusMessageVisible} ${styles.wrongTypeMessage}`}
                role="status"
                aria-live="polite"
                data-testid="text-wrong-credential-type"
              >
                <span>{wrongType.message}</span>
                <button
                  type="button"
                  className={styles.wrongTypeLink}
                  onClick={() => navigate(wrongType.redirectTo)}
                  data-testid="button-go-practice"
                >
                  Go to Practice
                </button>
              </p>
            )}
          </form>
        </section>

        <p className={styles.consultantLink}>
          <button type="button" onClick={() => navigate("/practice")} data-testid="link-consultant-login">
            Looking for the consultant practice login?
          </button>
        </p>

        <nav className={styles.bottomNavigation} aria-label="SOLVE process">
          <ul>
            <li>Train</li>
            <li className={styles.separator} aria-hidden="true" />
            <li>Practice</li>
            <li className={styles.separator} aria-hidden="true" />
            <li>Improve</li>
            <li className={styles.separator} aria-hidden="true" />
            <li>Achieve</li>
          </ul>
        </nav>
      </div>
    </main>
  );
}
