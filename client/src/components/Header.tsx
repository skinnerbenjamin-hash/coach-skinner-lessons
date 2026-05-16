import { Link, useLocation } from "wouter";
import { Logo } from "./Logo";
import { cn } from "@/lib/utils";

export function Header() {
  const [loc] = useLocation();
  const linkCls = (href: string) =>
    cn(
      "px-2 sm:px-3 py-2 rounded-md text-xs sm:text-sm font-medium hover-elevate whitespace-nowrap",
      loc === href ? "text-foreground" : "text-muted-foreground",
    );
  return (
    <header className="border-b bg-card">
      <div className="mx-auto max-w-6xl px-3 sm:px-6 py-3 flex items-center justify-between gap-2">
        <Link href="/" data-testid="link-home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-0.5 sm:gap-1">
          <Link href="/" className={linkCls("/")} data-testid="link-nav-book">
            Book
          </Link>
          <Link
            href="/my-appointments"
            className={linkCls("/my-appointments")}
            data-testid="link-nav-my-appointments"
          >
            <span className="sm:hidden">My visits</span>
            <span className="hidden sm:inline">My appointments</span>
          </Link>
          <Link href="/resources" className={linkCls("/resources")} data-testid="link-nav-resources">
            Resources
          </Link>
          <Link href="/admin" className={linkCls("/admin")} data-testid="link-nav-admin">
            Admin
          </Link>
        </nav>
      </div>
    </header>
  );
}
