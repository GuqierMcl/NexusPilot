import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// ─── VirtualScrollArea Props ───────────────────────────────────────────────────

interface VirtualScrollAreaProps {
  children: React.ReactNode;
  className?: string;
  viewportRef: React.Ref<HTMLDivElement>;
}

// ─── VirtualScrollArea ─────────────────────────────────────────────────────────
// Wraps Radix ScrollArea primitives with viewport ref exposure for virtual scroll.
// Uses the same styling as shadcn ScrollArea for visual consistency.

export function VirtualScrollArea({
  children,
  className,
  viewportRef,
}: VirtualScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="virtual-scroll-area"
      className={cn("relative size-full", className)}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="virtual-scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
