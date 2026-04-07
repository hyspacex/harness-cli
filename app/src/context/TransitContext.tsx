import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { ALL_MODES, type TransitMode } from '../types/transit';

/** What kind of detail is shown in the panel */
export type PanelView = 'route' | 'stop' | null;

interface TransitState {
  /** Which modes are currently visible on the map */
  visibleModes: Set<TransitMode>;
  /** Currently hovered route ID (transient) */
  hoveredRouteId: string | null;
  /** Currently clicked/selected route ID (persistent) */
  selectedRouteId: string | null;
  /** Currently selected stop ID */
  selectedStopId: string | null;
  /** Which panel view is active */
  panelView: PanelView;
}

interface TransitActions {
  toggleMode: (mode: TransitMode) => void;
  /** Set exact visible modes (used by AI filter actions) */
  setVisibleModes: (modes: Set<TransitMode>) => void;
  setHoveredRouteId: (id: string | null) => void;
  selectRoute: (routeId: string | null) => void;
  selectStop: (stopId: string | null, coordinates?: [number, number]) => void;
  clearSelection: () => void;
}

export type TransitContextValue = TransitState & TransitActions;

const TransitContext = createContext<TransitContextValue | null>(null);

export function TransitProvider({ children }: { children: ReactNode }) {
  const [visibleModes, setVisibleModes] = useState<Set<TransitMode>>(
    () => new Set(ALL_MODES),
  );
  const [hoveredRouteId, setHoveredRouteId] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [panelView, setPanelView] = useState<PanelView>(null);

  const toggleMode = useCallback((mode: TransitMode) => {
    setVisibleModes(prev => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
      } else {
        next.add(mode);
      }
      return next;
    });
  }, []);

  const selectRoute = useCallback((routeId: string | null) => {
    setSelectedRouteId(routeId);
    setSelectedStopId(null);
    setPanelView(routeId ? 'route' : null);
  }, []);

  const selectStop = useCallback((stopId: string | null) => {
    setSelectedStopId(stopId);
    setSelectedRouteId(null);
    setPanelView(stopId ? 'stop' : null);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedRouteId(null);
    setSelectedStopId(null);
    setPanelView(null);
  }, []);

  const setVisibleModesAction = useCallback((modes: Set<TransitMode>) => {
    setVisibleModes(new Set(modes));
  }, []);

  return (
    <TransitContext.Provider
      value={{
        visibleModes,
        hoveredRouteId,
        selectedRouteId,
        selectedStopId,
        panelView,
        toggleMode,
        setVisibleModes: setVisibleModesAction,
        setHoveredRouteId,
        selectRoute,
        selectStop,
        clearSelection,
      }}
    >
      {children}
    </TransitContext.Provider>
  );
}

export function useTransitContext(): TransitContextValue {
  const ctx = useContext(TransitContext);
  if (!ctx) throw new Error('useTransitContext must be used within TransitProvider');
  return ctx;
}
