import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Book from "@/pages/Book";
import MyAppointments from "@/pages/MyAppointments";
import Admin from "@/pages/Admin";
import Resources from "@/pages/Resources";
import Signup from "@/pages/Signup";
import Marketing from "@/pages/Marketing";
import { Header } from "@/components/Header";
import { TenantTheme } from "@/components/TenantTheme";

// Apex flag injected by the server (see server/static.ts).  When true, the
// host is lessonspot.app or www.lessonspot.app and we render the marketing
// landing instead of the tenant booking page.
const IS_APEX = typeof window !== "undefined" && (window as any).__APEX__ === true;

function AppRouter() {
  // On the apex host we serve a marketing-only experience.  /signup is the
  // one app route allowed through so people can sign up directly from
  // lessonspot.app/#/signup; everything else routes to the marketing landing.
  if (IS_APEX) {
    return (
      <div className="min-h-screen bg-background">
        <Switch>
          <Route path="/signup" component={Signup} />
          <Route component={Marketing} />
        </Switch>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-background">
      <TenantTheme />
      <Header />
      <Switch>
        <Route path="/" component={Book} />
        <Route path="/my-appointments" component={MyAppointments} />
        <Route path="/resources" component={Resources} />
        <Route path="/admin" component={Admin} />
        <Route path="/signup" component={Signup} />
        <Route component={NotFound} />
      </Switch>
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
