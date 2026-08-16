import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Building2,
  KeyRound,
  LockKeyhole,
  Mail,
  Rocket,
  UserRound,
  UsersRound,
} from "lucide-react";
import scenarioWindowSunset from "@/assets/free-scenario-window-sunset.webp";
import {
  ENTERPRISE_MIN_SEATS,
  ENTERPRISE_CONTACT_EMAIL,
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
const GLASS_INPUT = "border-white/15 bg-[#061326]/55 text-white placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-[#E06D00] focus-visible:ring-offset-0";

type Step = "capture" | "verify" | "setup";

function priceSummary(seatCount: number, includeDashboard: boolean) {
  const plan = planForSeatCount(seatCount);
  if (!plan) return null;
  const seats = seatCount * plan.seatRate;
  const dashboard = includeDashboard ? plan.dashboardRate : 0;
  return { plan, seats, dashboard, total: seats + dashboard };
}

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

const STEP_CONTENT = {
  capture: {
    number: 1,
    Icon: Building2,
    title: "Let's get your team started.",
    description: "Set up your SOLVE account and tell us a little about your team.",
  },
  verify: {
    number: 2,
    Icon: UsersRound,
    title: "Verify it's you.",
    description: "Enter the code we just emailed you.",
  },
  setup: {
    number: 3,
    Icon: Rocket,
    title: "Set up your office.",
    description: "Payment activates your office instantly. No waiting.",
  },
} as const;

export default function Signup() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("capture");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");

  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#050C1C] px-4 pb-7 pt-16 text-white sm:px-6 sm:pt-9 lg:px-10 lg:py-9">
      <div className="mx-auto max-w-7xl">
        <header className="flex justify-center pb-7 sm:pb-9">
          <img
            src="/solve-wordmark-bigtag-transparent.png"
            alt="SOLVE Framework - Practice. Performance. Period."
            className="h-[58px] w-auto max-w-full object-contain sm:h-[72px]"
            data-testid="img-solve-logo"
          />
        </header>

        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-12">
          <section className="mx-auto w-full max-w-md pt-1 lg:mx-0 lg:pt-12" aria-labelledby="text-signup-title">
            <p className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: ORANGE }}>
              Welcome to SOLVE
            </p>
            <h1 id="text-signup-title" className="mt-4 max-w-sm text-[clamp(2rem,4vw,3.25rem)] font-bold leading-[1.1] tracking-[-0.04em]" data-testid="text-signup-title">
              Let&apos;s build a stronger team.
              <span className="mt-1 block" style={{ color: ORANGE }}>Together.</span>
            </h1>
            <div className="mt-5 h-0.5 w-10" style={{ backgroundColor: ORANGE }} />
            <p className="mt-5 max-w-[31rem] text-base leading-6 text-slate-300">
              You&apos;re only a few steps away from giving your team a consistent way to practice, improve, and measure the conversations that drive performance.
            </p>

            <div className="mt-7 space-y-5">
              <Benefit icon={Building2} title="Set up your company." description="Tell us about your business and goals." />
              <Benefit icon={UsersRound} title="Add your team." description="Invite your team and get everyone on board." />
              <Benefit icon={BarChart3} title="Start seeing what others can&apos;t." description="Unlock insights and drive better conversations." />
            </div>
          </section>

          <section className="relative isolate mx-auto w-full max-w-2xl overflow-hidden rounded-3xl border border-white/10 bg-[#0A1A30] p-3 shadow-[0_24px_60px_rgba(0,0,0,0.36)] sm:p-5 lg:mx-0 lg:mt-0 lg:min-h-[588px] lg:p-7" aria-label="Account setup form">
            <div
              className="absolute inset-0 -z-20 bg-cover bg-center"
              style={{ backgroundImage: `url(${scenarioWindowSunset})`, backgroundPosition: "center right" }}
              aria-hidden="true"
            />
            <div className="absolute inset-0 -z-10 bg-[#061326]/45" aria-hidden="true" />
            <div className="relative mx-auto max-w-xl rounded-2xl border border-white/15 bg-[#071728]/80 p-5 shadow-2xl backdrop-blur-md sm:p-7">
              <StepCard step={step}>
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
              </StepCard>
            </div>
          </section>
        </div>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-1.5 text-sm font-semibold transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E06D00] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050C1C]"
            style={{ color: ORANGE }}
            data-testid="link-back-home"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
        </div>

        <Journey />
      </div>
    </main>
  );
}

