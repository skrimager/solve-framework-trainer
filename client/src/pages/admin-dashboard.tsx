import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  adminApi,
  type AdminSection,
  type AdminContact,
  type ContactEvent,
  type ProspectSearchRow,
  type ProspectBatchDetail,
  type ProspectActivityRow,
} from "@/lib/adminApi";
import { Download, LogOut, Users, FileText, Eye, DollarSign, X, Mic, Target, Menu } from "lucide-react";
import { cn } from "@/lib/utils";

const NAVY = "#0A1A30";
const NAVY_DARK = "#05162D";
const ORANGE = "#E06D00";

const SECTIONS: { key: AdminSection; label: string; icon: any; title?: string }[] = [
  { key: "visitors", label: "Visitors", icon: Eye },
  { key: "leads", label: "Contacts", icon: FileText },
  { key: "users", label: "All Users", icon: Users },
  { key: "sales", label: "Sales", icon: DollarSign },
  { key: "paid-signups", label: "Paid Signups", icon: DollarSign },
  { key: "demo", label: "Voice Demo", icon: Mic },
  { key: "opportunities", label: "Opportunity Intel", icon: Target, title: "SOLVE Opportunity Intelligence™" },
];

const CONTACT_TYPES = ["speaking", "consulting", "book", "training", "role_play", "general"];
const CONTACT_PRIORITIES = ["high", "medium", "low"];
const CONTACT_STATUSES = ["new", "contacted", "converted"];

function priorityColor(p: string): string {
  return p === "high" ? "#E0483C" : p === "medium" ? "#E0A800" : "#3CA0E0";
}

export default function AdminDashboard() {
  const [location, navigate] = useLocation();
  const [authChecked, setAuthChecked] = useState(false);
  // Deep-link support: /admin/opportunities opens the Opportunities tab directly.
  const [section, setSection] = useState<AdminSection>(
    location === "/admin/opportunities" ? "opportunities" : "visitors",
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    adminApi.me().then((me) => {
      if (!me) {
        navigate("/admin/login");
      } else {
        setAuthChecked(true);
      }
    });
  }, []);

  async function handleLogout() {
    await adminApi.logout();
    navigate("/admin/login");
  }

  if (!authChecked) {
    return (
      <div className="min-h-dvh flex items-center justify-center" style={{ backgroundColor: NAVY_DARK }}>
        <p className="text-white/60">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex" style={{ backgroundColor: NAVY_DARK }}>
      {/* Mobile top bar (below lg): hamburger + title */}
      <header
        className="lg:hidden fixed top-0 inset-x-0 z-30 flex items-center gap-3 h-14 px-4 border-b border-white/10"
        style={{ backgroundColor: NAVY }}
      >
        <button
          onClick={() => setMobileNavOpen(true)}
          data-testid="button-admin-nav-toggle"
          aria-label="Open navigation"
          className="text-white/80 hover:text-white"
        >
          <Menu className="w-6 h-6" />
        </button>
        <p className="text-white font-bold text-base">Solve Admin</p>
      </header>

      {/* Off-canvas overlay (below lg) */}
      {mobileNavOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setMobileNavOpen(false)}
          data-testid="admin-nav-overlay"
        />
      )}

      {/* Sidebar: static on lg+, off-canvas drawer below lg */}
      <aside
        className={cn(
          "w-56 shrink-0 flex flex-col border-r border-white/10",
          "fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out",
          "lg:static lg:z-auto lg:translate-x-0",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
        style={{ backgroundColor: NAVY }}
      >
        <div className="px-5 py-5 border-b border-white/10 flex items-start justify-between">
          <div>
            <p className="text-white font-bold text-lg">Solve Admin</p>
            <p className="text-white/50 text-xs">Internal console</p>
          </div>
          <button
            onClick={() => setMobileNavOpen(false)}
            data-testid="button-admin-nav-close"
            aria-label="Close navigation"
            className="lg:hidden text-white/60 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <nav className="flex-1 py-3">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.key;
            return (
              <button
                key={s.key}
                onClick={() => {
                  setSection(s.key);
                  setMobileNavOpen(false);
                }}
                data-testid={`nav-${s.key}`}
                title={s.title}
                className="w-full flex items-center gap-3 px-5 py-3 text-sm text-left transition-colors"
                style={{
                  backgroundColor: active ? ORANGE : "transparent",
                  color: active ? "white" : "rgba(255,255,255,0.7)",
                }}
              >
                <Icon className="w-4 h-4" />
                {s.label}
              </button>
            );
          })}
        </nav>
        <button
          onClick={handleLogout}
          data-testid="button-admin-logout"
          className="flex items-center gap-3 px-5 py-4 text-sm text-white/60 hover:text-white border-t border-white/10"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-auto p-4 pt-20 lg:p-6">
        <SectionView key={section} section={section} />
      </main>
    </div>
  );
}

