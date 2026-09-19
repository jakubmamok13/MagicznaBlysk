import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export interface MarkdownProps {
  children: string;
  className?: string;
}

/**
 * Render markdown bez `rehype-raw` — surowy HTML z materiału użytkownika
 * nie jest wykonywany, więc treść wklejona z internetu jest bezpieczna.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
}: MarkdownProps): React.JSX.Element {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {linkChildren}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
