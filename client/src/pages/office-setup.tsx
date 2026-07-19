import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";
import { hashToSearch } from "@/lib/hashLocation";
import { useToast } from "@/hooks/use-toast";
import { Check, Copy } from "lucide-react";
import {
  PLAN_TIERS,
  ENTERPRISE_MIN_SEATS,
  ENTERPRISE_CONTACT_EMAIL,
  isEnterpriseSeatCount,
  planForSeatCount,
} from "@shared/pricing";

const NAVY = "#0A1A30";
const ORANGE = "#E06D00";

// Live tier + price summary for the chosen consultant count. Enterprise (36+) has
// no self-serve price, so callers render a "contact us" path instead of a total.
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

export default function OfficeSetup() {
  const params = useParams();
  const token = params.token ?? "";
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [email, setEmail] = useState<string>("");

  const [officeName, setOfficeName] = useState("");
  const [seatCount, setSeatCount] = useState(1);
  const [includeDashboard, setIncludeDashboard] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/office-setup/${token}`);
        const data = await res.json();
        if (cancelled) return;
        setEmail(data.email ?? "");
      } catch (err: any) {
        if (cancelled) return;
        setTokenError(humanError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const enterprise = isEnterpriseSeatCount(seatCount);
  const summary = useMemo(() => priceSummary(seatCount, includeDashboard), [seatCount, includeDashboard]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (enterprise) return;
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/office-setup/checkout", {
        token,
        officeName,
        seatCount,
        includeDashboard,
        email: email || undefined,
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
    <div className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md mx-auto space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: NAVY }} data-testid="text-office-setup-title">
            Set up your office
          </h1>
          <p className="text-sm text-muted-foreground">
            Get your whole team practicing discovery conversations.
          </p>
        </div>

        {loading && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">Loading...</CardContent>
          </Card>
        )}

        {!loading && tokenError && (
          <Card className="border-2" style={{ borderColor: ORANGE }}>
            <CardHeader>
              <CardTitle className="text-lg">This link isn't available</CardTitle>
              <CardDescription>{tokenError}</CardDescription>
            </CardHeader>
            <CardContent>
              <a
                href={`mailto:${ENTERPRISE_CONTACT_EMAIL}`}
                className="text-sm font-medium hover:underline"
                style={{ color: ORANGE }}
                data-testid="link-contact-support"
              >
                Contact us for a new link
              </a>
            </CardContent>
          </Card>
        )}

        {!loading && !tokenError && (
          <Card className="border-2" style={{ borderColor: ORANGE }}>
            <CardContent className="pt-6">
              <form onSubmit={handleSubmit} className="space-y-6">
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
                  <Label htmlFor="seatCount">Number of consultants</Label>
                  <Input
                    id="seatCount"
                    type="number"
                    min={1}
                    value={seatCount}
                    onChange={(e) => setSeatCount(Math.max(1, Number(e.target.value) || 1))}
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
                        <span>Manager Dashboard</span>
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
        )}
      </div>
    </div>
  );
}

// Confirmation page shown after Stripe redirects back on a completed checkout.
// Polls the completion endpoint until the provisioning webhook has created the
// office, then shows the invite code + first-week plan (mirrors the access email).
export function OfficeSetupComplete() {
  const [, navigate] = useLocation();
  const sessionId = useMemo(
    () => new URLSearchParams(hashToSearch(window.location.hash)).get("session_id") ?? "",
    [],
  );

  const [data, setData] = useState<{
    officeName: string;
    inviteCode: string;
    seatCount: number;
    dashboard: boolean;
    commandCenterUrl: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setError("Missing checkout session.");
      return;
    }
    let cancelled = false;
    let attempts = 0;
    async function poll() {
      attempts += 1;
      try {
        const res = await apiRequest("GET", `/api/office-setup/complete/${sessionId}`);
        if (res.status === 202) {
          if (attempts < 15 && !cancelled) setTimeout(poll, 2000);
          else if (!cancelled) setError("Your office is being set up. Check your email shortly for your invite code.");
          return;
        }
        const body = await res.json();
        if (!cancelled) setData(body);
      } catch (err: any) {
        if (attempts < 15 && !cancelled) setTimeout(poll, 2000);
        else if (!cancelled) setError(humanError(err));
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  function copyCode() {
    if (!data) return;
    navigator.clipboard?.writeText(data.inviteCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md mx-auto space-y-6">
        {!data && !error && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground" data-testid="text-provisioning">
              Setting up your office...
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="border-2" style={{ borderColor: ORANGE }}>
            <CardHeader>
              <CardTitle className="text-lg">Almost there</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
          </Card>
        )}

        {data && (
          <Card className="border-2" style={{ borderColor: ORANGE }}>
            <CardHeader>
              <CardTitle className="text-lg" style={{ color: NAVY }} data-testid="text-complete-title">
                Your office is active
              </CardTitle>
              <CardDescription data-testid="text-complete-subtitle">
                {data.officeName} is live now. Here is your code for {data.seatCount} consultant
                {data.seatCount === 1 ? "" : "s"}.
                {data.dashboard
                  ? " Your Manager Dashboard is ready and fills in as your team joins."
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border-2 border-dashed p-4 text-center" style={{ borderColor: ORANGE }}>
                <p className="text-xs text-muted-foreground mb-1">Invite code</p>
                <p className="text-3xl font-bold tracking-widest" data-testid="text-invite-code">
                  {data.inviteCode}
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={copyCode} data-testid="button-copy-code">
                  {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
                  {copied ? "Copied" : "Copy code"}
                </Button>
              </div>

              <div className="text-sm space-y-2">
                <p className="font-medium" style={{ color: NAVY }}>
                  Your first week
                </p>
                <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                  <li>Day 1: Log in and invite your consultants with the code above.</li>
                  <li>Day 2: Have each consultant run their first practice discovery conversation.</li>
                  <li>Day 3: Review scores together and pick one skill to focus on.</li>
                  <li>Day 5: Run a second round and compare progress.</li>
                </ul>
              </div>

              <Button
                type="button"
                className="w-full"
                style={{ backgroundColor: ORANGE, color: "white" }}
                onClick={() => navigate("/command-center")}
                data-testid="button-go-command-center"
              >
                Go to your Command Center
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
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
