import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { memo, useMemo } from 'react';

marked.setOptions({ gfm: true, breaks: false });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [text]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
