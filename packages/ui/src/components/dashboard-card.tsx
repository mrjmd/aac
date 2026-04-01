import { cn } from "../lib/utils.js";
import { type StatusLevel } from "./status-indicator.js";

interface DashboardCardProps {
  title: string;
  status?: StatusLevel;
  statusLabel?: string;
  children?: React.ReactNode;
  className?: string;
}

export function DashboardCard({
  title,
  status,
  statusLabel,
  children,
  className,
}: DashboardCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-zinc-200 bg-white p-5",
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-bold uppercase tracking-wider text-aac-dark">
          {title}
        </h3>
        {status && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn("size-3.5 shrink-0 rounded-full", {
                "bg-emerald-500": status === "green",
                "bg-amber-400": status === "yellow",
                "bg-red-500": status === "red",
                "bg-zinc-300": status === "gray",
              })}
            />
            {statusLabel && (
              <span
                className={cn("text-xs font-semibold", {
                  "text-emerald-700": status === "green",
                  "text-amber-700": status === "yellow",
                  "text-red-700": status === "red",
                  "text-zinc-400": status === "gray",
                })}
              >
                {statusLabel}
              </span>
            )}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
