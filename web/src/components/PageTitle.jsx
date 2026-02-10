import { cn } from '@/lib/utils';

/**
 * Page heading with icon and divider, NetCloud-style.
 * Smaller sub-heading; thin line below separating from content.
 */
export function PageTitle({ icon: Icon, children, className }) {
  return (
    <div className={cn('mb-6', className)}>
      <h1 className="m-0 flex items-center gap-2 text-sm font-semibold text-foreground">
        {Icon && (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        {children}
      </h1>
      <div
        className="mt-2 h-px w-full shrink-0 bg-border"
        aria-hidden
        role="presentation"
      />
    </div>
  );
}
