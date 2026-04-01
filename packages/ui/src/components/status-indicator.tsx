import { cn } from "../lib/utils.js";

export type StatusLevel = "green" | "yellow" | "red" | "gray";

interface StatusIndicatorProps {
  status: StatusLevel;
  label?: string;
  className?: string;
}

const statusColors: Record<StatusLevel, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
  gray: "bg-zinc-300",
};

export function StatusIndicator({
  status,
  label,
  className,
}: StatusIndicatorProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        className={cn(
          "size-2.5 shrink-0 rounded-full",
          statusColors[status],
        )}
      />
      {label && (
        <span className="text-xs font-medium text-zinc-500">{label}</span>
      )}
    </span>
  );
}
