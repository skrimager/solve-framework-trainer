import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";
import {
  ENTERPRISE_MIN_SEATS,
  ENTERPRISE_CONTACT_EMAIL,
  ANNUAL_DASHBOARD_DISCOUNT_PERCENT,
  annualDashboardMonthlyEquivalent,
  isEnterpriseSeatCount,
  planForSeatCount,
} from "@shared/pricing";

// Self-serve manager signup. One page, three steps, email first:
//   1. capture: email + company (every started signup becomes a real contact)
//   2. verify: 6-digit code emailed to that address
//   3. setup: office name, manager name, login, seats, dashboard, then pay
// Payment (the Stripe redirect) is the sole activation trigger; the office and
// the manager login are created by the payment webhook, never here.

const NAVY = "#0A1A30";
const ORANGE = "#E06D00";

type Step = "capture" | "verify" | "setup";

function priceSummary(seatCount: number, includeDashboard: boolean, annual: boolean) {
  const plan = planForSeatCount(seatCount);
  if (!plan) return null;
  const seats = seatCount * plan.seatRate;
  // Annual prepay discounts the dashboard only (never seats). The figure shown is
  // the monthly-equivalent rate; Stripe applies the discount as a coupon.
  const dashboard = includeDashboard
    ? annual
      ? annualDashboardMonthlyEquivalent(plan.dashboardRate)
      : plan.dashboardRate
    : 0;
  return { plan, seats, dashboard, total: seats + dashboard };
}

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export default function Signup() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("capture");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md mx-auto space-y-6">
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center rounded-[10px]" style={{ backgroundColor: "#050C1C", padding: "8px 16px" }}>
            <img
              src="/solve-wordmark-bigtag-transparent.png"
              alt="SOLVE Framework - Practice. Performance. Period."
              className="h-[72px] w-auto max-w-full block"
              data-testid="img-solve-logo"
            />
          </div>
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: NAVY }} data-testid="text-signup-title">
            Set up your office
          </h1>
          <p className="text-sm text-muted-foreground">
            Get your whole team practicing discovery conversations.
          </p>
        </div>

        {step === "capture" && (
          <CaptureStep
            email={email}
            company={company}
            setEmail={setEmail}
            setCompany={setCompany}
            onSent={() => setStep("verify")}
            toast={toast}
          />
        )}
        {step === "verify" && (
          <VerifyStep
            email={email}
            onVerified={() => setStep("setup")}
            onBack={() => setStep("capture")}
            toast={toast}
          />
        )}
        {step === "setup" && <SetupStep email={email} company={company} toast={toast} />}

        <div className="text-center">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
            style={{ color: ORANGE }}
            data-testid="link-back-home"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        </div>
      </div>
    </div>
  );
}

type Toast = ReturnType<typeof useToast>["toast"];

