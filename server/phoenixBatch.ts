// First test-market discovery batch: Phoenix, AZ. Loaded out-of-band from a
// web_search + similarweb_enrichment discovery run (the connectors that produced
// this list run outside the deployed app — see README, "How new discovery
// batches get created"). This module holds the raw batch as data plus a PURE
// builder that turns it into the exact prospect_* rows to persist, so the load
// is unit-testable without a database. scripts/seed_phoenix_batch.ts persists it.
//
// Geography lives in `geography` as a normal data field ("Phoenix, AZ"); it is
// deliberately NOT a hardcoded constant — the next batch is just a different
// value here. Copy follows the standing convention: discovery-training /
// discovery-architecture language only, never "sales" or "AI roleplay".

import type {
  InsertProspectSearch,
  InsertProspectCompany,
  InsertProspectContact,
  InsertProspectOutreach,
} from "@shared/schema";
import { buildSequence, SEQUENCE_STEPS } from "./opportunities";

export interface BatchContactSeed {
  fullName: string;
  title: string;
  linkedinUrl?: string;
  phone?: string;
  // Explicit address when discovery captured a real one; otherwise the builder
  // derives first.last@domain (a review-stage placeholder — nothing sends on
  // insert, the batch lands as pending_review).
  email?: string;
}

export interface BatchCompanySeed {
  name: string;
  segment: string; // per-company segment tag; drives the drip angle + UI grouping
  domain?: string;
  city?: string;
  state?: string;
  // Human-readable enrichment line. Also preserves detail the schema has no
  // dedicated column for (revenue band, founding year, employee band, phone).
  signalDetail: string;
  employeeCount?: number | null;
  contacts: BatchContactSeed[];
}

export interface DiscoveryBatchSeed {
  geography: string;
  source: string; // discovery source, stored per company (searches have no source column)
  signalType: string;
  companies: BatchCompanySeed[];
}

