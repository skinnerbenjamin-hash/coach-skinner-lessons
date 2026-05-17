// React hook that fetches the active tenant's branding + labels from
// /api/_tenant.  Cached forever — the tenant doesn't change within a session.
//
// Usage:
//   const { data: tenant } = useTenant();
//   tenant?.bookerLabel   // "Parent" (or whatever the coach set)
//   tenant?.attendeeLabel // "Player"
//   tenant?.name          // tenant business name (e.g. "Coach Skinner")
//   tenant?.primaryColor  // "#0ea5e9"
//
// If for any reason the tenant cannot be resolved (unknown subdomain), data
// is null and components should render their default labels.
import { useQuery } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export interface Tenant {
  host: string;
  tenantId: number | null;
  slug: string | null;
  name: string | null;
  sport: string | null;
  primaryColor: string | null;
  logoPath: string | null;
  heroPath: string | null;
  tagline: string | null;
  about: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactLocation: string | null;
  bookerLabel: string | null;
  attendeeLabel: string | null;
}

export function useTenant() {
  return useQuery<Tenant>({
    queryKey: ["/api/_tenant"],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/_tenant`, { credentials: "include" });
      if (!r.ok) throw new Error("tenant lookup failed");
      return r.json();
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * Convenience helper — returns booker/attendee labels with sensible defaults
 * if the tenant query hasn't loaded yet.  Always returns concrete strings so
 * components don't need to handle null.
 */
export function useTenantLabels(): { booker: string; attendee: string } {
  const { data } = useTenant();
  return {
    booker: data?.bookerLabel || "Parent",
    attendee: data?.attendeeLabel || "Player",
  };
}
