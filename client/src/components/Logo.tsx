import { useTenant } from "@/hooks/use-tenant";

export function Logo({ className = "" }: { className?: string }) {
  const { data: tenant, isLoading } = useTenant();
  // Generic fallback — used when the tenant query is still loading OR when the
  // request hit a subdomain that doesn't map to any tenant.  We deliberately
  // do NOT fall back to any one coach's name; that would leak Skinner's brand
  // onto every unresolved subdomain like "foobar.lessonspot.app".
  const resolved = !!tenant?.tenantId;
  const name = resolved ? tenant!.name! : "LessonSpot";
  const suffix = resolved ? "· Lessons" : "";
  // If the tenant uploaded a logo, prefer it.  Falls back to the inline SVG
  // mark (good default for trial signups before they upload).
  const logoPath = resolved ? (tenant!.logoPath || null) : null;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {logoPath ? (
        <img
          src={logoPath}
          alt={`${name} logo`}
          className="h-7 w-7 object-contain"
        />
      ) : (
        <svg
          viewBox="0 0 32 32"
          aria-label={`${name} logo`}
          fill="none"
          className="h-7 w-7 text-primary"
        >
          <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" />
          <path
            d="M5 10 Q 16 16 5 22"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
          <path
            d="M27 10 Q 16 16 27 22"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
        </svg>
      )}
      <span className="font-bold tracking-tight text-base">
        {name}
        {suffix && (
          <span className="text-muted-foreground font-medium ml-1">{suffix}</span>
        )}
      </span>
    </span>
  );
}