function Benefit({ icon: Icon, title, description }: { icon: typeof Building2; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: ORANGE, color: ORANGE }}>
        <Icon className="h-5 w-5" strokeWidth={1.7} />
      </span>
      <div>
        <h2 className="text-sm font-bold leading-5 text-white">{title}</h2>
        <p className="mt-0.5 text-sm leading-5 text-slate-300">{description}</p>
      </div>
    </div>
  );
}

function StepCard({ step, children }: { step: Step; children: React.ReactNode }) {
  const { number, Icon, title, description } = STEP_CONTENT[step];
  return (
    <>
      <div className="text-center">
        <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border" style={{ borderColor: ORANGE, color: ORANGE }}>
          <Icon className="h-6 w-6" strokeWidth={1.65} />
        </span>
        <p className="mt-3 text-xs font-bold uppercase tracking-[0.1em]" style={{ color: ORANGE }}>
          Step {number} of 3
        </p>
        <h2 className="mt-2 text-[clamp(1.35rem,2.5vw,1.8rem)] font-bold leading-tight tracking-[-0.025em] text-white">{title}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-slate-300">{description}</p>
      </div>
      <div className="mt-6">{children}</div>
    </>
  );
}

function Field({ label, htmlFor, icon: Icon, children }: { label: string; htmlFor: string; icon: typeof Mail; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="text-sm font-semibold text-slate-100">{label}</Label>
      <div className="relative">
        <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" strokeWidth={1.7} />
        {children}
      </div>
    </div>
  );
}

function TrustLine() {
  return (
    <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs leading-5 text-slate-300">
      <LockKeyhole className="h-3.5 w-3.5 shrink-0" />
      Secure. Private. Your information is safe with us.
    </p>
  );
}