function SectionView({ section }: { section: AdminSection }) {
  // The Leads tab is now the full CRM Contacts view, which manages its own
  // filters/fetching/detail panel independently of the generic table sections.
  if (section === "leads") {
    return <ContactsSection />;
  }
  if (section === "opportunities") {
    return <OpportunitiesSection />;
  }
  return <GenericSectionView section={section} />;
}

function GenericSectionView({ section }: { section: AdminSection }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.fetchSection(section);
      setData(res);
    } catch {
      setError("Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [section]);

  useEffect(() => {
    load();
  }, [load]);

  const title = SECTIONS.find((s) => s.key === section)?.label ?? "";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          {section === "sales" && data && (
            <p className="text-white/60 text-sm mt-1" data-testid="text-sales-summary">
              {data.activeOffices} active office(s) · Total MRR ${data.totalMrr}
              {data.totalAcademyCreditDisplay ? ` · Academy Credits ${data.totalAcademyCreditDisplay}` : ""}
            </p>
          )}
          {section !== "sales" && data?.rows && (
            <p className="text-white/60 text-sm mt-1">{data.rows.length} row(s)</p>
          )}
        </div>
        <Button
          onClick={() => adminApi.downloadCsv(section)}
          style={{ backgroundColor: ORANGE, color: "white" }}
          data-testid={`button-export-${section}`}
        >
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY }}>
        {loading && <p className="p-6 text-white/50">Loading…</p>}
        {error && <p className="p-6 text-red-300" data-testid="text-section-error">{error}</p>}
        {!loading && !error && data && (
          <>
            {section === "visitors" && <VisitorsTable rows={data.rows} />}
            {section === "users" && <UsersTable rows={data.rows} />}
            {section === "sales" && <SalesTable rows={data.rows} onChanged={load} />}
            {section === "paid-signups" && <PaidSignupsTable rows={data.rows} />}
            {section === "demo" && <DemoTable rows={data.rows} analytics={data.analytics} />}
          </>
        )}
      </div>
    </div>
  );
}

const headCls = "text-white/70 whitespace-nowrap";
const cellCls = "text-white/90 whitespace-nowrap";

function EmptyRow({ span }: { span: number }) {
  return (
    <TableRow>
      <TableCell colSpan={span} className="text-center text-white/40 py-8">
        No data yet.
      </TableCell>
    </TableRow>
  );
}

function VisitorsTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent border-white/10">
          <TableHead className={headCls}>Path</TableHead>
          <TableHead className={headCls}>Referrer</TableHead>
          <TableHead className={headCls}>Token</TableHead>
          <TableHead className={headCls}>Timestamp</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow span={4} />}
        {rows.map((r) => (
          <TableRow key={r.id} className="border-white/10" data-testid={`row-visitor-${r.id}`}>
            <TableCell className={cellCls}>{r.path}</TableCell>
            <TableCell className={cellCls}>{r.referrer || "-"}</TableCell>
            <TableCell className="text-white/50 font-mono text-xs">{(r.visitorToken || "").slice(0, 12)}</TableCell>
            <TableCell className="text-white/60 text-xs">{r.createdAt}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const selectCls = "bg-white/10 text-white text-sm rounded px-2 py-1 border border-white/20";

function Tag({ label }: { label: string }) {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-white/10 text-white/70 border border-white/15">
      {label}
    </span>
  );
}

function ContactsSection() {
  const [rows, setRows] = useState<AdminContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<{ type: string; priority: string; status: string }>({
    type: "",
    priority: "",
    status: "",
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.listContacts({ ...filters, sort: "followUp" });
      setRows(res.rows);
    } catch {
      setError("Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback(
    async (id: number, p: Parameters<typeof adminApi.updateContact>[1]) => {
      await adminApi.updateContact(id, p);
      load();
    },
    [load],
  );

  const selected = rows?.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Contacts</h1>
          {rows && <p className="text-white/60 text-sm mt-1">{rows.length} contact(s)</p>}
        </div>
        <Button
          onClick={() => adminApi.downloadContactsCsv(filters)}
          style={{ backgroundColor: ORANGE, color: "white" }}
          data-testid="button-export-contacts"
        >
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-white/60 text-xs">Type</label>
        <select
          className={selectCls}
          value={filters.type}
          data-testid="filter-contact-type"
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
        >
          <option value="">all</option>
          {CONTACT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <label className="text-white/60 text-xs">Priority</label>
        <select
          className={selectCls}
          value={filters.priority}
          data-testid="filter-contact-priority"
          onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
        >
          <option value="">all</option>
          {CONTACT_PRIORITIES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <label className="text-white/60 text-xs">Status</label>
        <select
          className={selectCls}
          value={filters.status}
          data-testid="filter-contact-status"
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
        >
          <option value="">all</option>
          {CONTACT_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY }}>
        {loading && <p className="p-6 text-white/50">Loading…</p>}
        {error && <p className="p-6 text-red-300" data-testid="text-section-error">{error}</p>}
        {!loading && !error && rows && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-white/10">
                <TableHead className={headCls}>Name</TableHead>
                <TableHead className={headCls}>Email</TableHead>
                <TableHead className={headCls}>Tags</TableHead>
                <TableHead className={headCls}>Referred By</TableHead>
                <TableHead className={headCls}>Priority</TableHead>
                <TableHead className={headCls}>Owner</TableHead>
                <TableHead className={headCls}>Follow-up</TableHead>
                <TableHead className={headCls}>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && <EmptyRow span={8} />}
              {rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="border-white/10 cursor-pointer hover:bg-white/5"
                  data-testid={`row-contact-${r.id}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <TableCell className={cellCls}>{r.name}</TableCell>
                  <TableCell className={cellCls}>{r.email}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Tag label={r.type} />
                      <Tag label={r.source} />
                    </div>
                  </TableCell>
                  <TableCell className={cellCls} data-testid={`cell-contact-referred-by-${r.id}`}>
                    {r.referredBy || "-"}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: priorityColor(r.priority) }}
                      />
                      <select
                        value={r.priority}
                        onChange={(e) => patch(r.id, { priority: e.target.value })}
                        data-testid={`select-contact-priority-${r.id}`}
                        className={selectCls}
                      >
                        {CONTACT_PRIORITIES.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      defaultValue={r.owner}
                      placeholder="unassigned"
                      data-testid={`input-contact-owner-${r.id}`}
                      onBlur={(e) => {
                        if (e.target.value !== r.owner) patch(r.id, { owner: e.target.value });
                      }}
                      className={`${selectCls} w-28`}
                    />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        defaultValue={(r.followUpDate || "").slice(0, 10)}
                        data-testid={`input-contact-followup-${r.id}`}
                        onChange={(e) => patch(r.id, { followUpDate: e.target.value })}
                        className={selectCls}
                      />
                      {r.followUpDue && (
                        <span
                          className="text-[10px] uppercase font-semibold text-red-300"
                          data-testid={`badge-followup-due-${r.id}`}
                        >
                          Due
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <select
                      value={r.status}
                      onChange={(e) => patch(r.id, { status: e.target.value })}
                      data-testid={`select-contact-status-${r.id}`}
                      className={selectCls}
                    >
                      {CONTACT_STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {selected && (
        <ContactDetail
          contact={selected}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function ContactDetail({
  contact,
  onClose,
  onChanged,
}: {
  contact: AdminContact;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [events, setEvents] = useState<ContactEvent[] | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const loadEvents = useCallback(async () => {
    try {
      const res = await adminApi.listContactEvents(contact.id);
      setEvents(res.rows);
    } catch {
      setEvents([]);
    }
  }, [contact.id]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  async function addNote() {
    const text = note.trim();
    if (!text) return;
    setSaving(true);
    try {
      await adminApi.updateContact(contact.id, { note: text });
      setNote("");
      await loadEvents();
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={onClose}
      data-testid="contact-detail-overlay"
    >
      <div
        className="w-full max-w-md h-full overflow-auto p-6 border-l border-white/10"
        style={{ backgroundColor: NAVY }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">{contact.name}</h2>
            <p className="text-white/60 text-sm">{contact.email}</p>
          </div>
          <button onClick={onClose} data-testid="button-close-detail" className="text-white/60 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Tag label={contact.type} />
          <Tag label={contact.source} />
          <Tag label={`priority: ${contact.priority}`} />
          <Tag label={`status: ${contact.status}`} />
          {contact.owner && <Tag label={`owner: ${contact.owner}`} />}
          {contact.followUpDate && <Tag label={`follow-up: ${contact.followUpDate.slice(0, 10)}`} />}
        </div>
        {contact.message && <p className="mt-3 text-white/70 text-sm whitespace-pre-wrap">{contact.message}</p>}
        {contact.referredBy && (
          <p className="mt-3 text-white/70 text-sm" data-testid="text-contact-referred-by">
            <span className="text-white/50">Referred by:</span> {contact.referredBy}
          </p>
        )}

        <div className="mt-6">
          <label className="text-white/80 text-sm font-semibold">Add note</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="input-add-note"
            rows={3}
            className="mt-1 w-full bg-white/10 text-white text-sm rounded px-3 py-2 border border-white/20"
            placeholder="Log a call, email, or context…"
          />
          <Button
            onClick={addNote}
            disabled={saving || !note.trim()}
            data-testid="button-add-note"
            className="mt-2"
            style={{ backgroundColor: ORANGE, color: "white" }}
          >
            {saving ? "Saving…" : "Add note"}
          </Button>
        </div>

        <div className="mt-6">
          <h3 className="text-white/80 text-sm font-semibold mb-2">Timeline</h3>
          {events === null && <p className="text-white/50 text-sm">Loading…</p>}
          {events && events.length === 0 && <p className="text-white/40 text-sm">No events yet.</p>}
          <ul className="space-y-3">
            {events?.map((ev) => (
              <li key={ev.id} className="border-l-2 border-white/15 pl-3" data-testid={`event-${ev.id}`}>
                <p className="text-white/90 text-sm">{ev.description}</p>
                <p className="text-white/40 text-xs">
                  {ev.eventType} · {ev.actor || "system"} · {ev.createdAt.slice(0, 19).replace("T", " ")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function UsersTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent border-white/10">
          <TableHead className={headCls}>Username</TableHead>
          <TableHead className={headCls}>Name</TableHead>
          <TableHead className={headCls}>Office</TableHead>
          <TableHead className={headCls}>Role</TableHead>
          <TableHead className={headCls}>Level</TableHead>
          <TableHead className={headCls}>Seat</TableHead>
          <TableHead className={headCls}>Office Subscription</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow span={7} />}
        {rows.map((r) => (
          <TableRow key={r.id} className="border-white/10" data-testid={`row-user-${r.id}`}>
            <TableCell className={cellCls}>{r.username}</TableCell>
            <TableCell className={cellCls}>{r.displayName}</TableCell>
            <TableCell className={cellCls}>{r.office}</TableCell>
            <TableCell className={cellCls}>{r.role}</TableCell>
            <TableCell className={cellCls}>{r.currentLevel}</TableCell>
            <TableCell className={cellCls}>{r.seatActive}{r.isDemoAccount === "yes" ? " (demo)" : ""}</TableCell>
            <TableCell className={cellCls}>{r.subscriptionStatus}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type DemoAnalytics = {
  totalSessions: number;
  uniqueDevices: number;
  sessionsPerDay: { date: string; count: number }[];
  blockedDevices: { fingerprint: string; sessions: number; emails: number; lastAt: string }[];
  blockedIps: { ip: string; sessions: number; emails: number; lastAt: string }[];
};

function DemoStatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-white/10 p-4" style={{ backgroundColor: NAVY_DARK }}>
      <div className="text-white/60 text-xs uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold text-white mt-1">{value}</div>
    </div>
  );
}

function DemoTable({ rows, analytics }: { rows: any[]; analytics?: DemoAnalytics }) {
  const recentDays = (analytics?.sessionsPerDay ?? []).slice(-14).reverse();
  return (
    <div className="space-y-6 p-4">
      {analytics && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <DemoStatCard label="Total Sessions" value={analytics.totalSessions} />
            <DemoStatCard label="Unique Devices" value={analytics.uniqueDevices} />
            <DemoStatCard label="Blocked Devices / IPs" value={`${analytics.blockedDevices.length} / ${analytics.blockedIps.length}`} />
          </div>

          <div>
            <h2 className="text-sm font-semibold text-white/80 mb-2">Sessions per day (last 14)</h2>
            <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY_DARK }}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-white/10">
                    <TableHead className={headCls}>Date</TableHead>
                    <TableHead className={headCls}>Sessions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentDays.length === 0 && <EmptyRow span={2} />}
                  {recentDays.map((d) => (
                    <TableRow key={d.date} className="border-white/10" data-testid={`row-demo-day-${d.date}`}>
                      <TableCell className={cellCls}>{d.date}</TableCell>
                      <TableCell className={cellCls}>{d.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <h2 className="text-sm font-semibold text-white/80 mb-2">Blocked devices (cap reached)</h2>
              <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY_DARK }}>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-white/10">
                      <TableHead className={headCls}>Fingerprint</TableHead>
                      <TableHead className={headCls}>Sessions</TableHead>
                      <TableHead className={headCls}>Emails</TableHead>
                      <TableHead className={headCls}>Last Seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analytics.blockedDevices.length === 0 && <EmptyRow span={4} />}
                    {analytics.blockedDevices.map((d) => (
                      <TableRow key={d.fingerprint} className="border-white/10" data-testid={`row-demo-device-${d.fingerprint}`}>
                        <TableCell className="text-white/80 text-xs font-mono">{d.fingerprint.slice(0, 16)}…</TableCell>
                        <TableCell className={cellCls}>{d.sessions}</TableCell>
                        <TableCell className={cellCls}>{d.emails}</TableCell>
                        <TableCell className="text-white/60 text-xs">{d.lastAt}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold text-white/80 mb-2">Blocked IPs (cap reached in 30 days)</h2>
              <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY_DARK }}>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-white/10">
                      <TableHead className={headCls}>IP</TableHead>
                      <TableHead className={headCls}>Sessions</TableHead>
                      <TableHead className={headCls}>Emails</TableHead>
                      <TableHead className={headCls}>Last Seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analytics.blockedIps.length === 0 && <EmptyRow span={4} />}
                    {analytics.blockedIps.map((d) => (
                      <TableRow key={d.ip} className="border-white/10" data-testid={`row-demo-ip-${d.ip}`}>
                        <TableCell className="text-white/80 text-xs font-mono">{d.ip}</TableCell>
                        <TableCell className={cellCls}>{d.sessions}</TableCell>
                        <TableCell className={cellCls}>{d.emails}</TableCell>
                        <TableCell className="text-white/60 text-xs">{d.lastAt}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        </>
      )}

      <div>
        <h2 className="text-sm font-semibold text-white/80 mb-2">Signups</h2>
        <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY_DARK }}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-white/10">
                <TableHead className={headCls}>Email</TableHead>
                <TableHead className={headCls}>Verified</TableHead>
                <TableHead className={headCls}>Sessions Used</TableHead>
                <TableHead className={headCls}>Completed</TableHead>
                <TableHead className={headCls}>First Seen</TableHead>
                <TableHead className={headCls}>Last Code Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && <EmptyRow span={6} />}
              {rows.map((r) => (
                <TableRow key={r.id} className="border-white/10" data-testid={`row-demo-${r.id}`}>
                  <TableCell className={cellCls}>{r.email}</TableCell>
                  <TableCell className={cellCls}>{r.verified}</TableCell>
                  <TableCell className={cellCls}>{r.sessionsUsed} / {r.maxSessions}</TableCell>
                  <TableCell className={cellCls}>{r.completedSessions}</TableCell>
                  <TableCell className="text-white/60 text-xs">{r.createdAt}</TableCell>
                  <TableCell className="text-white/60 text-xs">{r.lastSentAt || "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function batchStatusColor(s: string): string {
  return s === "approved" ? "#2FB170" : s === "rejected" ? "#E0483C" : "#E0A800";
}

function OpportunitiesSection() {
  const [searches, setSearches] = useState<ProspectSearchRow[] | null>(null);
  const [activity, setActivity] = useState<ProspectActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, a] = await Promise.all([adminApi.listProspectSearches(), adminApi.listProspectActivity()]);
      setSearches(s.rows);
      setActivity(a.rows);
    } catch {
      setError("Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    async (id: number, action: "approve" | "reject") => {
      setBusyId(id);
      try {
        if (action === "approve") await adminApi.approveProspectBatch(id);
        else await adminApi.rejectProspectBatch(id);
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">SOLVE Opportunity Intelligence™</h1>
        <p className="text-white/60 text-sm mt-1">
          Outbound discovery-training batches. Review a batch, then approve to schedule its email sequence or reject to hold it.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY }}>
        {loading && <p className="p-6 text-white/50">Loading…</p>}
        {error && <p className="p-6 text-red-300" data-testid="text-section-error">{error}</p>}
        {!loading && !error && searches && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-white/10">
                <TableHead className={headCls}>Segment</TableHead>
                <TableHead className={headCls}>Geography</TableHead>
                <TableHead className={headCls}>Run</TableHead>
                <TableHead className={headCls}>Companies</TableHead>
                <TableHead className={headCls}>Status</TableHead>
                <TableHead className={headCls}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {searches.length === 0 && <EmptyRow span={6} />}
              {searches.map((s) => (
                <TableRow
                  key={s.id}
                  className="border-white/10 cursor-pointer hover:bg-white/5"
                  data-testid={`row-batch-${s.id}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <TableCell className={cellCls}>{s.segment}</TableCell>
                  <TableCell className={cellCls}>{s.geography}</TableCell>
                  <TableCell className="text-white/60 text-xs">{s.runAt.slice(0, 10)}</TableCell>
                  <TableCell className={cellCls}>{s.resultsCount}</TableCell>
                  <TableCell>
                    <span
                      className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ backgroundColor: batchStatusColor(s.status), color: "white" }}
                      data-testid={`badge-batch-status-${s.id}`}
                    >
                      {s.status.replace(/_/g, " ")}
                    </span>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {s.status === "pending_review" ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={busyId === s.id}
                          onClick={() => decide(s.id, "approve")}
                          data-testid={`button-approve-batch-${s.id}`}
                          style={{ backgroundColor: ORANGE, color: "white" }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === s.id}
                          onClick={() => decide(s.id, "reject")}
                          data-testid={`button-reject-batch-${s.id}`}
                        >
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <span className="text-white/40 text-xs">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Activity feed */}
      <div>
        <h2 className="text-lg font-bold text-white mb-2">Recent activity</h2>
        <div className="rounded-lg border border-white/10 overflow-auto" style={{ backgroundColor: NAVY }}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-white/10">
                <TableHead className={headCls}>When</TableHead>
                <TableHead className={headCls}>Contact</TableHead>
                <TableHead className={headCls}>Event</TableHead>
                <TableHead className={headCls}>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(!activity || activity.length === 0) && <EmptyRow span={4} />}
              {activity?.map((e) => (
                <TableRow key={e.id} className="border-white/10" data-testid={`row-activity-${e.id}`}>
                  <TableCell className="text-white/60 text-xs">{e.occurredAt.slice(0, 19).replace("T", " ")}</TableCell>
                  <TableCell className={cellCls}>{e.contactName || e.contactEmail}</TableCell>
                  <TableCell className={cellCls}>{e.eventType}</TableCell>
                  <TableCell className="text-white/70 text-sm">{e.eventDetail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {selectedId !== null && (
        <BatchDetail id={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />
      )}
    </div>
  );
}

function BatchDetail({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ProspectBatchDetail | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await adminApi.getProspectBatch(id));
    } catch {
      setDetail(null);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    try {
      if (action === "approve") await adminApi.approveProspectBatch(id);
      else await adminApi.rejectProspectBatch(id);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const search = detail?.search;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={onClose}
      data-testid="batch-detail-overlay"
    >
      <div
        className="w-full max-w-2xl h-full overflow-auto p-6 border-l border-white/10"
        style={{ backgroundColor: NAVY }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">
              {search ? `${search.segment} · ${search.geography}` : "Batch"}
            </h2>
            {search && (
              <p className="text-white/60 text-sm">
                {search.resultsCount} companies · run {search.runAt.slice(0, 10)} ·{" "}
                <span style={{ color: batchStatusColor(search.status) }}>{search.status.replace(/_/g, " ")}</span>
              </p>
            )}
          </div>
          <button onClick={onClose} data-testid="button-close-batch" className="text-white/60 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {search?.status === "pending_review" && (
          <div className="mt-4 flex gap-2">
            <Button
              disabled={busy}
              onClick={() => decide("approve")}
              data-testid="button-approve-batch-detail"
              style={{ backgroundColor: ORANGE, color: "white" }}
            >
              Approve batch
            </Button>
            <Button disabled={busy} variant="outline" onClick={() => decide("reject")} data-testid="button-reject-batch-detail">
              Reject batch
            </Button>
          </div>
        )}

        {!detail && <p className="mt-6 text-white/50 text-sm">Loading…</p>}

        <div className="mt-6 space-y-4">
          {detail?.companies.map((co) => (
            <div key={co.id} className="rounded-lg border border-white/10 p-4" data-testid={`company-${co.id}`}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-white font-semibold">{co.name}</p>
                  <p className="text-white/50 text-xs">
                    {[co.city, co.state].filter(Boolean).join(", ")}
                    {co.domain ? ` · ${co.domain}` : ""}
                    {co.employeeCount ? ` · ${co.employeeCount} employees` : ""}
                  </p>
                </div>
                <Tag label={`${co.signalType}`} />
              </div>
              <p className="text-white/60 text-sm mt-1">{co.signalDetail}</p>

              <div className="mt-3 space-y-3">
                {co.contacts.map((c) => {
                  const first = c.outreach.find((o) => o.sequenceStep === 1) ?? c.outreach[0];
                  const isOpen = expanded[c.id];
                  return (
                    <div key={c.id} className="border-l-2 border-white/15 pl-3" data-testid={`prospect-contact-${c.id}`}>
                      <p className="text-white/90 text-sm font-medium">
                        {c.fullName} <span className="text-white/50 font-normal">· {c.title}</span>
                      </p>
                      <p className="text-white/50 text-xs">{c.email}</p>
                      {first && (
                        <div className="mt-2">
                          <button
                            onClick={() => setExpanded((e) => ({ ...e, [c.id]: !e[c.id] }))}
                            data-testid={`toggle-email-${c.id}`}
                            className="text-xs font-semibold"
                            style={{ color: ORANGE }}
                          >
                            {isOpen ? "Hide" : "Show"} drafted email · {first.status}
                          </button>
                          {isOpen && (
                            <div className="mt-2 rounded bg-white/5 border border-white/10 p-3">
                              <p className="text-white/80 text-xs font-semibold">{first.emailSubject}</p>
                              <p className="text-white/70 text-xs whitespace-pre-wrap mt-1">{first.emailBody}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SalesTable({ rows, onChanged }: { rows: any[]; onChanged?: () => void }) {
  const [activatingId, setActivatingId] = useState<number | null>(null);

  const activate = async (id: number) => {
    setActivatingId(id);
    try {
      await adminApi.activateOffice(id);
      onChanged?.();
    } catch {
      // Leave the row as-is; a failed activation surfaces via the unchanged
      // pending state so the admin can retry.
    } finally {
      setActivatingId(null);
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent border-white/10">
          <TableHead className={headCls}>Office</TableHead>
          <TableHead className={headCls}>Status</TableHead>
          <TableHead className={headCls}>Provisioning</TableHead>
          <TableHead className={headCls}>Seats</TableHead>
          <TableHead className={headCls}>Seat MRR</TableHead>
          <TableHead className={headCls}>Manager MRR</TableHead>
          <TableHead className={headCls}>MRR</TableHead>
          <TableHead className={headCls}>Academy Credits</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow span={8} />}
        {rows.map((r) => (
          <TableRow key={r.officeId} className="border-white/10" data-testid={`row-sales-${r.officeId}`}>
            <TableCell className={cellCls}>{r.officeName}</TableCell>
            <TableCell className={cellCls}>{r.subscriptionStatus}</TableCell>
            <TableCell className={cellCls}>
              {r.status === "pending" ? (
                <Button
                  size="sm"
                  onClick={() => activate(r.officeId)}
                  disabled={activatingId === r.officeId}
                  style={{ backgroundColor: ORANGE, color: "white" }}
                  data-testid={`button-activate-${r.officeId}`}
                >
                  {activatingId === r.officeId ? "Activating…" : "Activate office"}
                </Button>
              ) : (
                <Tag label="active" />
              )}
            </TableCell>
            <TableCell className={cellCls}>{r.seatCount}</TableCell>
            <TableCell className={cellCls}>${r.seatsMrr}</TableCell>
            <TableCell className={cellCls}>${r.managerMrr}</TableCell>
            <TableCell className="text-white font-semibold">${r.mrr}</TableCell>
            <TableCell className={cellCls} data-testid={`cell-academy-credits-${r.officeId}`}>
              {r.academyCreditDisplay ?? "$0"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PaidSignupsTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent border-white/10">
          <TableHead className={headCls}>Office</TableHead>
          <TableHead className={headCls}>Seats</TableHead>
          <TableHead className={headCls}>Dashboard</TableHead>
          <TableHead className={headCls}>Stripe Subscription</TableHead>
          <TableHead className={headCls}>Buyer Email</TableHead>
          <TableHead className={headCls}>Signed Up</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow span={6} />}
        {rows.map((r) => (
          <TableRow key={r.id} className="border-white/10" data-testid={`row-paid-signup-${r.id}`}>
            <TableCell className={cellCls}>{r.officeName}</TableCell>
            <TableCell className={cellCls}>{r.seatCount}</TableCell>
            <TableCell className={cellCls}>{r.dashboard}</TableCell>
            <TableCell className="text-white/60 font-mono text-xs">{r.stripeSubscriptionId || "-"}</TableCell>
            <TableCell className={cellCls}>{r.contactEmail || "-"}</TableCell>
            <TableCell className="text-white/60 text-xs">{r.createdAt}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
