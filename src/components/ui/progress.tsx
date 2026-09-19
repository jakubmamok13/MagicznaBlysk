import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '@/lib/utils';

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indeterminate?: boolean }
>(({ className, value, indeterminate = false, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
    value={indeterminate ? null : value}
    {...props}
  >
    {indeterminate ? (
      <div className="absolute inset-y-0 w-1/3 animate-shimmer rounded-full bg-primary" />
    ) : (
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 rounded-full bg-primary transition-transform duration-500 ease-out"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    )}
  </ProgressPrimitive.Root>
));
Progress.displayName = 'Progress';

export { Progress };
