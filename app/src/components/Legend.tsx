import { ALL_MODES, MODE_LABELS, MODE_STYLES, type TransitMode } from '../types/transit';
import { useTransitContext } from '../context/TransitContext';

export default function Legend() {
  const { visibleModes, toggleMode } = useTransitContext();

  return (
    <div style={{
      position: 'absolute',
      bottom: 30,
      left: 10,
      background: 'rgba(255,255,255,0.95)',
      borderRadius: 8,
      padding: '10px 14px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      fontSize: 12,
      lineHeight: '20px',
      zIndex: 1,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      userSelect: 'none',
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13, color: '#222' }}>
        Transit Modes
      </div>
      {ALL_MODES.map(mode => (
        <LegendItem
          key={mode}
          mode={mode}
          active={visibleModes.has(mode)}
          onToggle={toggleMode}
        />
      ))}
    </div>
  );
}

function LegendItem({
  mode,
  active,
  onToggle,
}: {
  mode: TransitMode;
  active: boolean;
  onToggle: (mode: TransitMode) => void;
}) {
  const style = MODE_STYLES[mode];
  const label = MODE_LABELS[mode];
  const hasDash = !!style.dasharray;

  return (
    <div
      onClick={() => onToggle(mode)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 2,
        cursor: 'pointer',
        opacity: active ? 1 : 0.35,
        transition: 'opacity 0.15s ease',
      }}
      role="button"
      aria-pressed={active}
      aria-label={`Toggle ${label}`}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(mode); } }}
    >
      <svg width="24" height="4" aria-hidden="true">
        <line
          x1="0" y1="2" x2="24" y2="2"
          stroke={style.color}
          strokeWidth={3}
          strokeDasharray={hasDash ? '5,3' : undefined}
          strokeLinecap="round"
        />
      </svg>
      <span style={{
        color: '#444',
        textDecoration: active ? 'none' : 'line-through',
        transition: 'text-decoration 0.15s ease',
      }}>
        {label}
      </span>
    </div>
  );
}
