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
import { adminApi, type AdminSection } from "@/lib/adminApi";
import { Download, LogOut, Users, FileText, Eye, DollarSign } from "lucide-react";

const NAVY = "#0A1A30";
const NAVY_DARK = "#05162D";
const ORANGE = "#E06D00";

const SECTIONS: { key: AdminSection; label: string; icon: any }[] = [
  { key: "visitors", label: "Visitors", icon: Eye },
  { key: "leads", label: "Leads", icon: FileText },
  { key: "users", label: "All Users", icon: Users },
  { key: "sales", label: "Sales", icon: DollarSign },
];

export default function AdminDashboard() {
  const [, navigate] = useLocation();
  const [authChecked, setAuthChecked] = useState(false);
  const [section, setSection] = useState<AdminSection>("visitors");

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
      {/* Sidebar */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-white/10" style={{ backgroundColor: NAVY }}>
        <div className="px-5 py-5 border-b border-white/10">
          <p className="text-white font-bold text-lg">Solve Admin</p>
          <p className="text-white/50 text-xs">Internal console</p>
        </div>
        <nav className="flex-1 py-3">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.key;
            return (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                data-testid={`nav-${s.key}`}
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
      <main className="flex-1 overflow-auto p-6">
        <SectionView key={section} section={section} />
      </main>
    </div>
  );
}

function SectionView({ section }: { section: AdminSection }) {
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          {section === "sales" && data && (
            <p className="text-white/60 text-sm mt-1" data-testid="text-sales-summary">
              {data.activeOffices} active office(s) · Total MRR ${data.totalMrr}
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
            {section === "leads" && <LeadsTable rows={data.rows} onChanged={load} />}
            {section === "users" && <UsersTable rows={data.rows} />}
            {section === "sales" && <SalesTable rows={data.rows} />}
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
            <TableCell className={cellCls}>{r.referrer || "—"}</TableCell>
            <TableCell className="text-white/50 font-mono text-xs">{(r.visitorToken || "").slice(0, 12)}</TableCell>
            <TableCell className="text-white/60 text-xs">{r.createdAt}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LeadsTable({ rows, onChanged }: { rows: any[]; onChanged: () => void }) {
  async function change(id: number, status: string) {
    await adminApi.updateLeadStatus(id, status);
    onChanged();
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent border-white/10">
          <TableHead className={headCls}>Name</TableHead>
          <TableHead className={headCls}>Email</TableHead>
          <TableHead className={headCls}>Company</TableHead>
          <TableHead className={headCls}>Message</TableHead>
          <TableHead className={headCls}>Source</TableHead>
          <TableHead className={headCls}>Status</TableHead>
          <TableHead className={headCls}>Submitted</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow span={7} />}
        {rows.map((r) => (
          <TableRow key={r.id} className="border-white/10" data-testid={`row-lead-${r.id}`}>
            <TableCell className={cellCls}>{r.name}</TableCell>
            <TableCell className={cellCls}>{r.email}</TableCell>
            <TableCell className={cellCls}>{r.company || "—"}</TableCell>
            <TableCell className="text-white/80 max-w-xs truncate" title={r.message}>{r.message || "—"}</TableCell>
            <TableCell className="text-white/60 text-xs">{r.source || "—"}</TableCell>
            <TableCell>
              <select
                value={r.status}
                onChange={(e) => change(r.id, e.target.value)}
                data-testid={`select-lead-status-${r.id}`}
                className="bg-white/10 text-white text-sm rounded px-2 py-1 border border-white/20"
              >
                <option value="new">new</option>
                <option value="contacted">contacted</option>
                <option value="converted">converted</option>
              </select>
            </TableCell>
            <TableCell className="text-white/60 text-xs">{r.createdAt}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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

function SalesTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent border-white/10">
          <TableHead className={headCls}>Office</TableHead>
          <TableHead className={headCls}>Status</TableHead>
          <TableHead className={headCls}>Seats</TableHead>
          <TableHead className={headCls}>Seat MRR</TableHead>
          <TableHead className={headCls}>Manager MRR</TableHead>
          <TableHead className={headCls}>MRR</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <EmptyRow span={6} />}
        {rows.map((r) => (
          <TableRow key={r.officeId} className="border-white/10" data-testid={`row-sales-${r.officeId}`}>
            <TableCell className={cellCls}>{r.officeName}</TableCell>
            <TableCell className={cellCls}>{r.subscriptionStatus}</TableCell>
            <TableCell className={cellCls}>{r.seatCount}</TableCell>
            <TableCell className={cellCls}>${r.seatsMrr}</TableCell>
            <TableCell className={cellCls}>${r.managerMrr}</TableCell>
            <TableCell className="text-white font-semibold">${r.mrr}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
