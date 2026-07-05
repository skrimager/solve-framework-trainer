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

export type AdminSection = "visitors" | "leads" | "users" | "sales" | "demo";

export type AdminContact = {
  id: number;
  name: string;
  email: string;
  company: string;
  message: string;
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