function CaptureStep({
  email,
  company,
  setEmail,
  setCompany,
  onSent,
  toast,
}: {
  email: string;
  company: string;
  setEmail: (v: string) => void;
  setCompany: (v: string) => void;
  onSent: () => void;
  toast: Toast;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/signup/start", { email: email.trim(), company: company.trim() });
      toast({ title: "Check your email", description: "We sent a 6-digit verification code." });
      onSent();
    } catch (err: any) {
      toast({ title: "Couldn't send your code", description: humanError(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="border-2" style={{ borderColor: ORANGE }}>
      <CardHeader>
        <CardTitle className="text-lg">Start with your email</CardTitle>
        <CardDescription>We'll send a code to confirm it's you. Two quick fields to begin.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              data-testid="input-signup-email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="company">Company name</Label>
            <Input
              id="company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              required
              data-testid="input-signup-company"
            />
          </div>
          <Button
            type="submit"
            className="w-full"
            style={{ backgroundColor: ORANGE, color: "white" }}
            disabled={submitting}
            data-testid="button-send-code"
          >
            {submitting ? "Sending..." : "Send verification code"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function VerifyStep({
  email,
  onVerified,
  onBack,
  toast,
}: {
  email: string;
  onVerified: () => void;
  onBack: () => void;
  toast: Toast;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiRequest("POST", "/api/signup/verify", { email: email.trim(), code: code.trim() });
      onVerified();
    } catch (err: any) {
      toast({ title: "That code didn't work", description: humanError(err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    setResending(true);
    try {
      await apiRequest("POST", "/api/signup/resend", { email: email.trim() });
      toast({ title: "Code resent", description: "Check your email for a new code." });
    } catch (err: any) {
      toast({ title: "Couldn't resend", description: humanError(err), variant: "destructive" });
    } finally {
      setResending(false);
    }
  }

  return (
    <Card className="border-2" style={{ borderColor: ORANGE }}>
      <CardHeader>
        <CardTitle className="text-lg">Verify your email</CardTitle>
        <CardDescription>Enter the 6-digit code we sent to {email}.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">Verification code</Label>
            <Input
              id="code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              required
              data-testid="input-verify-code"
            />
          </div>
          <Button
            type="submit"
            className="w-full"
            style={{ backgroundColor: ORANGE, color: "white" }}
            disabled={submitting}
            data-testid="button-verify-code"
          >
            {submitting ? "Verifying..." : "Verify and continue"}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={onBack}
              className="text-muted-foreground hover:underline"
              data-testid="button-verify-back"
            >
              Use a different email
            </button>
            <button
              type="button"
              onClick={resend}
              disabled={resending}
              className="font-medium hover:underline"
              style={{ color: ORANGE }}
              data-testid="button-resend-code"
            >
              {resending ? "Resending..." : "Resend code"}
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SetupStep({ email, company, toast }: { email: string; company: string; toast: Toast }) {
  const [officeName, setOfficeName] = useState(company);
  const [managerName, setManagerName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [seatCount, setSeatCount] = useState(1);
  // Raw text backing the seat count input. Kept separate from the numeric
  // seatCount so the field can sit empty while the user is retyping (e.g.
  // clearing "1" before typing "7") without snapping back to 1 on every
  // keystroke.
  const [seatCountText, setSeatCountText] = useState("1");
  const [includeDashboard, setIncludeDashboard] = useState(false);
  const [annual, setAnnual] = useState(false);
  const [annualAvailable, setAnnualAvailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/billing/config");
        const data = await res.json();
        if (!cancelled) setAnnualAvailable(!!data.annualDashboardAvailable);
      } catch {
        // Config is best-effort: if it fails, the annual option simply stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enterprise = isEnterpriseSeatCount(seatCount);
  // Annual only applies to the dashboard, so it is meaningful only when the
  // dashboard is included and the discount is actually available.
  const showAnnual = annualAvailable && includeDashboard;
  const annualApplied = showAnnual && annual;
  const summary = useMemo(
    () => priceSummary(seatCount, includeDashboard, annualApplied),
    [seatCount, includeDashboard, annualApplied],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (enterprise) return;
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/signup/checkout", {
        email: email.trim(),
        company: officeName.trim(),
        managerName: managerName.trim(),
        username: username.trim(),
        password,
        seatCount,
        includeDashboard,
        annual: annualApplied,
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error("No checkout URL returned");
      }
    } catch (err: any) {
      toast({ title: "Couldn't start checkout", description: humanError(err), variant: "destructive" });
      setSubmitting(false);
    }
  }

  return (
    <Card className="border-2" style={{ borderColor: ORANGE }}>
      <CardHeader>
        <CardTitle className="text-lg">Your office details</CardTitle>
        <CardDescription>Payment activates your office instantly. No waiting.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="officeName">Office name</Label>
            <Input
              id="officeName"
              value={officeName}
              onChange={(e) => setOfficeName(e.target.value)}
              required
              data-testid="input-office-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="managerName">Your name</Label>
            <Input
              id="managerName"
              value={managerName}
              onChange={(e) => setManagerName(e.target.value)}
              required
              data-testid="input-manager-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username">Choose a username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              data-testid="input-username"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Choose a password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              data-testid="input-password"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="seatCount">Number of consultants</Label>
            <Input
              id="seatCount"
              type="number"
              min={1}
              value={seatCountText}
              onChange={(e) => {
                const raw = e.target.value;
                setSeatCountText(raw);
                if (raw.trim() === "") return;
                const parsed = Number(raw);
                if (Number.isFinite(parsed)) {
                  setSeatCount(Math.max(1, parsed));
                }
              }}
              onBlur={() => {
                // If the user leaves the field empty or invalid, snap back to
                // a valid number both in the numeric state and what's shown.
                const parsed = Number(seatCountText);
                const next = seatCountText.trim() === "" || !Number.isFinite(parsed) ? 1 : Math.max(1, parsed);
                setSeatCount(next);
                setSeatCountText(String(next));
              }}
              required
              data-testid="input-seat-count"
            />
            {!enterprise && summary && (
              <p className="text-sm text-muted-foreground" data-testid="text-tier-line">
                {tierLabel(summary.plan.tier)} tier: ${summary.plan.seatRate}/consultant per month
              </p>
            )}
            {enterprise && (
              <p className="text-sm font-medium" style={{ color: NAVY }} data-testid="text-enterprise-line">
                {ENTERPRISE_MIN_SEATS}+ consultants is Enterprise.{" "}
                <a
                  href={`mailto:${ENTERPRISE_CONTACT_EMAIL}?subject=Enterprise%20office%20setup`}
                  className="underline"
                  style={{ color: ORANGE }}
                  data-testid="link-enterprise-contact"
                >
                  Contact us for Enterprise
                </a>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="dashboard">Manager Dashboard</Label>
              <button
                type="button"
                id="dashboard"
                role="switch"
                aria-checked={includeDashboard}
                onClick={() => setIncludeDashboard((v) => !v)}
                className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                style={{ backgroundColor: includeDashboard ? ORANGE : "#cbd5e1" }}
                data-testid="toggle-dashboard"
              >
                <span
                  className="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
                  style={{ transform: includeDashboard ? "translateX(22px)" : "translateX(2px)" }}
                />
              </button>
            </div>
            {!enterprise && summary && (
              <p className="text-sm text-muted-foreground" data-testid="text-dashboard-line">
                See every consultant's progress, scores, and coaching in one place for $
                {summary.plan.dashboardRate}/month.
              </p>
            )}
          </div>

          {!enterprise && showAnnual && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="annual">Pay the dashboard annually</Label>
                <button
                  type="button"
                  id="annual"
                  role="switch"
                  aria-checked={annual}
                  onClick={() => setAnnual((v) => !v)}
                  className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                  style={{ backgroundColor: annual ? ORANGE : "#cbd5e1" }}
                  data-testid="toggle-annual"
                >
                  <span
                    className="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
                    style={{ transform: annual ? "translateX(22px)" : "translateX(2px)" }}
                  />
                </button>
              </div>
              <p className="text-sm text-muted-foreground" data-testid="text-annual-line">
                Prepay 12 months of the Manager Dashboard for an extra {ANNUAL_DASHBOARD_DISCOUNT_PERCENT}% off. Consultant
                seats stay on the standard monthly rate.
              </p>
            </div>
          )}

          {!enterprise && summary && (
            <div className="rounded-md border p-4 space-y-1" style={{ borderColor: NAVY }} data-testid="price-summary">
              <div className="flex justify-between text-sm">
                <span>
                  {seatCount} consultant{seatCount === 1 ? "" : "s"} x ${summary.plan.seatRate}
                </span>
                <span>${summary.seats}/mo</span>
              </div>
              {includeDashboard && (
                <div className="flex justify-between text-sm">
                  <span>Manager Dashboard{annualApplied ? " (annual)" : ""}</span>
                  <span>${summary.dashboard}/mo</span>
                </div>
              )}
              <div className="flex justify-between font-bold pt-1" style={{ color: NAVY }}>
                <span>Total</span>
                <span data-testid="text-total">${summary.total}/mo</span>
              </div>
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            style={{ backgroundColor: ORANGE, color: "white" }}
            disabled={submitting || enterprise}
            data-testid="button-continue-to-payment"
          >
            {submitting ? "Redirecting..." : "Continue to payment"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function humanError(err: any): string {
  const msg = String(err?.message ?? "");
  const match = msg.match(/^\d+:\s*([\s\S]*)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.message) return parsed.message;
    } catch {
      if (match[1]) return match[1];
    }
  }
  return "Something went wrong. Please try again.";
}
