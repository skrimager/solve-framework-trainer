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