function PrimaryButton({ children, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      className="h-11 w-full rounded-md text-sm font-bold shadow-[0_6px_16px_rgba(224,109,0,0.22)] transition hover:brightness-110 disabled:opacity-60"
      style={{ backgroundColor: ORANGE, color: "white" }}
    >
      <span>{children}</span>
      <ArrowRight className="ml-2 h-4 w-4" />
    </Button>
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Work email" htmlFor="email" icon={Mail}>
        <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required placeholder="name@company.com" className={`h-11 pl-10 ${GLASS_INPUT}`} data-testid="input-signup-email" />
      </Field>
      <Field label="Company name" htmlFor="company" icon={Building2}>
        <Input id="company" value={company} onChange={(e) => setCompany(e.target.value)} required placeholder="Enter your company name" className={`h-11 pl-10 ${GLASS_INPUT}`} data-testid="input-signup-company" />
      </Field>
      <div className="pt-1">
        <PrimaryButton type="submit" disabled={submitting} data-testid="button-send-code">
          {submitting ? "Sending..." : "Send verification code"}
        </PrimaryButton>
        <TrustLine />
      </div>
    </form>
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="Verification code" htmlFor="code" icon={KeyRound}>
        <Input id="code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} required placeholder="Enter your 6-digit code" className={`h-11 pl-10 tracking-[0.16em] ${GLASS_INPUT}`} data-testid="input-verify-code" />
      </Field>
      <div className="pt-1">
        <PrimaryButton type="submit" disabled={submitting} data-testid="button-verify-code">
          {submitting ? "Verifying..." : "Verify and continue"}
        </PrimaryButton>
        <TrustLine />
      </div>
      <div className="flex items-center justify-between gap-4 text-sm">
        <button type="button" onClick={onBack} className="text-slate-300 transition hover:text-white hover:underline" data-testid="button-verify-back">
          Use a different email
        </button>
        <button type="button" onClick={resend} disabled={resending} className="font-semibold transition hover:brightness-125 disabled:opacity-60" style={{ color: ORANGE }} data-testid="button-resend-code">
          {resending ? "Resending..." : "Resend code"}
        </button>
      </div>
    </form>
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
  const [submitting, setSubmitting] = useState(false);

  const enterprise = isEnterpriseSeatCount(seatCount);
  const summary = useMemo(() => priceSummary(seatCount, includeDashboard), [seatCount, includeDashboard]);

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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Office name" htmlFor="officeName" icon={Building2}>
          <Input id="officeName" value={officeName} onChange={(e) => setOfficeName(e.target.value)} required className={`h-10 pl-10 ${GLASS_INPUT}`} data-testid="input-office-name" />
        </Field>
        <Field label="Your name" htmlFor="managerName" icon={UserRound}>
          <Input id="managerName" value={managerName} onChange={(e) => setManagerName(e.target.value)} required placeholder="Enter your full name" className={`h-10 pl-10 ${GLASS_INPUT}`} data-testid="input-manager-name" />
        </Field>
        <Field label="Choose a username" htmlFor="username" icon={UserRound}>
          <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required className={`h-10 pl-10 ${GLASS_INPUT}`} data-testid="input-username" />
        </Field>
        <Field label="Choose a password" htmlFor="password" icon={LockKeyhole}>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required className={`h-10 pl-10 ${GLASS_INPUT}`} data-testid="input-password" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="seatCount" className="text-sm font-semibold text-slate-100">Number of consultants</Label>
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
            className={`h-10 ${GLASS_INPUT}`}
            data-testid="input-seat-count"
          />
          {!enterprise && summary && (
            <p className="text-xs leading-4 text-slate-300" data-testid="text-tier-line">
              {tierLabel(summary.plan.tier)} tier: ${summary.plan.seatRate}/consultant per month
            </p>
          )}
          {enterprise && (
            <p className="text-xs font-medium leading-4 text-slate-100" data-testid="text-enterprise-line">
              {ENTERPRISE_MIN_SEATS}+ consultants is Enterprise. {" "}
              <a href={`mailto:${ENTERPRISE_CONTACT_EMAIL}?subject=Enterprise%20office%20setup`} className="underline" style={{ color: ORANGE }} data-testid="link-enterprise-contact">
                Contact us for Enterprise
              </a>
            </p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="dashboard" className="text-sm font-semibold text-slate-100">Manager Dashboard</Label>
            <button
              type="button"
              id="dashboard"
              role="switch"
              aria-checked={includeDashboard}
              onClick={() => setIncludeDashboard((v) => !v)}
              className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E06D00]"
              style={{ backgroundColor: includeDashboard ? ORANGE : "#334155" }}
              data-testid="toggle-dashboard"
            >
              <span className="inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform" style={{ transform: includeDashboard ? "translateX(22px)" : "translateX(2px)" }} />
            </button>
          </div>
          {!enterprise && summary && (
            <p className="text-xs leading-4 text-slate-300" data-testid="text-dashboard-line">
              See every consultant&apos;s progress, scores, and coaching in one place for ${summary.plan.dashboardRate}/month.
            </p>
          )}
        </div>
      </div>

      {!enterprise && summary && (
        <div className="space-y-1 rounded-lg border border-white/15 bg-[#061326]/45 p-3 text-sm text-slate-200" data-testid="price-summary">
          <div className="flex justify-between gap-4"><span>{seatCount} consultant{seatCount === 1 ? "" : "s"} x ${summary.plan.seatRate}</span><span>${summary.seats}/mo</span></div>
          {includeDashboard && <div className="flex justify-between gap-4"><span>Manager Dashboard</span><span>${summary.dashboard}/mo</span></div>}
          <div className="flex justify-between gap-4 border-t border-white/10 pt-1.5 font-bold text-white"><span>Total</span><span data-testid="text-total">${summary.total}/mo</span></div>
        </div>
      )}

      <div className="pt-1">
        <PrimaryButton type="submit" disabled={submitting || enterprise} data-testid="button-continue-to-payment">
          {submitting ? "Redirecting..." : "Continue to payment"}
        </PrimaryButton>
        <TrustLine />
      </div>
    </form>
  );
}

function Journey() {
  const steps = [
    { number: 1, icon: Building2, title: "Set Up Your Company", description: "Tell us about your business and your goals." },
    { number: 2, icon: UsersRound, title: "Build Your Team", description: "Add team members and create your account." },
    { number: 3, icon: Rocket, title: "Review & Activate", description: "Confirm your plan, complete setup, and get started." },
  ];

  return (
    <section className="mt-14 border-t border-white/10 pt-10 pb-5 sm:mt-16" aria-labelledby="journey-title">
      <h2 id="journey-title" className="text-center text-sm font-bold uppercase tracking-[0.1em] text-white">Your Journey with SOLVE</h2>
      <div className="relative mx-auto mt-8 grid max-w-5xl gap-9 md:grid-cols-3 md:gap-6">
        <div className="absolute left-[16.5%] right-[16.5%] top-4 hidden border-t border-dashed md:block" style={{ borderColor: ORANGE }} aria-hidden="true" />
        {steps.map(({ number, icon: Icon, title, description }) => (
          <div key={number} className="relative flex flex-col items-center text-center">
            <span className="z-10 inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold text-white" style={{ backgroundColor: ORANGE }}>{number}</span>
            <Icon className="mt-4 h-7 w-7" style={{ color: ORANGE }} strokeWidth={1.7} />
            <h3 className="mt-3 text-sm font-bold text-white">{title}</h3>
            <p className="mt-1 max-w-[15rem] text-sm leading-5 text-slate-300">{description}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 text-center font-serif text-lg italic" style={{ color: ORANGE }}>Better conversations. Stronger team. Bigger wins.</p>
    </section>
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
