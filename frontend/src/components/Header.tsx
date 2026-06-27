"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { Wordmark } from "./ui/Logo";

const nav = [
  { href: "/", label: "Overview" },
  { href: "/alice", label: "Buyer" },
  { href: "/bob", label: "Seller" },
];

export function Header() {
  const pathname = usePathname();

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 px-4">
      <header className="pointer-events-auto mx-auto flex max-w-5xl items-center justify-between gap-4 rounded-2xl border border-surface-border bg-ink-900/70 px-3 py-2.5 shadow-nav backdrop-blur-xl">
        <div className="pl-1.5">
          <Wordmark />
        </div>

        <nav className="hidden items-center gap-1 md:flex">
          {nav.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-surface-strong text-fg"
                    : "text-fg-muted hover:bg-surface-raised hover:text-fg"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <ConnectButton />
      </header>
    </div>
  );
}
