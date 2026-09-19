import { parseCloze } from '@/lib/cloze';
import { cn } from '@/lib/utils';

export interface ClozeTextProps {
  text: string;
  /** Czy luki są odsłonięte. */
  revealed: boolean;
  className?: string;
}

/**
 * Zdanie z lukami. W stanie ukrytym pokazuje podpowiedź lub `[…]`,
 * a po odsłonięciu — treść z wyróżnieniem, co dokładnie było ukryte.
 */
export function ClozeText({ text, revealed, className }: ClozeTextProps): React.JSX.Element {
  const segments = parseCloze(text);

  return (
    <p className={cn('text-balance leading-relaxed', className)}>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              'mx-0.5 inline-block rounded px-1.5 transition-all duration-300',
              revealed
                ? 'bg-success/15 font-semibold text-success'
                : 'bg-primary/15 font-medium text-primary',
            )}
          >
            {revealed ? segment.value : (segment.hint ?? '…')}
            {!revealed && <span className="sr-only">ukryta fraza</span>}
          </span>
        );
      })}
    </p>
  );
}
