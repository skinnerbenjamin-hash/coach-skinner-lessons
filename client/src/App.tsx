import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Book from "@/pages/Book";
import MyAppointments from "@/pages/MyAppointments";
import Admin from "@/pages/Admin";
import ResetPassword from "@/pages/ResetPassword";
import Resources from "@/pages/Resources";
import Signup from "@/pages/Signup";
import Demo from "@/pages/Demo";
import SiteNotFound from "@/pages/SiteNotFound";
import { Header } from "@/components/Header";
import { TenantTheme } from "@/components/TenantTheme";
import { useTenant } from "@/hooks/use-tenant";

// Apex flag injected by the server (see server/static.ts).  When true, the
// host is lessonspot.app or www.lessonspot.app and we render the marketing
// landing instead of the tenant booking page.
const IS_APEX = typeof window !== "undefined" && (window as any).__APEX__ === true;

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// If the URL has ?login=TOKEN (signup hands off across subdomains), POST the
// token to /api/auth/handoff so we end up with a session cookie on THIS host.
// Runs once, then strips the query string from the URL so a refresh won't
// re-fire.  Failures are silent: the user can still log in normally.
function useLoginHandoff() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("login");
    if (!token) return;
    (async () => {
      try {
        await fetch(`${API_BASE}/api/auth/handoff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token }),
        });
      } catch { /* ignore */ }
      // Strip ?login=... but keep the hash so we stay on /#/admin.
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, "", cleanUrl);
      // Force a reload so the Admin page picks up the new auth state.
      window.location.reload();
    })();
  }, []);
}

function AppRouter() {
  useLoginHandoff();

  // On the apex host we serve the demo-video landing as the entire marketing
  // experience. /signup is the one app route allowed through so people can
  // sign up directly from lessonspot.app/#/signup; everything else (including
  // legacy /demo links) falls through to the same Demo landing page.
  if (IS_APEX) {
    return (
      <div className="min-h-screen bg-background">
        <Switch>
          <Route path="/signup" component={Signup} />
          <Route component={Demo} />
        </Switch>
      </div>
    );
  }
  // On a subdomain (non-apex) we need the tenant to resolve before rendering
  // tenant-scoped pages like Book/Resources/MyAppointments.  If the subdomain
  // doesn't map to any tenant, show a friendly "site not found" page instead
  // of Book.tsx -- which used to render Skinner-branded fallbacks (the source
  // of the "why does biblab show my data" confusion).
  //
  // The `/signup` route is always allowed through (so people can sign up from
  // any subdomain in dev) and `/admin` is too (admins of unresolved subdomains
  // shouldn't be locked out, though in practice they won't see anything).
  const { data: tenant, isLoading: tenantLoading } = useTenant();
  const tenantResolved = !!tenant?.tenantId;
  return (
    <div className="min-h-screen bg-background">
      <TenantTheme />
      <Header />
      <Switch>
        <Route path="/signup" component={Signup} />
        <Route path="/admin" component={Admin} />
        <Route path="/reset" component={ResetPassword} />
        <Route path="/">
          {tenantResolved ? <Book /> : tenantLoading ? <LoadingScreen /> : <SiteNotFound host={tenant?.host} />}
        </Route>
        <Route path="/my-appointments">
          {tenantResolved ? <MyAppointments /> : tenantLoading ? <LoadingScreen /> : <SiteNotFound host={tenant?.host} />}
        </Route>
        <Route path="/resources">
          {tenantResolved ? <Resources /> : tenantLoading ? <LoadingScreen /> : <SiteNotFound host={tenant?.host} />}
        </Route>
        <Route>
          {tenantResolved ? <NotFound /> : tenantLoading ? <LoadingScreen /> : <SiteNotFound host={tenant?.host} />}
        </Route>
      </Switch>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="container mx-auto max-w-xl px-4 py-16 text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
