import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, BarChart3, GraduationCap, UsersRound } from "lucide-react";
import entranceSkylineBackground from "@/assets/entrance-skyline-bg.png";

const ORANGE = "#E06D00";
const COMMAND_BLUE = "#3B82F6";

export default function Home() {
  const [, navigate] = useLocation();

  return (
    <main
      className="relative isolate min-h-dvh overflow-hidden bg-[#050C1C] text-white"
      data-testid="page-entrance"
    >
      <a
        href="https://solveframework.com/pricing.html#manager-dashboard"
        className="relative z-10 block border-b-2 border-[#050C1C] bg-[#C6F135] text-[#050C1C] transition hover:bg-[#b8e029]"
        data-testid="link-entrance-announce-pricing"
      >
        <span className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-1.5 px-4 py-2 text-center text-xs font-medium leading-snug sm:gap-2 sm:px-6 sm:text-sm">
          <span>
            <strong className="font-bold">Dashboard pricing: 25% off, locked for your first year</strong>, plus an extra 20% off with annual prepay. Price increases September 1.
          </span>
          <span className="inline-flex items-center gap-1 whitespace-nowrap font-bold uppercase tracking-wide">
            See pricing
            <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </span>
      </a>

      <div className="relative isolate overflow-hidden px-4 py-4 sm:px-6 sm:py-8">
      <img
        src={entranceSkylineBackground}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 -z-20 h-full w-full object-cover object-center"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(5,12,28,0.92)_0%,rgba(5,12,28,0.58)_24%,rgba(5,12,28,0.46)_70%,rgba(5,12,28,0.93)_100%)]"
      />

      <div className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col justify-center sm:min-h-[calc(100dvh-4rem)]">
        <header className="mx-auto max-w-2xl text-center" data-testid="section-entrance-heading">
          <div className="inline-flex items-center justify-center rounded-[10px] bg-[#050C1C]/90 px-3 py-1.5 shadow-lg shadow-black/25 backdrop-blur-sm">
            <img
              src="/solve-wordmark-bigtag-transparent.png"
              alt="SOLVE Framework - Practice. Performance. Period."
              className="h-10 w-auto max-w-full sm:h-14"
              data-testid="img-solve-logo"
            />
          </div>
          <h1 className="mt-3 text-[clamp(1.75rem,1.45rem+1.4vw,2.35rem)] font-bold leading-tight tracking-tight text-white sm:mt-4" data-testid="text-home-title">
            Welcome to SOLVE Platform™
          </h1>
          <p className="mt-1 text-sm font-medium text-slate-200 sm:text-base" data-testid="text-home-subtitle">
            Where would you like to go?
          </p>
        </header>

        <section
          className="mx-auto mt-4 grid w-full max-w-4xl gap-3 md:mt-8 md:grid-cols-2 md:gap-6"
          aria-label="Choose an entrance"
          data-testid="grid-entrance-options"
        >
          <article
            className="rounded-2xl border bg-[#050C1C]/70 p-4 shadow-2xl shadow-black/25 backdrop-blur-md sm:p-6"
            style={{ borderColor: "rgba(224, 109, 0, 0.86)" }}
            data-testid="card-practice"
          >
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-[#E06D00]/15 sm:h-11 sm:w-11"
                style={{ borderColor: "rgba(224, 109, 0, 0.62)", color: ORANGE }}
                aria-hidden="true"
              >
                <GraduationCap className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold tracking-wide text-white">PRACTICE</h2>
                <p className="mt-0.5 text-sm font-semibold" style={{ color: "#FF9A45" }}>
                  Practice, Academy &amp; Certification
                </p>
              </div>
            </div>

            <ul className="mt-4 space-y-1 text-sm leading-5 text-slate-100 sm:mt-5 sm:space-y-1.5" aria-label="Practice benefits">
              <li>Sharpen your skills.</li>
              <li>Complete scenarios.</li>
              <li>Earn certifications.</li>
              <li>Get better every day.</li>
            </ul>

            <button
              type="button"
              onClick={() => navigate("/practice")}
              className="mt-4 flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-2 text-sm font-bold text-white shadow-lg shadow-black/20 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:mt-6 sm:py-2.5"
              style={{ backgroundColor: ORANGE }}
              data-testid="link-choose-practice"
            >
              Enter Practice
            </button>
          </article>

          <article
            className="rounded-2xl border bg-[#050C1C]/70 p-4 shadow-2xl shadow-black/25 backdrop-blur-md sm:p-6"
            style={{ borderColor: "rgba(59, 130, 246, 0.9)" }}
            data-testid="card-command-center"
          >
            <div className="flex items-center gap-3">
              <div
                className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-[#3B82F6]/15 sm:h-11 sm:w-11"
                style={{ borderColor: "rgba(59, 130, 246, 0.66)", color: COMMAND_BLUE }}
                aria-hidden="true"
              >
                <UsersRound className="h-6 w-6" />
                <BarChart3 className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-sm bg-[#050C1C] p-px" />
              </div>
              <div>
                <h2 className="text-xl font-bold tracking-wide text-white">COMMAND CENTER</h2>
                <p className="mt-0.5 text-sm font-semibold text-blue-300">
                  Team performance, insights &amp; management
                </p>
              </div>
            </div>

            <ul className="mt-4 space-y-1 text-sm leading-5 text-slate-100 sm:mt-5 sm:space-y-1.5" aria-label="Command Center benefits">
              <li>See what drives performance.</li>
              <li>Coach with confidence.</li>
              <li>Build a stronger team.</li>
              <li>Win more together.</li>
            </ul>

            <button
              type="button"
              onClick={() => navigate("/command-center")}
              className="mt-4 flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-2 text-sm font-bold text-white shadow-lg shadow-black/20 transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:mt-6 sm:py-2.5"
              style={{ backgroundColor: COMMAND_BLUE }}
              data-testid="link-choose-command-center"
            >
              Enter Command Center
            </button>
          </article>
        </section>

        <div className="mt-4 text-center md:mt-7">
          <a
            href="https://solveframework.com"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-100 transition hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
            data-testid="link-back-to-solveframework"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to SOLVE Framework
          </a>
        </div>
      </div>
      </div>
    </main>
  );
}
