import type { StopDetail as StopDetailType } from '../types/transit';
import { MODE_STYLES } from '../types/transit';

interface Props {
  stop: StopDetailType;
}

export default function StopDetail({ stop }: Props) {
  const primaryModeStyle = MODE_STYLES[stop.mode];
  const isMultiMode = stop.routesByMode.length > 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              backgroundColor: primaryModeStyle.color,
              border: '2px solid #fff',
              boxShadow: '0 0 0 1px rgba(0,0,0,0.1)',
              flexShrink: 0,
            }}
            aria-label={`${stop.mode} stop`}
          />
          <h2 style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 700,
            color: '#1a1a1a',
            lineHeight: 1.2,
          }}>
            {stop.name}
          </h2>
        </div>
        {isMultiMode && (
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: '#e67700',
            backgroundColor: '#fff3e0',
            borderRadius: 4,
            padding: '2px 8px',
            marginTop: 6,
            marginLeft: 24,
            display: 'inline-block',
          }}>
            Transfer Station
          </div>
        )}
      </div>

      {/* Routes grouped by mode */}
      <div>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: '#666',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 8,
        }}>
          Routes
        </div>
        {stop.routesByMode.map((group) => {
          const groupStyle = MODE_STYLES[group.mode];
          return (
            <div key={group.mode} style={{ marginBottom: 10 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 4,
              }}>
                <span style={{
                  display: 'inline-block',
                  width: 10,
                  height: 3,
                  borderRadius: 1,
                  backgroundColor: groupStyle.color,
                }} />
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: groupStyle.color,
                  textTransform: 'uppercase',
                  letterSpacing: '0.3px',
                }}>
                  {group.label}
                </span>
              </div>
              <ul style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                paddingLeft: 16,
              }}>
                {group.routes.map((routeName) => (
                  <li key={routeName}>
                    <span style={{
                      display: 'inline-block',
                      fontSize: 12,
                      color: '#444',
                      backgroundColor: '#f5f5f5',
                      borderRadius: 4,
                      padding: '3px 8px',
                      border: `1px solid ${groupStyle.color}30`,
                    }}>
                      {routeName}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {stop.routesByMode.length === 0 && (
          <div style={{ fontSize: 13, color: '#888', fontStyle: 'italic' }}>
            No route data available
          </div>
        )}
      </div>
    </div>
  );
}
