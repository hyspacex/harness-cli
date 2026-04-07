const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * Loading overlay displayed on the map while GeoJSON transit data is being fetched.
 * Shows a spinner and loading text centered on the map.
 */
export default function LoadingOverlay() {
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      zIndex: 15,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255, 255, 255, 0.7)',
      backdropFilter: 'blur(2px)',
      fontFamily: FONT_FAMILY,
      pointerEvents: 'none',
    }}>
      <div style={{
        width: 36,
        height: 36,
        border: '3px solid #e0e0e0',
        borderTopColor: '#1a73e8',
        borderRadius: '50%',
        animation: 'loadingSpin 0.8s linear infinite',
        marginBottom: 12,
      }} />
      <div style={{
        fontSize: 14,
        fontWeight: 500,
        color: '#555',
        letterSpacing: '0.2px',
      }}>
        Loading transit data...
      </div>
      <style>{`
        @keyframes loadingSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
