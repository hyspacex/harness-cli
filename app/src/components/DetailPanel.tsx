import { useEffect, useState } from 'react';
import { useTransitContext } from '../context/TransitContext';
import type { RouteDetail as RouteDetailType, StopDetail as StopDetailType, StopSummary } from '../types/transit';
import RouteDetail from './RouteDetail';
import StopDetail from './StopDetail';

interface Props {
  routeDetail: RouteDetailType | null;
  stopDetail: StopDetailType | null;
  onStopClick: (stop: StopSummary) => void;
}

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export default function DetailPanel({ routeDetail, stopDetail, onStopClick }: Props) {
  const { panelView, clearSelection } = useTransitContext();
  const [isNarrow, setIsNarrow] = useState(window.innerWidth < 768);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  if (!panelView) return null;

  const content = panelView === 'route' && routeDetail
    ? <RouteDetail route={routeDetail} onStopClick={onStopClick} />
    : panelView === 'stop' && stopDetail
      ? <StopDetail stop={stopDetail} />
      : null;

  if (!content) return null;

  if (isNarrow) {
    return (
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: '55vh',
          backgroundColor: '#fff',
          borderRadius: '16px 16px 0 0',
          boxShadow: '0 -4px 20px rgba(0,0,0,0.15)',
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          fontFamily: FONT_FAMILY,
          animation: 'slideUp 0.25s ease-out',
        }}
        role="complementary"
        aria-label="Detail panel"
      >
        <PanelHeader onClose={clearSelection} isNarrow />
        <div style={{
          overflowY: 'auto',
          padding: '0 16px 16px',
          flex: 1,
          minHeight: 0,
        }}>
          {content}
        </div>
        <style>{animationStyles}</style>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 340,
        height: '100%',
        backgroundColor: '#fff',
        boxShadow: '4px 0 20px rgba(0,0,0,0.1)',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_FAMILY,
        animation: 'slideRight 0.2s ease-out',
      }}
      role="complementary"
      aria-label="Detail panel"
    >
      <PanelHeader onClose={clearSelection} isNarrow={false} />
      <div style={{
        overflowY: 'auto',
        padding: '0 16px 16px',
        flex: 1,
        minHeight: 0,
      }}>
        {content}
      </div>
      <style>{animationStyles}</style>
    </div>
  );
}

function PanelHeader({ onClose, isNarrow }: { onClose: () => void; isNarrow: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: isNarrow ? 'center' : 'flex-end',
      padding: isNarrow ? '8px 16px 4px' : '10px 12px 0',
      flexShrink: 0,
    }}>
      {isNarrow && (
        <div style={{
          width: 36,
          height: 4,
          borderRadius: 2,
          backgroundColor: '#d0d0d0',
          marginBottom: 4,
        }} />
      )}
      <button
        onClick={onClose}
        style={{
          position: isNarrow ? 'absolute' : 'relative',
          right: isNarrow ? 12 : undefined,
          top: isNarrow ? 10 : undefined,
          width: 28,
          height: 28,
          border: 'none',
          borderRadius: '50%',
          backgroundColor: '#f0f0f0',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
          fontSize: 16,
          lineHeight: 1,
          padding: 0,
          transition: 'background-color 0.12s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#e0e0e0';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#f0f0f0';
        }}
        aria-label="Close panel"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

const animationStyles = `
  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  @keyframes slideRight {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }
`;
