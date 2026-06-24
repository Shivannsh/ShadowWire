import { ReactNode } from "react";

type StepStatus = "pending" | "active" | "done" | "error";

const statusStyles: Record<StepStatus, string> = {
  pending: "border-surface-border text-slate-500",
  active: "border-accent text-accent shadow-glow",
  done: "border-shield text-shield",
  error: "border-red-500 text-red-400",
};

export function FlowStep({
  step,
  title,
  description,
  status = "pending",
  children,
}: {
  step: number;
  title: string;
  description: string;
  status?: StepStatus;
  children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border bg-surface-raised/60 p-6 transition ${statusStyles[status]}`}
    >
      <div className="mb-4 flex items-start gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${statusStyles[status]}`}
        >
          {status === "done" ? "✓" : step}
        </div>
        <div>
          <h3 className="text-lg font-medium text-slate-100">{title}</h3>
          <p className="mt-1 text-sm text-slate-400">{description}</p>
        </div>
      </div>
      {children && <div className="mt-4 border-t border-surface-border/60 pt-4">{children}</div>}
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
  const colors = {
    idle: "text-slate-500",
    loading: "text-accent",
    success: "text-shield",
    error: "text-red-400",
  };

  return (
    <div className={`rounded-lg bg-surface px-4 py-3 font-mono text-xs ${colors[status]}`}>
      {message ?? (status === "idle" ? "Ready" : status)}
    </div>
  );
}
