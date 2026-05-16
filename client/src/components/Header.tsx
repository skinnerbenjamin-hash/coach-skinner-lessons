import { Link, useLocation } from "wouter";
import { Logo } from "./Logo";
import { cn } from "@/lib/utils";

export function Header() {
  const [loc] = useLocation();
  const linkCls = (href: string) =>
    cn(
      "px-3 py-2 rounded-md text-sm font-medium hover-elevate",
      loc === href ? "text-foreground" : "text-muted-foreground",
    );
  return (
    <header className="border-b bg-card">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between">
        <Link href="/" data-testid="link-home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1">
          <Link href="/" className={linkCls("/")} data-testid="link-nav-book">
            Book
          </Link>
          <Link
            href="/my-appointments"
            className={linkCls("/my-appointments")}
            data-testid="link-nav-my-appointments"
          >
            My appointments
          </Link>
          <Link href="/admin" className={linkCls("/admin")} data-testid="link-nav-admin">
            Admin
          </Link>
        </nav>
      </div>
    </header>
  );
}
