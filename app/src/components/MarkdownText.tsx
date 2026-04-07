import type { ReactNode } from 'react';

/**
 * Renders inline markdown: **bold**, *italic*, `code`.
 */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={match.index} style={{ fontWeight: 600 }}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    } else if (match[4]) {
      parts.push(
        <code key={match.index} style={{
          backgroundColor: 'rgba(0,0,0,0.06)',
          padding: '1px 4px',
          borderRadius: 3,
          fontSize: '0.92em',
          fontFamily: 'monospace',
        }}>{match[4]}</code>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

/**
 * Lightweight markdown renderer for chat messages.
 * Handles: paragraphs, bullet lists (- / * / •), **bold**, *italic*, `code`.
 */
export default function MarkdownText({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={key++} style={{
        margin: '4px 0',
        paddingLeft: 18,
        listStyleType: 'disc',
      }}>
        {listItems.map((item, i) => (
          <li key={i} style={{ marginBottom: 1 }}>{renderInline(item)}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const listMatch = trimmed.match(/^[-*•]\s+(.+)$/);

    if (listMatch) {
      listItems.push(listMatch[1]);
    } else {
      flushList();
      if (trimmed === '') {
        elements.push(<div key={key++} style={{ height: 6 }} />);
      } else {
        elements.push(
          <div key={key++} style={{ marginBottom: 2 }}>
            {renderInline(trimmed)}
          </div>
        );
      }
    }
  }

  flushList();
  return <>{elements}</>;
}
