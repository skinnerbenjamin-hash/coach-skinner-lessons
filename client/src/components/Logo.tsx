import { useTenant } from "@/hooks/use-tenant";

export function Logo({ className = "" }: { className?: string }) {
  const { data: tenant } = useTenant();
  const name = tenant?.name || "Coach Skinner";
  // If the tenant uploaded a logo, prefer it.  Falls back to the inline SVG
  // mark (good default for trial signups before they upload).
  const logoPath = tenant?.logoPath || null;
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
        {name} <span className="text-muted-foreground font-medium">· Lessons</span>
      </span>
    </span>
  );
}
