export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        viewBox="0 0 32 32"
        aria-label="Coach Skinner Lessons logo"
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
      <span className="font-bold tracking-tight text-base">
        Coach Skinner <span className="text-muted-foreground font-medium">· Lessons</span>
      </span>
    </span>
  );
}
