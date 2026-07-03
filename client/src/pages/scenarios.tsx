import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import type { Scenario } from "@shared/schema";

const VERTICAL_LABELS: Record<string, string> = {
  manufactured_housing_community: "Manufactured housing community",
  manufactured_housing: "Manufactured housing dealer",
  real_estate: "Real estate purchase / listing",
  apartment_rental: "Apartment rental",
  auto_sales: "Auto sales",
  hvac_service: "HVAC service call",
  hvac_sales: "HVAC new system sales call",
  plumbing: "Plumbing service call",
  financial_advisor: "Financial advisor",
  insurance_auto: "Insurance",
};

// Order verticals should appear in on the picker — top scenarios first per owner priority
const VERTICAL_ORDER = [
  "manufactured_housing_community",
  "manufactured_housing",
  "real_estate",
  "apartment_rental",
  "hvac_sales",
  "hvac_service",
  "financial_advisor",
  "insurance_auto",
  "auto_sales",
  "plumbing",
];

export default function Scenarios() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  const { data: scenarios, isLoading } = useQuery<Scenario[]>({
    queryKey: ["/api/scenarios"],
  });

  const startSession = useMutation({
    mutationFn: async (scenarioId: number) => {
      const res = await apiRequest("POST", "/api/sessions", { userId: user!.id, scenarioId });
      return res.json();
    },
    onSuccess: (session) => {
      navigate(`/roleplay/${session.id}`);
    },
  });

  // Group scenarios by vertical so the picker shows one card per scenario type
  // (e.g. "HVAC service call") rather than per persona. The specific customer
  // persona is chosen at random when the consultant starts — revealing the title
  // or persona ahead of time would give away exactly what discovery is supposed
  // to uncover.
  const verticalGroups = new Map<string, Scenario[]>();
  for (const s of scenarios ?? []) {
    const list = verticalGroups.get(s.vertical) ?? [];
    list.push(s);
    verticalGroups.set(s.vertical, list);
  }
  const orderedVerticals = [
    ...VERTICAL_ORDER.filter((v) => verticalGroups.has(v)),
    ...Array.from(verticalGroups.keys()).filter((v) => !VERTICAL_ORDER.includes(v)),
  ];

  const handleStart = (vertical: string) => {
    const pool = verticalGroups.get(vertical) ?? [];
    if (pool.length === 0) return;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    startSession.mutate(picked.id);
  };

  return (
    <AppShell title="Discovery scenarios">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground max-w-prose" data-testid="text-scenarios-intro">
          Pick a scenario and start the conversation cold — no preview. Your goal isn't to close
          fast, it's to uncover the real need behind whatever the customer opens with.
        </p>
        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-40 rounded-lg" />
            <Skeleton className="h-40 rounded-lg" />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {orderedVerticals.map((vertical) => {
            const pool = verticalGroups.get(vertical) ?? [];
            const difficulties = Array.from(new Set(pool.map((s) => s.difficulty)));
            return (
              <Card key={vertical} data-testid={`card-vertical-${vertical}`}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-lg">{VERTICAL_LABELS[vertical] ?? vertical}</CardTitle>
                  </div>
                  <CardDescription className="flex flex-wrap gap-1.5 pt-1">
                    {difficulties.map((d) => (
                      <Badge key={d} variant="secondary" data-testid={`badge-difficulty-${vertical}-${d}`}>
                        {d}
                      </Badge>
                    ))}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={() => handleStart(vertical)}
                    disabled={startSession.isPending}
                    data-testid={`button-start-${vertical}`}
                  >
                    {startSession.isPending ? "Starting..." : "Start discovery session"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
        {!isLoading && scenarios?.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-scenarios">
            No scenarios available yet.
          </p>
        )}
      </div>
    </AppShell>
  );
}