// The Phoenix, AZ batch. Sunstate Equipment was intentionally excluded from this
// run (too large / poor fit) and must not be added here.
export const phoenixBatchSeed: DiscoveryBatchSeed = {
  geography: "Phoenix, AZ",
  source: "web_search + similarweb_enrichment",
  signalType: "enrichment",
  companies: [
    {
      name: "Chas Roberts Air Conditioning, Inc.",
      segment: "HVAC / Home Services",
      domain: "chasroberts.com",
      city: "Phoenix",
      state: "AZ",
      signalDetail:
        "Founded 1942 · ~200-500 employees · est. revenue $5M-$10M · (602) 386-2732 · info@chasroberts.com",
      contacts: [
        { fullName: "Sissie Shank", title: "President & CEO", linkedinUrl: "linkedin.com/in/sissie-roberts-shank-a4204b11" },
        { fullName: "Ally Sloan", title: "CFO", linkedinUrl: "linkedin.com/in/ally-sloan-cpa-ba344942" },
        { fullName: "Rodney Tomita", title: "VP Sales & Marketing", linkedinUrl: "linkedin.com/in/rod-tomita-b4b18669" },
        { fullName: "Feliciano Portillo", title: "General Manager", linkedinUrl: "linkedin.com/in/feliciano-portillo-5381302a4" },
        { fullName: "Danny Howard", title: "General Manager", linkedinUrl: "linkedin.com/in/danny-howard-76768b27a" },
      ],
    },
    {
      name: "Parker and Sons",
      segment: "HVAC / Home Services",
      domain: "parkerandsons.com",
      city: "Phoenix",
      state: "AZ",
      signalDetail:
        "Founded 1974 · ~50-200 employees · est. revenue $25M-$50M · 602-273-7247",
      contacts: [
        { fullName: "Paul Kelly", title: "President", linkedinUrl: "linkedin.com/in/paul-kelly-99ab90" },
        { fullName: "Brian Cline", title: "COO", linkedinUrl: "linkedin.com/in/bmcline13" },
        { fullName: "Erika Doyle", title: "CFO", linkedinUrl: "linkedin.com/in/erika-doyle-383a014a" },
        { fullName: "Holly Miller", title: "VP Internal Operations", linkedinUrl: "linkedin.com/in/holly-miller-09067a76" },
        { fullName: "Keith Kittrell", title: "VP HVAC", linkedinUrl: "linkedin.com/in/keith-kittrell-77b02210" },
        { fullName: "Justine Kelly", title: "VP Marketing", linkedinUrl: "linkedin.com/in/justine-kelly-48073720" },
      ],
    },
    {
      name: "Valley Vistas Management Company Inc",
      segment: "Manufactured Housing Community Management",
      domain: "valleyvistasmc.com",
      city: "Scottsdale",
      state: "AZ",
      signalDetail: "~10-50 employees · est. revenue $1M-$2M · +1 602 595 7417",
      contacts: [
        { fullName: "Randall Johnson", title: "President", linkedinUrl: "linkedin.com/in/randall-johnson-07b39938" },
        { fullName: "TJ Geninatti", title: "COO", linkedinUrl: "linkedin.com/in/tjgeninatti", email: "tj@valleyvistasmc.com" },
      ],
    },
    {
      name: "MAR Communities",
      segment: "Manufactured Housing Community Management",
      domain: "marcommunities.com",
      city: "Mesa",
      state: "AZ",
      signalDetail: "~10-50 employees · 480-282-6014 · sales@marcompanies.com",
      contacts: [
        { fullName: "Dawn Couture", title: "Manager Operations", linkedinUrl: "linkedin.com/in/dawn-couture-3341b4120" },
      ],
    },
    {
      name: "Berge Auto Group",
      segment: "Auto Dealerships",
      domain: "bergegroup.com",
      city: "Gilbert",
      state: "AZ",
      signalDetail: "~10-50 employees · est. revenue $5M-$10M · (480) 985-2675",
      contacts: [
        { fullName: "Emily Androsky", title: "Director Digital Marketing", linkedinUrl: "linkedin.com/in/emily-androsky-7610441a" },
        { fullName: "Stephen Crawford", title: "Director Corporate Finance", linkedinUrl: "linkedin.com/in/stephen-crawford-25b0a136" },
        { fullName: "Jesse McMahan", title: "Corporate Fleet Director", linkedinUrl: "linkedin.com/in/jesse-mcmahan-02140244" },
        { fullName: "Caelen Armijo", title: "Sales Manager", linkedinUrl: "linkedin.com/in/caelen-armijo-7aa35736" },
      ],
    },
    {
      name: "Plaza Companies",
      segment: "Property Management / Conflict-Heavy Service Businesses",
      domain: "theplazaco.com",
      city: "Peoria",
      state: "AZ",
      signalDetail:
        "Founded 1982 · ~50-200 employees · est. revenue $100M-$200M · +1 623 972 1184 · info@theplazaco.com",
      contacts: [
        { fullName: "Sharon Harper", title: "President & CEO", linkedinUrl: "linkedin.com/in/sharon-harper-8075b710" },
        { fullName: "Larry Pinalto", title: "CFO & COO", linkedinUrl: "linkedin.com/in/larry-pinalto-38445115" },
        { fullName: "Elizabeth Berry", title: "Executive Managing Director of Development", linkedinUrl: "linkedin.com/in/lizcberry" },
        { fullName: "Bill Cook", title: "VP Brokerage Services" },
        { fullName: "Jonathan Stelzer", title: "Director Construction", linkedinUrl: "linkedin.com/in/jonathan-stelzer-41025b12" },
      ],
    },
    {
      name: "Commercial Properties Inc. (CPI)",
      segment: "Property Management / Conflict-Heavy Service Businesses",
      domain: "cpiaz.com",
      city: "Tempe",
      state: "AZ",
      signalDetail:
        "Founded 1981 · ~50-200 employees · est. revenue $15M-$25M · (480) 966-8228 · info@cpiaz.com",
      contacts: [
        { fullName: "Leroy Breinholt", title: "President & Designated Broker", linkedinUrl: "linkedin.com/in/leroy-breinholt-b2633875" },
        { fullName: "Kenneth Elmer", title: "Senior VP Sales & Leasing Investments", linkedinUrl: "linkedin.com/in/kenelmer" },
        { fullName: "Cory Sposi", title: "Leasing VP Sales", linkedinUrl: "linkedin.com/in/corysposi" },
        { fullName: "Bruce Hanley", title: "VP", linkedinUrl: "linkedin.com/in/bruce-hanley-649a8b7" },
        { fullName: "Darin Edwards", title: "VP Sales & Leasing", linkedinUrl: "linkedin.com/in/darin-edwards-160276237" },
      ],
    },
  ],
};

