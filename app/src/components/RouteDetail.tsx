import type { RouteDetail as RouteDetailType, StopSummary } from '../types/transit';
import { MODE_LABELS, MODE_STYLES } from '../types/transit';

interface Props {
  route: RouteDetailType;
  onStopClick: (stop: StopSummary) => void;
}

export default function RouteDetail({ route, onStopClick }: Props) {
  const modeStyle = MODE_STYLES[route.mode];
  const modeLabel = MODE_LABELS[route.mode];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span
            style={{
              display: 'inline-block',
              width: 14,
              height: 14,
              borderRadius: 3,
              backgroundColor: modeStyle.color,
              flexShrink: 0,
            }}
            aria-label={`${modeLabel} color`}
          />
          <h2 style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 700,
            color: '#1a1a1a',
            lineHeight: 1.2,
          }}>
            {route.shortName}
          </h2>
        </div>
        {route.longName && (
          <div style={{ fontSize: 13, color: '#555', marginTop: 2, paddingLeft: 24 }}>
            {route.longName}
          </div>
        )}
        <div style={{
          display: 'inline-block',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: modeStyle.color,
          backgroundColor: `${modeStyle.color}14`,
          borderRadius: 4,
          padding: '2px 8px',
          marginTop: 6,
          marginLeft: 24,
        }}>
          {modeLabel}
        </div>
      </div>

      {/* Stop list */}
      <div>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: '#666',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 8,
        }}>
          Stops ({route.stops.length})
        </div>
        <ol style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
        }}>
          {route.stops.map((stop, i) => (
            <li key={`${stop.stopId}-${i}`}>
              <button
                onClick={() => onStopClick(stop)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '7px 8px',
                  border: 'none',
                  borderRadius: 4,
                  backgroundColor: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 13,
                  color: '#333',
                  fontFamily: 'inherit',
                  transition: 'background-color 0.12s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f0f4f8';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
                aria-label={`View ${stop.name}`}
              >
                {/* Stop dot and connecting line */}
                <span style={{
                  position: 'relative',
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    border: `2px solid ${modeStyle.color}`,
                    backgroundColor: (i === 0 || i === route.stops.length - 1)
                      ? modeStyle.color : '#fff',
                  }} />
                </span>
                <span style={{ flex: 1 }}>
                  {stop.name}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
