import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  messageCoachApi,
  type MessageCoachResult,
} from "@/lib/messageCoachApi";
import {
  FUNNEL_COPY,
  INDUSTRY_OPTIONS,
  INPUT_COPY,
  MESSAGE_COACH_HEADER,
  PAID_RETURN_COPY,
  PAYWALL_COPY,
  POSITIONING_COPY,
  RESULT_COPY,
  UNAVAILABLE_COPY,
} from "@/lib/messageCoachCopy";

// Public Message Coach page. No auth: an anonymous visitor gets one free score
// per email, then a $4.99 purchase per additional score. A signed-in member with
// an active seat is scored with no email capture and no limit, which the server
// decides (this page only forwards the user id it already has).
//
// Brand palette shared with the rest of the app. No new design system: the same
// Card / Button / Input / Label / Textarea primitives every other page uses.
const ORANGE = "#E06D00";

// Stripe Checkout leaves the app entirely, so what the visitor typed is parked
// here for the round trip and read back once. sessionStorage (not localStorage)
// keeps it to this tab and this visit, matching how the demo parks its token.
const PAID_ROUND_TRIP_KEY = "solve-message-coach-round-trip";

type ParkedDraft = { message: string; industry: string | null; name: string; email: string };

function parkDraftForCheckout(draft: ParkedDraft): void {
  try {
    window.sessionStorage.setItem(PAID_ROUND_TRIP_KEY, JSON.stringify(draft));
  } catch {
    // Storage blocked: the visitor pastes their message again on return.
  }
}

function takeParkedDraft(): ParkedDraft | null {
  try {
    const raw = window.sessionStorage.getItem(PAID_ROUND_TRIP_KEY);
    window.sessionStorage.removeItem(PAID_ROUND_TRIP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.message !== "string" || typeof parsed?.email !== "string") return null;
    return {
      message: parsed.message,
      industry: typeof parsed.industry === "string" ? parsed.industry : null,
      name: typeof parsed.name === "string" ? parsed.name : "",
      email: parsed.email,
    };
  } catch {
    return null;
  }
}

// The demo page uses the same helper shape; a hash route carries its query after
// the path, so the standard location.search is empty.
function hashToSearch(hash: string): string {
  const q = hash.indexOf("?");
  return q === -1 ? "" : hash.slice(q);
}

