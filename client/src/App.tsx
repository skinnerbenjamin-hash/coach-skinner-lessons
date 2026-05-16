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
import { Header } from "@/components/Header";
import { TenantTheme } from "@/components/TenantTheme";

function AppRouter() {
  return (
    <div className="min-h-screen bg-background">
      <TenantTheme />
      <Header />
      <Switch>
        <Route path="/" component={Book} />
        <Route path="/my-appointments" component={MyAppointments} />
        <Route path="/resources" component={Resources} />
        <Route path="/admin" component={Admin} />
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
