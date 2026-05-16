// Applies the active tenant's brand color to the page by overriding the
// --primary CSS variable on document.documentElement.  Runs once when the
// tenant query loads.
//
// The whole app uses `bg-primary`, `text-primary`, `border-primary` etc., so
// changing --primary cascades to every primary-colored element without
// touching components.  Other tokens (--ring, --primary-foreground, etc.) are
// derived from --primary in index.css so they update automatically.
//
// The tenant color is stored as a hex string ("#0ea5e9").  Tailwind expects
// HSL space-separated triplet ("198 89% 48%") so we convert in the browser.
import { useEffect } from "react";
import { useTenant } from "@/hooks/use-tenant";

function hexToHslTriplet(hex: string): string | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h6 = m[1];
  if (h6.length === 3) h6 = h6.split("").map(c => c + c).join("");
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d) + (g < b ? 6 : 0); break;
      case g: h = ((b - r) / d) + 2; break;
      case b: h = ((r - g) / d) + 4; break;
    }
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function TenantTheme() {
  const { data: tenant } = useTenant();
  useEffect(() => {
    if (!tenant?.primaryColor) return;
    const triplet = hexToHslTriplet(tenant.primaryColor);
    if (!triplet) return;
    const root = document.documentElement;
    root.style.setProperty("--primary", triplet);
    // --ring inherits from --primary in our index.css, but Tailwind builds
    // a separate --ring value at startup — override it too so focus rings
    // pick up the tenant color.
    root.style.setProperty("--ring", triplet);
  }, [tenant?.primaryColor]);

  useEffect(() => {
    if (!tenant?.name) return;
    document.title = `${tenant.name} \u2014 Book a session`;
  }, [tenant?.name]);

  return null;
}
