import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { wrongCredentialTypeRedirect, ROUTES } from "@/lib/routes";
import styles from "./manager-login.module.css";

// Manager command-center login. Cinematic command-room overhaul v2.
//
// The background is a generated photographic image of an empty command
// room (ceiling ring, world map wall, analytics monitor wall, console
// desks and chairs) set as the page background in manager-login.module.css.
// The header text, logo mark, and login card below render as live DOM
// elements on top of that image for accessibility, real functionality, and
// responsiveness - none of the visible text or the login form is baked
// into the image itself.
//
// Real functionality is unchanged from the previous version: same backend
// flow as the consultant login (single POST /api/login; role is
// backend-derived). Signing in swaps this route to the manager dashboard
// (see CommandCenter in App.tsx), so this component never navigates on its
// own success - it just updates auth state and CommandCenter re-renders into
// the dashboard.

// CSS-only logo mark: an orange/blue gradient bordered square with an orange
// dot in the middle and a speech-bubble tail drawn as a CSS border-triangle.
// No image asset, matching the reference (it has no img tag).
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
