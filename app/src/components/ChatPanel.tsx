import { useState, useRef, useEffect, useCallback, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ChatMessage, MapSelectionContext } from '../types/transit';
import InteractiveMessage from './InteractiveMessage.js';

export interface NameIndex {
  routes: Map<string, string>;
  stops: Map<string, { lng: number; lat: number }>;
}

interface Props {
  messages: ChatMessage[];
  isLoading: boolean;
  apiKeyConfigured: boolean;
  onSendMessage: (content: string) => void;
  /** Current map selection context for the context indicator */
  mapSelection: MapSelectionContext | null;
  /** Name index for making route/stop names clickable */
  nameIndex: NameIndex;
  /** Handler when a route name in a message is clicked */
  onMessageRouteClick: (routeId: string) => void;
  /** Handler when a stop name in a message is clicked */
  onMessageStopClick: (name: string, lng: number, lat: number) => void;
}

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const EXAMPLE_QUERIES = [
  'What light rail lines serve downtown Seattle?',
  'How do I get from Capitol Hill to the airport?',
  'Which transit modes connect to King Street Station?',
  'What are the RapidRide bus lines?',
];

/** Breakpoint where the chat panel switches to mobile (full-width) layout */
const MOBILE_BREAKPOINT = 480;

export default function ChatPanel({
  messages, isLoading, apiKeyConfigured, onSendMessage,
  mapSelection, nameIndex, onMessageRouteClick, onMessageStopClick,
}: Props) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < MOBILE_BREAKPOINT);

  // Responsive: detect narrow viewports using matchMedia
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const handleSubmit = useCallback((e?: FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading || !apiKeyConfigured) return;
    onSendMessage(input);
    setInput('');
  }, [input, isLoading, apiKeyConfigured, onSendMessage]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const handleExampleClick = useCallback((query: string) => {
    if (isLoading || !apiKeyConfigured) return;
    onSendMessage(query);
  }, [isLoading, apiKeyConfigured, onSendMessage]);

  const showExamples = messages.length === 0 && apiKeyConfigured;

  // Responsive container style: mobile uses full-width with margin, desktop uses fixed width
  const containerStyle = isMobile
    ? {
        position: 'absolute' as const,
        bottom: 8,
        left: 8,
        right: 8,
        maxHeight: '50vh',
        backgroundColor: '#fff',
        borderRadius: 12,
        boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
        zIndex: 5,
        display: 'flex' as const,
        flexDirection: 'column' as const,
        fontFamily: FONT_FAMILY,
        overflow: 'hidden' as const,
      }
    : {
        position: 'absolute' as const,
        bottom: 20,
        right: 16,
        width: 380,
        maxHeight: 520,
        backgroundColor: '#fff',
        borderRadius: 12,
        boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
        zIndex: 5,
        display: 'flex' as const,
        flexDirection: 'column' as const,
        fontFamily: FONT_FAMILY,
        overflow: 'hidden' as const,
      };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #eee',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2C6.48 2 2 6.48 2 12c0 1.82.49 3.53 1.34 5L2 22l5-1.34C8.47 21.51 10.18 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" fill="#1a73e8" opacity="0.15" />
          <path d="M12 2C6.48 2 2 6.48 2 12c0 1.82.49 3.53 1.34 5L2 22l5-1.34C8.47 21.51 10.18 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z" stroke="#1a73e8" strokeWidth="1.5" fill="none" />
        </svg>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#222' }}>
          Transit Assistant
        </span>
      </div>

      {/* Context indicator (DM2) */}
      {mapSelection && apiKeyConfigured && (
        <ContextIndicator selection={mapSelection} />
      )}

      {/* Messages area */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: isMobile ? '10px 12px' : '12px 16px',
        minHeight: 0,
        maxHeight: isMobile ? undefined : 360,
      }}>
        {!apiKeyConfigured && <ApiKeyMessage />}

        {showExamples && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 10, lineHeight: 1.4 }}>
              Ask questions about Seattle&apos;s transit network. Try one of these:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {EXAMPLE_QUERIES.map((query) => (
                <button
                  key={query}
                  onClick={() => handleExampleClick(query)}
                  style={{
                    textAlign: 'left', padding: '8px 12px',
                    border: '1px solid #e0e0e0', borderRadius: 8,
                    backgroundColor: '#fafafa', cursor: 'pointer',
                    fontSize: 13, color: '#333', lineHeight: 1.3,
                    fontFamily: 'inherit',
                    transition: 'background-color 0.12s ease, border-color 0.12s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f0f4ff';
                    e.currentTarget.style.borderColor = '#1a73e8';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#fafafa';
                    e.currentTarget.style.borderColor = '#e0e0e0';
                  }}
                >
                  {query}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            nameIndex={nameIndex}
            onRouteClick={onMessageRouteClick}
            onStopClick={onMessageStopClick}
          />
        ))}

        {isLoading && <LoadingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {apiKeyConfigured && (
        <form onSubmit={handleSubmit} style={{
          padding: isMobile ? '8px 10px' : '10px 12px', borderTop: '1px solid #eee',
          display: 'flex', gap: 8, flexShrink: 0,
        }}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mapSelection
              ? `Ask about ${mapSelection.name}...`
              : 'Ask about Seattle transit...'}
            disabled={isLoading}
            style={{
              flex: 1, padding: '8px 12px', border: '1px solid #ddd',
              borderRadius: 8, fontSize: 13, fontFamily: 'inherit',
              outline: 'none',
              backgroundColor: isLoading ? '#f5f5f5' : '#fff',
              color: '#333', transition: 'border-color 0.12s ease',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#1a73e8'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#ddd'; }}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            style={{
              padding: '8px 14px', border: 'none', borderRadius: 8,
              backgroundColor: isLoading || !input.trim() ? '#ccc' : '#1a73e8',
              color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', transition: 'background-color 0.12s ease',
              flexShrink: 0,
            }}
            aria-label="Send message"
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}

function ContextIndicator({ selection }: { selection: MapSelectionContext }) {
  const icon = selection.type === 'route' ? (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1 6h10M8 3l3 3-3 3" stroke="#1a73e8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="5" r="3" stroke="#1a73e8" strokeWidth="1.3" fill="none" />
      <path d="M6 8v3" stroke="#1a73e8" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );

  return (
    <div style={{
      padding: '6px 16px',
      backgroundColor: '#f0f4ff',
      borderBottom: '1px solid #dce6f7',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexShrink: 0,
      animation: 'fadeIn 0.15s ease-out',
    }}>
      {icon}
      <span style={{
        fontSize: 12,
        color: '#1a73e8',
        fontWeight: 500,
      }}>
        Asking about: {selection.name}
      </span>
      <style>{`@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </div>
  );
}

function MessageBubble({ message, nameIndex, onRouteClick, onStopClick }: {
  message: ChatMessage;
  nameIndex: NameIndex;
  onRouteClick: (routeId: string) => void;
  onStopClick: (name: string, lng: number, lat: number) => void;
}) {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';
  const isAssistant = message.role === 'assistant';

  let content: ReactNode;
  if (isAssistant) {
    content = (
      <InteractiveMessage
        text={message.content}
        nameIndex={nameIndex}
        onRouteClick={onRouteClick}
        onStopClick={onStopClick}
      />
    );
  } else {
    content = message.content;
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 10,
    }}>
      <div style={{
        maxWidth: '85%',
        padding: '8px 12px',
        borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
        backgroundColor: isError ? '#fef2f2' : isUser ? '#1a73e8' : '#f0f0f0',
        color: isError ? '#b91c1c' : isUser ? '#fff' : '#333',
        fontSize: 13,
        lineHeight: 1.5,
        wordBreak: 'break-word',
        whiteSpace: isAssistant ? 'normal' : 'pre-wrap',
      }}>
        {isAssistant && (
          <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 3 }}>
            Transit Assistant
          </div>
        )}
        {isError && (
          <div style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', marginBottom: 3 }}>
            Error
          </div>
        )}
        {content}
      </div>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 10 }}>
      <div style={{
        padding: '10px 16px',
        borderRadius: '12px 12px 12px 2px',
        backgroundColor: '#f0f0f0',
        fontSize: 13, color: '#888',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <span style={{ animation: 'chatDot 1.4s infinite 0s' }}>&#8226;</span>
        <span style={{ animation: 'chatDot 1.4s infinite 0.2s' }}>&#8226;</span>
        <span style={{ animation: 'chatDot 1.4s infinite 0.4s' }}>&#8226;</span>
        <style>{`
          @keyframes chatDot {
            0%, 80%, 100% { opacity: 0.2; transform: scale(1); }
            40% { opacity: 1; transform: scale(1.2); }
          }
        `}</style>
      </div>
    </div>
  );
}

function ApiKeyMessage() {
  return (
    <div style={{
      padding: '16px', backgroundColor: '#fffbeb',
      border: '1px solid #fde68a', borderRadius: 8,
      fontSize: 13, lineHeight: 1.5, color: '#92400e',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        AI features are not configured
      </div>
      <p style={{ margin: '0 0 8px 0' }}>
        To enable the AI transit assistant, set the <code style={{
          backgroundColor: '#fef3c7', padding: '1px 4px',
          borderRadius: 3, fontSize: 12, fontFamily: 'monospace',
        }}>VITE_AI_API_KEY</code> environment variable with your Anthropic API key.
      </p>
      <p style={{ margin: 0, fontSize: 12, color: '#a16207' }}>
        Create a <code style={{
          backgroundColor: '#fef3c7', padding: '1px 4px',
          borderRadius: 3, fontSize: 11, fontFamily: 'monospace',
        }}>.env</code> file in the project root with:<br />
        <code style={{
          display: 'block', marginTop: 4, backgroundColor: '#fef3c7',
          padding: '4px 8px', borderRadius: 3, fontSize: 11, fontFamily: 'monospace',
        }}>VITE_AI_API_KEY=your-api-key-here</code>
      </p>
    </div>
  );
}
