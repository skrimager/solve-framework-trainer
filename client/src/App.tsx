import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "@/lib/hashLocation";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Login from "@/pages/login";
import ManagerLogin from "@/pages/manager-login";
import Register from "@/pages/register";
import Signup from "@/pages/signup";
import Scenarios from "@/pages/scenarios";
import RolePlay from "@/pages/roleplay";
import Results from "@/pages/results";
import RealConversations from "@/pages/real-conversations";
import Dashboard from "@/pages/dashboard";
import Certification from "@/pages/certification";
import AdminLogin from "@/pages/admin-login";
import AdminDashboard from "@/pages/admin-dashboard";
import Demo from "@/pages/demo";
import DemoDashboard from "@/pages/dashboard-demo";
import OfficeSetup, { OfficeSetupComplete } from "@/pages/office-setup";
import { AuthProvider, useAuth } from "@/lib/auth";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Redirect to="/" />;
  return <>{children}</>;
}

// The manager command center is one route that shows the manager login when
// signed out and the dashboard once a manager is signed in, so "/command-center"
// serves both faces of the manager experience and "/dashboard" can safely
// redirect here without a redirect loop. A consultant who lands here is bounced
// to their own practice area.
function CommandCenter() {
  const { user } = useAuth();
  if (!user) return <ManagerLogin />;
  if (user.role === "consultant") return <Redirect to="/scenarios" />;
  return <Dashboard />;
}

function AppRouter() {
  return (
    <Switch>
      {/* Root chooser: one tap to the consultant practice login, the manager
          command center, or the free demo. */}
      <Route path="/" component={Home} />
      {/* Consultant practice login (dark orange theme). */}
      <Route path="/practice" component={Login} />
      {/* Manager command center: distinct light login when signed out, dashboard
          when signed in. Rendered by a different component from the consultant
          login so browser password managers treat the two as separate contexts. */}
      <Route path="/command-center" component={CommandCenter} />
      <Route path="/register" component={Register} />
      {/* Self-serve manager signup: email capture, verify, office setup, then
          Stripe checkout. Payment is the sole activation trigger. Public, no auth. */}
      <Route path="/signup" component={Signup} />
      {/* Public free voice demo: no auth. The email+code verification and a
          signed demo token gate it server-side, so it stays outside RequireAuth
          and never touches the trainee/admin login flows. */}
      <Route path="/demo" component={Demo} />
      {/* Public, read-only demo of the manager dashboard: no auth, seeded
          sample data only. Served by the no-auth GET /api/public/demo-dashboard
          endpoint; intentionally outside RequireAuth and with no path into the
          authenticated app. */}
      <Route path="/dashboard-demo" component={DemoDashboard} />
      {/* Self-serve office setup from the welcome-email link: public, no auth. The
          completion route must precede the token route so ":token" does not swallow
          "complete". */}
      <Route path="/office-setup/complete" component={OfficeSetupComplete} />
      <Route path="/office-setup/:token" component={OfficeSetup} />
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
      {/* Certification path view: levels, progress, credentials. */}
      <Route path="/academy">
        <RequireAuth>
          <Certification />
        </RequireAuth>
      </Route>
      <Route path="/real-conversations">
        <RequireAuth>
          <RealConversations />
        </RequireAuth>
      </Route>
      {/* Admin area: unlisted, its own server-side session (solve_admin_session
          cookie). Not wrapped in RequireAuth — the office-scoped user session is
          unrelated; each admin page verifies the admin cookie via /api/admin/me. */}
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/opportunities" component={AdminDashboard} />
      {/* Backward-compatible aliases so old bookmarks and email links keep
          working. "/dashboard" points at the command center (which shows the
          dashboard once signed in), covering pre-rename manager links. */}
      <Route path="/login"><Redirect to="/practice" /></Route>
      <Route path="/manager-login"><Redirect to="/command-center" /></Route>
      <Route path="/dashboard"><Redirect to="/command-center" /></Route>
      <Route path="/certification"><Redirect to="/academy" /></Route>
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
