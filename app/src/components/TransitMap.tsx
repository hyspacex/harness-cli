import { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import { TransitProvider, useTransitContext } from '../context/TransitContext';
import { useTransitData } from '../hooks/useTransitData';
import { useDetailData } from '../hooks/useDetailData';
import { useAiChat } from '../hooks/useAiChat';
import { useMapActions, type MapActionCallbacks } from '../hooks/useMapActions';
import MapContainer, { type MapContainerHandle } from './MapContainer';
import DetailPanel from './DetailPanel';
import Legend from './Legend';
import ChatPanel, { type NameIndex } from './ChatPanel';
import LoadingOverlay from './LoadingOverlay.js';
import type { StopSummary, MapAction, MapSelectionContext } from '../types/transit';
import { ALL_MODES } from '../types/transit';

/** Minimum time (ms) the loading overlay stays visible to prevent a jarring flash */
const LOADING_MIN_DISPLAY_MS = 400;

function TransitMapInner() {
  const mapRef = useRef<MapContainerHandle>(null);
  const { data, loading: dataLoading, error: dataError } = useTransitData();
  const { resolveRoute, resolveStop } = useDetailData(data);
  const prevActionsRef = useRef<MapAction[]>([]);

  // Loading overlay with minimum display time
  const [showLoading, setShowLoading] = useState(true);
  const loadStartRef = useRef(Date.now());

  useEffect(() => {
    if (dataLoading) {
      setShowLoading(true);
      loadStartRef.current = Date.now();
    } else {
      const elapsed = Date.now() - loadStartRef.current;
      const remaining = Math.max(0, LOADING_MIN_DISPLAY_MS - elapsed);
      if (remaining === 0) {
        setShowLoading(false);
      } else {
        const timer = setTimeout(() => setShowLoading(false), remaining);
        return () => clearTimeout(timer);
      }
    }
  }, [dataLoading]);

  const {
    selectedRouteId,
    selectedStopId,
    panelView,
    selectRoute,
    selectStop,
    setVisibleModes,
  } = useTransitContext();

  // Derive map selection context for AI (DM1)
  const mapSelection = useMemo<MapSelectionContext | null>(() => {
    if (panelView === 'route' && selectedRouteId) {
      const route = resolveRoute(selectedRouteId);
      if (route) {
        const stopNames = route.stops.map(s => s.name).join(', ');
        return {
          type: 'route',
          name: route.shortName,
          details: `Route: ${route.shortName}${route.longName ? ` (${route.longName})` : ''}. Stops on this route: ${stopNames}.`,
        };
      }
    }
    if (panelView === 'stop' && selectedStopId) {
      const stop = resolveStop(selectedStopId);
      if (stop) {
        const routeList = stop.routesByMode
          .flatMap(g => g.routes.map(r => `${r} (${g.label})`))
          .join(', ');
        return {
          type: 'stop',
          name: stop.name,
          details: `Stop/Station: ${stop.name}. Routes serving this stop: ${routeList || 'unknown'}.`,
        };
      }
    }
    return null;
  }, [panelView, selectedRouteId, selectedStopId, resolveRoute, resolveStop]);

  const { messages, isLoading, apiKeyConfigured, sendMessage, latestActions } = useAiChat(data, mapSelection);

  // Resolve detail data for the panel
  const routeDetail = useMemo(
    () => (panelView === 'route' && selectedRouteId ? resolveRoute(selectedRouteId) : null),
    [panelView, selectedRouteId, resolveRoute],
  );

  const stopDetail = useMemo(
    () => (panelView === 'stop' && selectedStopId ? resolveStop(selectedStopId) : null),
    [panelView, selectedStopId, resolveStop],
  );

  // When panel closes, clear the stop marker
  useEffect(() => {
    if (!panelView) {
      mapRef.current?.clearSelectedStopMarker();
    }
  }, [panelView]);

  // Handle stop click from the route detail panel's stop list
  const handlePanelStopClick = useCallback((stop: StopSummary) => {
    selectStop(stop.stopId);
    mapRef.current?.flyTo(stop.coordinates[0], stop.coordinates[1], 15);
    mapRef.current?.setSelectedStopMarker(stop.coordinates[0], stop.coordinates[1]);
  }, [selectStop]);

  // Map action callbacks wired to MapContainer imperative handle and context
  const mapActionCallbacks = useMemo<MapActionCallbacks>(() => ({
    highlightRoutes: (routeIds: string[]) => {
      mapRef.current?.highlightRoutes(routeIds);
    },
    showStopMarkers: (stops: Array<{ lng: number; lat: number; name: string }>) => {
      mapRef.current?.showStopMarkers(stops);
    },
    flyTo: (lng: number, lat: number, zoom?: number) => {
      mapRef.current?.flyTo(lng, lat, zoom);
    },
    setVisibleModes,
    clearHighlights: () => {
      mapRef.current?.clearAiHighlights();
    },
  }), [setVisibleModes]);

  const { executeActions } = useMapActions(data, mapActionCallbacks);

  // Execute map actions when latestActions changes (from AI response)
  useEffect(() => {
    if (latestActions === prevActionsRef.current) return;
    prevActionsRef.current = latestActions;
    if (latestActions.length > 0) {
      executeActions(latestActions);
    }
  }, [latestActions, executeActions]);

  // Build name index for clickable route/stop names in AI messages (DM4)
  const nameIndex = useMemo<NameIndex>(() => {
    const routes = new Map<string, string>();
    const stops = new Map<string, { lng: number; lat: number }>();

    for (const mode of ALL_MODES) {
      const modeData = data[mode];
      if (!modeData) continue;

      if (modeData.routes) {
        const seen = new Set<string>();
        for (const feature of modeData.routes.features) {
          const props = feature.properties as Record<string, unknown>;
          const shortName = props.shortName as string;
          const routeId = props.routeId as string;
          if (shortName && routeId && !seen.has(shortName)) {
            seen.add(shortName);
            routes.set(shortName, routeId);
          }
        }
      }

      if (modeData.stops) {
        const seen = new Set<string>();
        for (const feature of modeData.stops.features) {
          const props = feature.properties as Record<string, unknown>;
          const geom = feature.geometry as GeoJSON.Point;
          const name = props.name as string;
          if (name && !seen.has(name)) {
            seen.add(name);
            stops.set(name, { lng: geom.coordinates[0], lat: geom.coordinates[1] });
          }
        }
      }
    }

    return { routes, stops };
  }, [data]);

  // Clickable route name handler (DM4) — highlight the route on map
  const handleMessageRouteClick = useCallback((routeId: string) => {
    mapRef.current?.highlightRoutes([routeId]);
    selectRoute(routeId);
  }, [selectRoute]);

  // Clickable stop name handler (DM4) — fly to stop and show marker
  const handleMessageStopClick = useCallback((name: string, lng: number, lat: number) => {
    mapRef.current?.flyTo(lng, lat, 15);
    mapRef.current?.showStopMarkers([{ lng, lat, name }]);
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <MapContainer ref={mapRef} data={data} />
      {showLoading && <LoadingOverlay />}
      {dataError && <DataErrorBanner message={dataError} />}
      <Legend />
      <DetailPanel
        routeDetail={routeDetail}
        stopDetail={stopDetail}
        onStopClick={handlePanelStopClick}
      />
      <ChatPanel
        messages={messages}
        isLoading={isLoading}
        apiKeyConfigured={apiKeyConfigured}
        onSendMessage={sendMessage}
        mapSelection={mapSelection}
        nameIndex={nameIndex}
        onMessageRouteClick={handleMessageRouteClick}
        onMessageStopClick={handleMessageStopClick}
      />
    </div>
  );
}

function DataErrorBanner({ message }: { message: string }) {
  return (
    <div style={{
      position: 'absolute',
      top: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 20,
      backgroundColor: '#fef2f2',
      border: '1px solid #fecaca',
      borderRadius: 8,
      padding: '10px 20px',
      fontSize: 13,
      color: '#b91c1c',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
      maxWidth: 420,
      textAlign: 'center',
    }}>
      {message}
    </div>
  );
}

export default function TransitMap() {
  return (
    <TransitProvider>
      <TransitMapInner />
    </TransitProvider>
  );
}
