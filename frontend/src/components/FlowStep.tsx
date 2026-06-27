import { ReactNode } from "react";
import { CheckIcon, SpinnerIcon } from "./ui/icons";

type StepStatus = "pending" | "active" | "done" | "error";

const nodeStyles: Record<StepStatus, string> = {
  pending: "border-surface-border bg-surface text-fg-faint",
  active:
    "border-accent/60 bg-accent/10 text-accent shadow-[0_0_0_4px_rgba(91,200,236,0.12)]",
  done: "border-shield/50 bg-shield/10 text-shield",
  error: "border-danger/50 bg-danger/10 text-danger",
};

const cardStyles: Record<StepStatus, string> = {
  pending: "opacity-60",
  active: "border-accent/30",
  done: "",
  error: "border-danger/30",
};

export function FlowStep({
  step,
  title,
  description,
  status = "pending",
  last = false,
  children,
}: {
  step: number;
  title: string;
  description: string;
  status?: StepStatus;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="relative grid grid-cols-[40px_1fr] gap-x-4">
      {/* Rail + node */}
      <div className="relative flex flex-col items-center">
        <div
          className={`z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-all duration-300 ${nodeStyles[status]}`}
        >
          {status === "done" ? (
            <CheckIcon size={18} />
          ) : status === "active" ? (
            <span className="num">{step}</span>
          ) : (
            <span className="num">{step}</span>
          )}
        </div>
        {!last && (
          <div
            className={`w-px flex-1 ${
              status === "done" ? "bg-shield/35" : "bg-surface-border"
            }`}
          />
        )}
      </div>

      {/* Body */}
      <div className={`panel panel-hover mb-5 p-5 ${cardStyles[status]}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-fg">
              {title}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">
              {description}
            </p>
          </div>
          {status === "active" && (
            <span className="num shrink-0 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">
              Now
            </span>
          )}
        </div>
        {children && (
          <div className="mt-4 border-t border-surface-border pt-4">{children}</div>
        )}
      </div>
    </div>
  );
}

export function StatusBadge({
  status,
  message,
}: {
  status: "idle" | "loading" | "success" | "error";
  message?: string;
}) {
  const config = {
    idle: { color: "text-fg-muted", dot: "bg-fg-faint", border: "border-surface-border" },
    loading: { color: "text-accent", dot: "bg-accent", border: "border-accent/30" },
    success: { color: "text-shield", dot: "bg-shield", border: "border-shield/30" },
    error: { color: "text-danger", dot: "bg-danger", border: "border-danger/30" },
  }[status];

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border bg-ink-850/60 px-4 py-3 ${config.border}`}
    >
      {status === "loading" ? (
        <SpinnerIcon size={15} className={config.color} />
      ) : (
        <span className={`h-2 w-2 shrink-0 rounded-full ${config.dot}`} />
      )}
      <span className={`num text-xs leading-relaxed ${config.color}`}>
        {message ?? (status === "idle" ? "Ready" : status)}
      </span>
    </div>
  );
}
