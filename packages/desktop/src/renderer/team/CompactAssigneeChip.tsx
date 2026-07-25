import { cn } from "@/lib/utils";
import type { CompactAssigneeChip as CompactAssigneeChipModel } from "../collaboration/assigneeSurfaceViewModels";

export type CompactAssigneeChipProps = {
  chip: CompactAssigneeChipModel;
  /** Accessible name prefix, e.g. translated "Assignee". */
  label: string;
  className?: string;
  size?: "sm" | "xs";
};

/**
 * Dense read-only assignee indicator. Does not subscribe or mutate.
 * Parent supplies a chip from the shared assignee surface index.
 */
export function CompactAssigneeChipView({
  chip,
  label,
  className,
  size = "xs"
}: CompactAssigneeChipProps) {
  if (!chip.visible) return null;
  const sizeClass =
    size === "sm"
      ? "h-5 gap-1 px-1.5 text-[11px]"
      : "h-4 gap-0.5 px-1 text-[10px]";
  const avatarClass = size === "sm" ? "size-4 text-[8px]" : "size-3.5 text-[7px]";
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center rounded-full border font-medium tabular-nums",
        sizeClass,
        chip.tone === "issue"
          ? "border-state-failed/40 bg-state-failed-surface text-state-failed"
          : chip.tone === "assigned"
            ? "border-border/80 bg-surface-muted text-text-muted"
            : "border-border/60 bg-surface-base text-text-faint",
        className
      )}
      data-testid="compact-assignee-chip"
      data-work-item={chip.workItemKey}
      data-tone={chip.tone}
      title={`${label}: ${chip.label}`}
      aria-label={`${label}: ${chip.label}`}
    >
      {chip.initials ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full bg-state-selected-surface font-semibold text-text-strong",
            avatarClass
          )}
        >
          {chip.initials}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{chip.label}</span>
    </span>
  );
}
