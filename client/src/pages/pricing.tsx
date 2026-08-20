import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Check, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { EVALUATION_PRICING, PLAN_TIERS, quoteEvaluation } from "@shared/pricing";

const NAVY = "#0A1A30";
const ORANGE = "#FF7A1A";
const LIME = "#B7F34A";

export default function Pricing() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [participantCount, setParticipantCount] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const quote = useMemo(() => quoteEvaluation(participantCount), [participantCount]);

  async function startEvaluation(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await apiRequest("POST", "/api/evaluation/checkout", { email, company, participantCount });
      const body = await response.json();
      if (!body.url) throw new Error("No checkout URL returned");
      window.location.assign(body.url);
    } catch (error: any) {
      const message = String(error?.message ?? "");
      if (message.includes("Verify your email")) {
        toast({
          title: "Verify your email first",
          description: "Start at account setup, verify your email, then return here to begin your evaluation.",
        });
        navigate("/signup");
      } else {
        toast({ title: "We could not start checkout", description: "Please review your details and try again.", variant: "destructive" });
      }
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[#F7F8F7] text-[#0A1A30]">
      <section className="bg-[#0A1A30] px-5 pb-20 pt-8 text-white sm:px-8 lg:px-12">
        <nav className="mx-auto flex max-w-6xl items-center justify-between">
          <a href="#/" className="text-lg font-black tracking-[-0.04em]">SOLVE</a>
          <a href="#/signup" className="text-sm font-semibold text-white/80 hover:text-white">Set up your team</a>
        </nav>
        <div className="mx-auto mt-16 max-w-3xl text-center sm:mt-20">
          <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: ORANGE }}>Simple team pricing</p>
          <h1 className="mt-5 text-4xl font-black leading-[0.98] tracking-[-0.055em] sm:text-6xl">Build better discovery practice, together.</h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
            Choose the team size that fits today. Every tier includes Command Center and the tools your team needs to practice with purpose.
          </p>
        </div>
      </section>

      <section className="mx-auto -mt-10 grid max-w-6xl gap-4 px-5 sm:grid-cols-3 sm:px-8 lg:px-12">
        {PLAN_TIERS.map((tier) => (
          <article key={tier.tier} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_16px_38px_rgba(10,26,48,0.10)]">
            <p className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: ORANGE }}>{tier.displayName}</p>
            <p className="mt-4 text-4xl font-black tracking-[-0.05em]">${tier.seatRate}<span className="text-base font-semibold text-slate-500">/person/mo</span></p>
            <p className="mt-2 text-sm text-slate-600">{tier.minSeats} to {tier.maxSeats} people</p>
            <ul className="mt-6 space-y-3 text-sm text-slate-700">
              <li className="flex gap-2"><Check className="h-4 w-4 shrink-0" style={{ color: ORANGE }} />Discovery conversation practice</li>
              <li className="flex gap-2"><Check className="h-4 w-4 shrink-0" style={{ color: ORANGE }} />Command Center included</li>
            </ul>
            <a href="#/signup" className="mt-7 flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-bold text-white" style={{ backgroundColor: ORANGE }}>Choose {tier.displayName}</a>
          </article>
        ))}
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:px-12">
        <div className="grid overflow-hidden rounded-3xl bg-white shadow-[0_18px_50px_rgba(10,26,48,0.10)] lg:grid-cols-[0.9fr_1.1fr]">
          <div className="p-7 sm:p-10" style={{ backgroundColor: NAVY }}>
            <span className="inline-flex rounded-full px-3 py-1 text-xs font-black uppercase tracking-[0.13em]" style={{ backgroundColor: LIME, color: NAVY }}>Start with clarity</span>
            <h2 className="mt-6 text-3xl font-black tracking-[-0.045em] text-white sm:text-4xl">14-Day Team Evaluation</h2>
            <p className="mt-4 text-lg font-bold" style={{ color: LIME }}>$249 for up to 5 people, then $50 per additional person.</p>
            <p className="mt-5 max-w-md leading-7 text-slate-300">A focused two-week window to help your team practice real discovery conversations and use Command Center together.</p>
            <ul className="mt-7 space-y-3 text-sm text-slate-200">
              <li className="flex gap-2"><Check className="h-4 w-4 shrink-0" style={{ color: LIME }} />14 days of team access</li>
              <li className="flex gap-2"><Check className="h-4 w-4 shrink-0" style={{ color: LIME }} />Command Center included</li>
              <li className="flex gap-2"><Check className="h-4 w-4 shrink-0" style={{ color: LIME }} />Up to {EVALUATION_PRICING.maxParticipants} participants</li>
            </ul>
          </div>
          <form onSubmit={startEvaluation} className="p-7 sm:p-10">
            <h3 className="text-xl font-black tracking-[-0.03em]">Start your evaluation</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Use the verified email from your SOLVE setup. New here? We will take you to setup after you submit.</p>
            <div className="mt-6 grid gap-4">
              <div className="space-y-1.5"><Label htmlFor="pricing-company">Company name</Label><Input id="pricing-company" value={company} onChange={(e) => setCompany(e.target.value)} required /></div>
              <div className="space-y-1.5"><Label htmlFor="pricing-email">Work email</Label><Input id="pricing-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
              <div className="space-y-1.5"><Label htmlFor="pricing-participants">Participants</Label><Input id="pricing-participants" type="number" min={3} max={10} value={participantCount} onChange={(e) => setParticipantCount(Math.min(10, Math.max(3, Number(e.target.value) || 3)))} required /></div>
            </div>
            <div className="mt-6 flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3"><span className="text-sm font-semibold">Your evaluation total</span><span className="text-lg font-black" style={{ color: ORANGE }}>${(quote.totalAmountCents / 100).toFixed(0)}</span></div>
            <Button type="submit" disabled={submitting} className="mt-5 h-11 w-full font-bold text-white" style={{ backgroundColor: ORANGE }}>{submitting ? "Opening checkout..." : "Start 14-Day Team Evaluation"}<ChevronRight className="ml-1 h-4 w-4" /></Button>
          </form>
        </div>
      </section>

      <section className="border-t border-slate-200 bg-white px-5 py-14 text-center"><p className="text-sm text-slate-600">Need a plan for 22 or more people?</p><a className="mt-2 inline-block text-sm font-black" style={{ color: ORANGE }} href="mailto:hello@solveframework.com?subject=Enterprise%20pricing">LET&apos;S TALK</a></section>
    </main>
  );
}
