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

export type AdminSection = "visitors" | "leads" | "users" | "sales";

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

  // Fetch CSV as a blob and trigger a browser download.
  async downloadCsv(section: AdminSection): Promise<void> {
    const res = await request("GET", `/api/admin/${section}?format=csv`);
    if (!res.ok) throw new Error("csv failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${section}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
