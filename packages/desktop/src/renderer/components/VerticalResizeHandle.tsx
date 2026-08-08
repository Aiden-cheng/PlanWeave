import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

type VerticalResizeHandleProps = ComponentPropsWithoutRef<"div"> & {
  side: "left" | "right";
  /** When false, keep the hit target but omit the 1px line (panel border is the separator). */
  showVisualLine?: boolean;
  visualTopInset?: boolean;
};

export function VerticalResizeHandle({
  className,
  side,
  showVisualLine = true,
  visualTopInset = false,
  ...props
}: VerticalResizeHandleProps) {
  return (
    <div
      {...props}
      className={cn(
        "app-no-drag absolute inset-y-0 z-20 w-2 cursor-col-resize bg-transparent focus-visible:outline-none",
        side === "left" ? "left-0" : "right-0",
        showVisualLine &&
          "after:pointer-events-none after:absolute after:w-px after:bg-border/80 after:transition-colors after:duration-[var(--motion-duration-fast)] after:ease-[var(--motion-ease-standard)] hover:after:bg-foreground/30 focus-visible:after:bg-foreground/35 active:after:bg-foreground/50",
        showVisualLine && (visualTopInset ? "after:top-11 after:bottom-0" : "after:inset-y-0"),
        showVisualLine && (side === "left" ? "after:left-0" : "after:right-0"),
        className
      )}
    />
  );
}
