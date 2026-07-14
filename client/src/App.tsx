import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Register from "@/pages/register";
import Scenarios from "@/pages/scenarios";
import RolePlay from "@/pages/roleplay";
import Results from "@/pages/results";
import Dashboard from "@/pages/dashboard";
import Certification from "@/pages/certification";
import AdminLogin from "@/pages/admin-login";
import AdminDashboard from "@/pages/admin-dashboard";
import Demo from "@/pages/demo";
import DemoDashboard from "@/pages/dashboard-demo";
import { AuthProvider, useAuth } from "@/lib/auth";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Redirect to="/" />;
  return <>{children}</>;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Login} />
      <Route path="/register" component={Register} />
      {/* Public free voice demo: no auth. The email+code verification and a
          signed demo token gate it server-side, so it stays outside RequireAuth
          and never touches the trainee/admin login flows. */}
      <Route path="/demo" component={Demo} />
      {/* Public, read-only demo of the manager dashboard: no auth, seeded
          sample data only. Served by the no-auth GET /api/public/demo-dashboard
          endpoint; intentionally outside RequireAuth and with no path into the
          authenticated app. */}
      <Route path="/dashboard-demo" component={DemoDashboard} />
      <Route path="/scenarios">
        <RequireAuth>
          <Scenarios />
        </RequireAuth>
      </Route>
      <Route path="/roleplay/:id">
        <RequireAuth>
          <RolePlay />
        </RequireAuth>
      </Route>
      <Route path="/results/:id">
        <RequireAuth>
          <Results />
        </RequireAuth>
      </Route>
      <Route path="/dashboard">
        <RequireAuth>
          <Dashboard />
        </RequireAuth>
      </Route>
      <Route path="/certification">
        <RequireAuth>
          <Certification />
        </RequireAuth>
      </Route>
      {/* Admin area: unlisted, its own server-side session (solve_admin_session
          cookie). Not wrapped in RequireAuth — the office-scoped user session is
          unrelated; each admin page verifies the admin cookie via /api/admin/me. */}
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/opportunities" component={AdminDashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
