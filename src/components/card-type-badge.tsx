import { Badge } from '@/components/ui/badge';
import { CARD_TYPE_META } from '@/lib/labels';
import type { CardType } from '@/lib/db';

export function CardTypeBadge({ type }: { type: CardType }): React.JSX.Element {
  const meta = CARD_TYPE_META[type];
  return (
    <Badge variant={meta.tone} title={meta.description}>
      {meta.short}
    </Badge>
  );
}