export default function MessageCoach() {
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const [message, setMessage] = useState("");
  const [industry, setIndustry] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<MessageCoachResult | null>(null);
  const [paywall, setPaywall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Set on the return trip from Stripe. Holds the Checkout Session id, which the
  // server resolves to the purchase; the client never handles a database id.
  const [paidSessionId, setPaidSessionId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const config = useQuery({
    queryKey: ["/api/message-coach/config"],
    queryFn: () => messageCoachApi.config(),
    retry: false,
  });

  // The return trip from Stripe Checkout. A successful payment restores what the
  // visitor typed and arms the paid re-submit; a cancelled checkout lands
  // normally and says nothing. Either way the query, including the Stripe
  // session id, is stripped from the address bar.
  useEffect(() => {
    const params = new URLSearchParams(hashToSearch(window.location.hash));
    const paid = params.get("paid");
    if (!paid) return;
    const parked = takeParkedDraft();
    if (paid === "success") {
      if (parked) {
        setMessage(parked.message);
        setIndustry(parked.industry);
        setName(parked.name);
        setEmail(parked.email);
      }
      setPaidSessionId(params.get("session_id"));
      setPaywall(false);
    }
    window.history.replaceState({}, "", "#/message-coach");
  }, []);

  const scoreMutation = useMutation({
    mutationFn: (args: { useCheckoutSession: boolean }) =>
      messageCoachApi.score({
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        message,
        industry,
        paidCheckoutSessionId: args.useCheckoutSession ? paidSessionId : null,
        userId: user?.id ?? null,
      }),
    onSuccess: (data) => {
      if ("kind" in data) {
        if (data.kind === "payment_required") {
          setPaywall(true);
          setError(null);
          return;
        }
        // The webhook has not landed yet. Keep the purchase armed so the visitor
        // can try again in a moment without paying twice.
        setConfirming(true);
        setError(null);
        return;
      }
      setResult(data);
      setPaywall(false);
      setConfirming(false);
      setError(null);
      setPaidSessionId(null);
    },
    onError: (e: Error) => setError(e.message || INPUT_COPY.errorMessage),
  });

  const checkoutMutation = useMutation({
    mutationFn: () => messageCoachApi.checkout({ email: email.trim(), name: name.trim() || undefined }),
    onSuccess: (url) => {
      parkDraftForCheckout({ message, industry, name, email });
      window.location.href = url;
    },
    onError: (e: Error) => setError(e.message || PAYWALL_COPY.errorMessage),
  });

  // Members are already identified, so the email gate does not apply to them.
  const isMember = Boolean(user?.id);
  const canSubmit =
    message.trim().length > 0 && (isMember || (email.trim().length > 0 && name.trim().length > 0));

  if (config.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading...
      </div>
    );
  }

  // config() returns null on a 404, which is what the server sends for every
  // Message Coach route while MESSAGE_COACH_ENABLED is not "true".
  if (!config.data) {
    return (
      <div className="min-h-dvh bg-background px-4 py-16">
        <div className="mx-auto max-w-md space-y-3 text-center">
          <h1 className="text-xl font-semibold" data-testid="text-message-coach-unavailable">
            {UNAVAILABLE_COPY.headline}
          </h1>
          <p className="text-sm text-muted-foreground">{UNAVAILABLE_COPY.body}</p>
          <Button variant="outline" onClick={() => navigate("/")} data-testid="button-message-coach-home">
            <ArrowLeft className="mr-2 h-4 w-4" /> Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-10">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-message-coach-title">
            {MESSAGE_COACH_HEADER.title}
          </h1>
          <p className="text-sm text-muted-foreground">{MESSAGE_COACH_HEADER.subtitle}</p>
        </header>

        <Card style={{ borderColor: ORANGE }}>
          <CardContent className="pt-6">
            <p className="text-sm leading-relaxed" data-testid="text-message-coach-positioning">
              {POSITIONING_COPY}
            </p>
          </CardContent>
        </Card>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !scoreMutation.isPending) {
              scoreMutation.mutate({ useCheckoutSession: Boolean(paidSessionId) });
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="message-coach-message">{INPUT_COPY.messageLabel}</Label>
            <Textarea
              id="message-coach-message"
              rows={7}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={INPUT_COPY.messagePlaceholder}
              data-testid="input-message-coach-message"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="message-coach-industry">{INPUT_COPY.industryLabel}</Label>
            <select
              id="message-coach-industry"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={industry ?? ""}
              onChange={(e) => setIndustry(e.target.value || null)}
              data-testid="select-message-coach-industry"
            >
              <option value="">Choose one</option>
              {INDUSTRY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{INPUT_COPY.industryHint}</p>
          </div>

          {/* Email capture gate: shown before any result is revealed, the same
              place in the flow as the demo's email step. Members skip it. */}
          {!isMember && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="message-coach-name">{INPUT_COPY.nameLabel}</Label>
                <Input
                  id="message-coach-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={INPUT_COPY.namePlaceholder}
                  data-testid="input-message-coach-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="message-coach-email">{INPUT_COPY.emailLabel}</Label>
                <Input
                  id="message-coach-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={INPUT_COPY.emailPlaceholder}
                  data-testid="input-message-coach-email"
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">{INPUT_COPY.gateNote}</p>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive" data-testid="text-message-coach-error">
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={!canSubmit || scoreMutation.isPending}
            data-testid="button-message-coach-submit"
          >
            {scoreMutation.isPending ? INPUT_COPY.submitPendingLabel : INPUT_COPY.submitLabel}
          </Button>
        </form>

        {confirming && (
          <Card data-testid="card-message-coach-confirming">
            <CardContent className="space-y-1 pt-6">
              <p className="font-medium">{PAID_RETURN_COPY.headline}</p>
              <p className="text-sm text-muted-foreground">{PAID_RETURN_COPY.confirming}</p>
              <p className="text-sm text-muted-foreground">{PAID_RETURN_COPY.restore}</p>
            </CardContent>
          </Card>
        )}

        {paywall && (
          <Card style={{ borderColor: ORANGE }} data-testid="card-message-coach-paywall">
            <CardHeader>
              <CardTitle className="text-lg">{PAYWALL_COPY.headline}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{PAYWALL_COPY.body}</p>
              <p className="text-xl font-semibold" style={{ color: ORANGE }}>
                {PAYWALL_COPY.priceLine}
              </p>
              <Button
                className="w-full"
                disabled={checkoutMutation.isPending || !email.trim()}
                onClick={() => checkoutMutation.mutate()}
                data-testid="button-message-coach-checkout"
              >
                {checkoutMutation.isPending ? PAYWALL_COPY.pendingLabel : PAYWALL_COPY.buttonLabel}
              </Button>
            </CardContent>
          </Card>
        )}

        {result && (
          <div className="space-y-4" data-testid="section-message-coach-result">
            <Card>
              <CardContent className="pt-6 text-center">
                <p className="text-sm text-muted-foreground">{RESULT_COPY.scoreLabel}</p>
                <p
                  className="text-6xl font-bold tabular-nums"
                  style={{ color: ORANGE }}
                  data-testid="text-message-coach-score"
                >
                  {result.score}
                </p>
                <p className="text-sm text-muted-foreground">{RESULT_COPY.scoreSuffix}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{RESULT_COPY.stalledLabel}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm" data-testid="text-message-coach-stalled">
                  {result.stalledStep}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{RESULT_COPY.coachingLabel}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed" data-testid="text-message-coach-coaching">
                  {result.coaching}
                </p>
              </CardContent>
            </Card>

            <Card style={{ borderColor: ORANGE, borderWidth: 2 }}>
              <CardHeader>
                <CardTitle className="text-base">{RESULT_COPY.rewriteLabel}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p
                  className="whitespace-pre-wrap text-sm leading-relaxed"
                  data-testid="text-message-coach-rewrite"
                >
                  {result.rewrite}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(result.rewrite);
                    setCopied(true);
                  }}
                  data-testid="button-message-coach-copy"
                >
                  {copied ? (
                    <>
                      <Check className="mr-2 h-4 w-4" /> {RESULT_COPY.copiedLabel}
                    </>
                  ) : (
                    RESULT_COPY.copyLabel
                  )}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 pt-6 text-center">
                <p className="font-semibold">{FUNNEL_COPY.headline}</p>
                <p className="text-sm text-muted-foreground">{FUNNEL_COPY.body}</p>
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
                  <Button
                    onClick={() => navigate(FUNNEL_COPY.demoPath)}
                    data-testid="button-message-coach-demo"
                  >
                    {FUNNEL_COPY.demoLabel}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => navigate(FUNNEL_COPY.pricingPath)}
                    data-testid="button-message-coach-pricing"
                  >
                    {FUNNEL_COPY.pricingLabel}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
