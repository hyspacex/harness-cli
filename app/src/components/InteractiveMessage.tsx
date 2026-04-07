import { useMemo, useCallback, type ReactNode, type CSSProperties } from 'react';
import MarkdownText from './MarkdownText.js';

interface NameIndex {
  /** route shortName -> routeId */
  routes: Map<string, string>;
  /** stop name -> { lng, lat } */
  stops: Map<string, { lng: number; lat: number }>;
}

interface Props {
  text: string;
  nameIndex: NameIndex;
  onRouteClick: (routeId: string) => void;
  onStopClick: (name: string, lng: number, lat: number) => void;
}

const linkStyle: CSSProperties = {
  color: '#1a73e8',
  textDecoration: 'underline',
  textDecorationColor: 'rgba(26, 115, 232, 0.35)',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
  fontWeight: 500,
  borderRadius: 2,
  transition: 'background-color 0.1s ease',
};

/**
 * Renders AI message text with clickable route and stop names.
 * Names detected by matching against GeoJSON data indexes.
 * Falls back to MarkdownText for plain rendering when no names match.
 */
export default function InteractiveMessage({ text, nameIndex, onRouteClick, onStopClick }: Props) {
  // Build sorted name entries and regex pattern, memoized on nameIndex
  const { nameMap, pattern } = useMemo(() => {
    type NameEntry = { name: string; type: 'route' | 'stop'; routeId?: string; coords?: { lng: number; lat: number } };
    const entries: NameEntry[] = [];
    for (const [shortName, routeId] of nameIndex.routes) {
      entries.push({ name: shortName, type: 'route', routeId });
    }
    for (const [stopName, coords] of nameIndex.stops) {
      entries.push({ name: stopName, type: 'stop', coords });
    }
    // Sort longest first to avoid partial matches
    entries.sort((a, b) => b.name.length - a.name.length);

    const map = new Map<string, NameEntry>();
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (!map.has(lower)) map.set(lower, entry);
    }

    if (entries.length === 0) return { nameMap: map, pattern: null };

    const escaped = entries.map(n => n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`, 'gi');
    return { nameMap: map, pattern: re };
  }, [nameIndex]);

  const handleRouteClick = useCallback((routeId: string) => {
    onRouteClick(routeId);
  }, [onRouteClick]);

  const handleStopClick = useCallback((name: string, lng: number, lat: number) => {
    onStopClick(name, lng, lat);
  }, [onStopClick]);

  // Process text: detect names and wrap in clickable elements
  const processedContent = useMemo(() => {
    if (!pattern) return <MarkdownText text={text} />;

    const lines = text.split('\n');
    const elements: ReactNode[] = [];
    let key = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        elements.push(<div key={key++} style={{ height: 6 }} />);
        continue;
      }

      const listMatch = trimmed.match(/^[-*•]\s+(.+)$/);
      const content = listMatch ? listMatch[1] : trimmed;

      const parts: ReactNode[] = [];
      let lastIdx = 0;
      let m: RegExpExecArray | null;
      pattern.lastIndex = 0;

      while ((m = pattern.exec(content)) !== null) {
        if (m.index > lastIdx) {
          parts.push(renderInlineMarkdown(content.slice(lastIdx, m.index), key++));
        }
        const matched = m[1];
        const entry = nameMap.get(matched.toLowerCase());
        if (entry?.type === 'route' && entry.routeId) {
          const rid = entry.routeId;
          parts.push(
            <span key={key++} style={linkStyle}
              onClick={() => handleRouteClick(rid)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(26, 115, 232, 0.08)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRouteClick(rid); }}
            >{matched}</span>
          );
        } else if (entry?.type === 'stop' && entry.coords) {
          const { lng, lat } = entry.coords;
          const sName = entry.name;
          parts.push(
            <span key={key++} style={linkStyle}
              onClick={() => handleStopClick(sName, lng, lat)}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(26, 115, 232, 0.08)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') handleStopClick(sName, lng, lat); }}
            >{matched}</span>
          );
        } else {
          parts.push(renderInlineMarkdown(matched, key++));
        }
        lastIdx = m.index + m[0].length;
      }

      if (lastIdx < content.length) {
        parts.push(renderInlineMarkdown(content.slice(lastIdx), key++));
      }

      if (listMatch) {
        elements.push(
          <div key={key++} style={{ display: 'flex', gap: 6, marginBottom: 1, paddingLeft: 4 }}>
            <span style={{ flexShrink: 0, color: '#666' }}>&bull;</span>
            <span>{parts}</span>
          </div>
        );
      } else {
        elements.push(<div key={key++} style={{ marginBottom: 2 }}>{parts}</div>);
      }
    }

    return <>{elements}</>;
  }, [text, pattern, nameMap, handleRouteClick, handleStopClick]);

  return <>{processedContent}</>;
}

/** Inline markdown renderer (bold, italic, code) */
function renderInlineMarkdown(text: string, baseKey: number): ReactNode {
  const parts: ReactNode[] = [];
  const mdPattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let subKey = 0;

  while ((match = mdPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={`${baseKey}-${subKey++}`} style={{ fontWeight: 600 }}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={`${baseKey}-${subKey++}`}>{match[3]}</em>);
    } else if (match[4]) {
      parts.push(
        <code key={`${baseKey}-${subKey++}`} style={{
          backgroundColor: 'rgba(0,0,0,0.06)', padding: '1px 4px',
          borderRadius: 3, fontSize: '0.92em', fontFamily: 'monospace',
        }}>{match[4]}</code>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 1 ? <span key={baseKey}>{parts}</span> : (parts[0] ?? text);
}
