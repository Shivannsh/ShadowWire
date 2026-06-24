import Link from "next/link";
import { ConnectButton } from "./ConnectButton";

const nav = [
  { href: "/", label: "Overview" },
  { href: "/alice", label: "Alice (Send)" },
  { href: "/bob", label: "Bob (Receive)" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-surface-border/80 bg-surface/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            ◈
          </span>
          <span className="text-lg font-semibold tracking-tight">
            Shadow<span className="text-accent">Wire</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm text-slate-400 transition hover:text-accent"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <ConnectButton />
      </div>
    </header>
  );
}
