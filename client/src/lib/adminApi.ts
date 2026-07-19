// Thin client for the admin API. Every request sends the admin session cookie
// (same-origin) via credentials:"include" so the server-side requireAdmin guard
// can authenticate. Kept separate from lib/queryClient.ts, which serves the
// office-scoped user app and has no cookie/session concept.
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

async function request(method: string, url: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

export type AdminSection = "visitors" | "leads" | "users" | "sales" | "demo" | "opportunities" | "paid-signups";

// --- Opportunity Intelligence ---
export type ProspectSearchRow = {
  id: number;
  segment: string;
  geography: string;
  runAt: string;
  resultsCount: number;
  status: string;
};

export type ProspectOutreachDetail = {
  id: number;
  sequenceStep: number;
  emailSubject: string;
  emailBody: string;
  scheduledAt: string;
  sentAt: string;
  status: string;
};

export type ProspectContactDetail = {
  id: number;
  fullName: string;
  title: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  outreach: ProspectOutreachDetail[];
};

export type ProspectCompanyDetail = {
  id: number;
  name: string;
  domain: string;
  segment: string;
  city: string;
  state: string;
  employeeCount: number | null;
  signalType: string;
  signalDetail: string;
  source: string;
  status: string;
  contacts: ProspectContactDetail[];
};

export type ProspectBatchDetail = {
  search: ProspectSearchRow;
  companies: ProspectCompanyDetail[];
};

export type ProspectActivityRow = {
  id: number;
  contactId: number;
  contactName: string;
  contactEmail: string;
  eventType: string;
  eventDetail: string;
  occurredAt: string;
};

export type AdminContact = {
  id: number;
  name: string;
  email: string;
  company: string;
  message: string;
  referredBy: string;
  status: string;
  type: string;
  source: string;
  priority: string;
  owner: string;
  followUpDate: string;
  followUpDue: boolean;
  createdAt: string;
};

export type ContactEvent = {
  id: number;
  contactId: number;
  eventType: string;
  description: string;
  actor: string | null;
  createdAt: string;
};

export type ContactFilters = {
  type?: string;
  priority?: string;
  status?: string;
  owner?: string;
  sort?: "followUp";
};

export type ContactPatch = {
  status?: string;
  priority?: string;
  owner?: string | null;
  followUpDate?: string | null;
  note?: string;
};

export type PaidSignupRow = {
  id: number;
  officeName: string;
  seatCount: number;
  dashboard: string;
  stripeSubscriptionId: string;
  contactEmail: string;
  createdAt: string;
};

export const adminApi = {
  async login(username: string, password: string): Promise<void> {
    const res = await request("POST", "/api/admin/login", { username, password });
    if (!res.ok) throw new Error("login failed");
  },

  async logout(): Promise<void> {
    await request("POST", "/api/admin/logout");
  },

  async me(): Promise<{ username: string } | null> {
    const res = await request("GET", "/api/admin/me");
    if (!res.ok) return null;
    return res.json();
  },

  async fetchSection(section: AdminSection): Promise<any> {
    const res = await request("GET", `/api/admin/${section}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  async updateLeadStatus(id: number, status: string): Promise<void> {
    const res = await request("PATCH", `/api/admin/leads/${id}`, { status });
    if (!res.ok) throw new Error("update failed");
  },

  // --- Unified CRM contacts ---
  async listContacts(filters: ContactFilters = {}): Promise<{ rows: AdminContact[] }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    const qs = params.toString();
    const res = await request("GET", `/api/admin/contacts${qs ? `?${qs}` : ""}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  async listContactEvents(id: number): Promise<{ rows: ContactEvent[] }> {
    const res = await request("GET", `/api/admin/contacts/${id}/events`);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  async updateContact(id: number, patch: ContactPatch): Promise<void> {
    const res = await request("PATCH", `/api/admin/contacts/${id}`, patch);
    if (!res.ok) throw new Error("update failed");
  },

  // Fetch CSV as a blob and trigger a browser download.
  async downloadCsv(section: AdminSection): Promise<void> {
    await downloadBlob(`/api/admin/${section}?format=csv`, `${section}.csv`);
  },

  async downloadContactsCsv(filters: ContactFilters = {}): Promise<void> {
    const params = new URLSearchParams({ format: "csv" });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    await downloadBlob(`/api/admin/contacts?${params.toString()}`, "contacts.csv");
  },

  // --- Opportunity Intelligence ---
  async listProspectSearches(): Promise<{ rows: ProspectSearchRow[] }> {
    const res = await request("GET", "/api/admin/opportunities/searches");
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  async getProspectBatch(id: number): Promise<ProspectBatchDetail> {
    const res = await request("GET", `/api/admin/opportunities/searches/${id}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  async approveProspectBatch(id: number): Promise<void> {
    const res = await request("POST", `/api/admin/opportunities/searches/${id}/approve`);
    if (!res.ok) throw new Error("approve failed");
  },

  async rejectProspectBatch(id: number): Promise<void> {
    const res = await request("POST", `/api/admin/opportunities/searches/${id}/reject`);
    if (!res.ok) throw new Error("reject failed");
  },

  async listProspectActivity(): Promise<{ rows: ProspectActivityRow[] }> {
    const res = await request("GET", "/api/admin/opportunities/activity");
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  // --- Self-serve office setup (items 6 & 7) ---
  // Manual activation of a free-path (pending) office. This is the only path that
  // brings a /api/register/manager office live.
  async activateOffice(id: number): Promise<void> {
    const res = await request("POST", `/api/admin/offices/${id}/activate`);
    if (!res.ok) throw new Error("activate failed");
  },

  async listPaidSignups(): Promise<{ rows: PaidSignupRow[] }> {
    const res = await request("GET", "/api/admin/paid-signups");
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  },

  async downloadPaidSignupsCsv(): Promise<void> {
    await downloadBlob("/api/admin/paid-signups?format=csv", "paid-signups.csv");
  },
};

async function downloadBlob(url: string, filename: string): Promise<void> {
  const res = await request("GET", url);
  if (!res.ok) throw new Error("csv failed");
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