// Derive a review-stage placeholder address (first.last@domain) for contacts
// whose real email discovery didn't capture. The batch lands as pending_review
// and nothing sends on insert, so an admin can correct these before approval.
export function deriveContactEmail(fullName: string, domain: string): string {
  const parts = fullName
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const local = parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0] || "contact";
  return `${local}@${domain}`;
}

// The distinct per-company segments, in first-seen order. Stored joined on the
// single free-text search.segment field so the batch records every segment it
// spans while each company keeps its own tag.
export function distinctSegments(seed: DiscoveryBatchSeed): string[] {
  const seen: string[] = [];
  for (const co of seed.companies) if (!seen.includes(co.segment)) seen.push(co.segment);
  return seen;
}

export interface PlannedContact {
  contact: Omit<InsertProspectContact, "companyId" | "createdAt">;
  outreach: Omit<InsertProspectOutreach, "contactId" | "searchId">[];
}

export interface PlannedCompany {
  company: Omit<InsertProspectCompany, "discoveredAt">;
  contacts: PlannedContact[];
}

export interface PlannedBatch {
  search: Omit<InsertProspectSearch, "runAt"> & { runAt?: string };
  companies: PlannedCompany[];
  contactCount: number;
  outreachCount: number;
}

// Turn the seed into the concrete rows to insert. Pure: computes the search,
// company, contact and generated three-step outreach rows without touching the
// database, so both the seed runner and the test share one source of truth.
export function planPhoenixBatch(seed: DiscoveryBatchSeed = phoenixBatchSeed): PlannedBatch {
  const segments = distinctSegments(seed);
  let contactCount = 0;
  let outreachCount = 0;

  const companies: PlannedCompany[] = seed.companies.map((co) => {
    const domain = co.domain || "example.com";
    const contacts: PlannedContact[] = co.contacts.map((ct) => {
      contactCount += 1;
      const email = ct.email || deriveContactEmail(ct.fullName, domain);
      const drafts = buildSequence(co.segment, { contactName: ct.fullName, companyName: co.name });
      const outreach = SEQUENCE_STEPS.map((step) => {
        const draft = drafts.find((d) => d.step === step)!;
        outreachCount += 1;
        return {
          sequenceStep: step,
          emailSubject: draft.emailSubject,
          emailBody: draft.emailBody,
          scheduledAt: null,
          sentAt: null,
          status: "draft" as const,
        };
      });
      return {
        contact: {
          fullName: ct.fullName,
          title: ct.title,
          email,
          phone: ct.phone || null,
          linkedinUrl: ct.linkedinUrl || null,
        },
        outreach,
      };
    });

    return {
      company: {
        name: co.name,
        domain: co.domain || null,
        segment: co.segment,
        city: co.city || null,
        state: co.state || null,
        employeeCount: co.employeeCount ?? null,
        signalType: seed.signalType,
        signalDetail: co.signalDetail,
        source: seed.source,
        status: "new",
      },
      contacts,
    };
  });

  return {
    search: {
      segment: segments.join("; "),
      geography: seed.geography,
      resultsCount: seed.companies.length,
      status: "pending_review",
    },
    companies,
    contactCount,
    outreachCount,
  };
}
