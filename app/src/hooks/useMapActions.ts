import { useCallback, useRef, useMemo } from 'react';
import type {
  MapAction,
  TransitMode,
  HighlightRoutesAction,
  ShowStopsAction,
} from '../types/transit';
import { ALL_MODES } from '../types/transit';

interface TransitGeoJSON {
  routes: GeoJSON.FeatureCollection | null;
  stops: GeoJSON.FeatureCollection | null;
}

type TransitDataMap = Partial<Record<TransitMode, TransitGeoJSON>>;

interface RouteIndex {
  /** shortName -> routeId (first match) */
  shortNameToId: Map<string, string>;
  /** Lowercase shortName -> original shortName for fuzzy matching */
  lowerShortNameToOriginal: Map<string, string>;
}

interface StopIndex {
  /** Exact stop name -> { coordinates, stopId } */
  nameToCoordinates: Map<string, { lng: number; lat: number; stopId: string }>;
  /** Lowercase name -> original name for fuzzy matching */
  lowerNameToOriginal: Map<string, string>;
}

export interface MapActionExecutor {
  /** Execute an array of map actions, validating against GeoJSON data */
  executeActions: (actions: MapAction[]) => void;
  /** Clear all AI-driven state */
  clearAiState: () => void;
}

export interface MapActionCallbacks {
  /** Highlight specific routes by their routeId(s). Pass empty to clear. */
  highlightRoutes: (routeIds: string[]) => void;
  /** Show markers at stop locations and optionally zoom to fit */
  showStopMarkers: (stops: Array<{ lng: number; lat: number; name: string }>) => void;
  /** Fly the map to a location */
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  /** Set which modes are visible */
  setVisibleModes: (modes: Set<TransitMode>) => void;
  /** Clear all AI highlights (routes, markers) */
  clearHighlights: () => void;
}

/**
 * Builds lookup indexes for validating route/stop names in map actions.
 */
function buildRouteIndex(data: TransitDataMap): RouteIndex {
  const shortNameToId = new Map<string, string>();
  const lowerShortNameToOriginal = new Map<string, string>();

  for (const mode of ALL_MODES) {
    const modeData = data[mode];
    if (!modeData?.routes) continue;

    for (const feature of modeData.routes.features) {
      const props = feature.properties as Record<string, unknown>;
      const routeId = props.routeId as string;
      const shortName = props.shortName as string;
      if (shortName && routeId && !shortNameToId.has(shortName)) {
        shortNameToId.set(shortName, routeId);
        lowerShortNameToOriginal.set(shortName.toLowerCase(), shortName);
      }
    }
  }

  return { shortNameToId, lowerShortNameToOriginal };
}

function buildStopIndex(data: TransitDataMap): StopIndex {
  const nameToCoordinates = new Map<string, { lng: number; lat: number; stopId: string }>();
  const lowerNameToOriginal = new Map<string, string>();

  for (const mode of ALL_MODES) {
    const modeData = data[mode];
    if (!modeData?.stops) continue;

    for (const feature of modeData.stops.features) {
      const props = feature.properties as Record<string, unknown>;
      const geom = feature.geometry as GeoJSON.Point;
      const name = props.name as string;
      const stopId = props.stopId as string;
      if (name && !nameToCoordinates.has(name)) {
        nameToCoordinates.set(name, {
          lng: geom.coordinates[0],
          lat: geom.coordinates[1],
          stopId,
        });
        lowerNameToOriginal.set(name.toLowerCase(), name);
      }
    }
  }

  return { nameToCoordinates, lowerNameToOriginal };
}

/**
 * Fuzzy match a route name against the index.
 * Tries: exact match, case-insensitive, partial prefix match.
 */
function resolveRouteName(name: string, index: RouteIndex): string | null {
  // Exact match
  if (index.shortNameToId.has(name)) return name;

  // Case-insensitive match
  const lower = name.toLowerCase();
  const original = index.lowerShortNameToOriginal.get(lower);
  if (original) return original;

  // Partial match: try trimming common suffixes like "Line" or "Rail"
  for (const [lowerKey, orig] of index.lowerShortNameToOriginal) {
    if (lowerKey.includes(lower) || lower.includes(lowerKey)) {
      return orig;
    }
  }

  return null;
}

/**
 * Fuzzy match a stop name against the index.
 * Tries: exact, case-insensitive, with/without "Station" suffix.
 */
function resolveStopName(name: string, index: StopIndex): string | null {
  // Exact match
  if (index.nameToCoordinates.has(name)) return name;

  // Case-insensitive
  const lower = name.toLowerCase();
  const original = index.lowerNameToOriginal.get(lower);
  if (original) return original;

  // Try adding/removing "Station" suffix
  const withStation = lower.endsWith(' station') ? lower : `${lower} station`;
  const withoutStation = lower.endsWith(' station')
    ? lower.slice(0, -' station'.length)
    : lower;

  const matchWith = index.lowerNameToOriginal.get(withStation);
  if (matchWith) return matchWith;

  const matchWithout = index.lowerNameToOriginal.get(withoutStation);
  if (matchWithout) return matchWithout;

  // Substring match as last resort (for partial names)
  for (const [lowerKey, orig] of index.lowerNameToOriginal) {
    if (lowerKey.includes(lower) || lower.includes(lowerKey)) {
      return orig;
    }
  }

  return null;
}

/**
 * Hook that provides map action execution capabilities.
 * Validates actions against loaded GeoJSON data before executing.
 */
export function useMapActions(
  data: TransitDataMap,
  callbacks: MapActionCallbacks,
): MapActionExecutor {
  const routeIndex = useMemo(() => buildRouteIndex(data), [data]);
  const stopIndex = useMemo(() => buildStopIndex(data), [data]);

  // Keep track of current AI-driven state for incremental updates
  const aiStateRef = useRef<{
    highlightedRouteIds: string[];
    markers: Array<{ lng: number; lat: number; name: string }>;
  }>({ highlightedRouteIds: [], markers: [] });

  const executeHighlightRoutes = useCallback((action: HighlightRoutesAction) => {
    const resolvedIds: string[] = [];
    for (const name of action.routeNames) {
      const resolved = resolveRouteName(name, routeIndex);
      if (resolved) {
        const routeId = routeIndex.shortNameToId.get(resolved);
        if (routeId) resolvedIds.push(routeId);
      }
      // Silently skip unmatched route names (DM6)
    }

    if (resolvedIds.length > 0) {
      aiStateRef.current.highlightedRouteIds = resolvedIds;
      callbacks.highlightRoutes(resolvedIds);
    }
  }, [routeIndex, callbacks]);

  const executeShowStops = useCallback((action: ShowStopsAction) => {
    const resolved: Array<{ lng: number; lat: number; name: string }> = [];
    for (const name of action.stopNames) {
      const resolvedName = resolveStopName(name, stopIndex);
      if (resolvedName) {
        const coords = stopIndex.nameToCoordinates.get(resolvedName);
        if (coords) {
          resolved.push({ lng: coords.lng, lat: coords.lat, name: resolvedName });
        }
      }
      // Silently skip unmatched stop names (DM6)
    }

    if (resolved.length > 0) {
      aiStateRef.current.markers = resolved;
      callbacks.showStopMarkers(resolved);
    }
  }, [stopIndex, callbacks]);

  const executeActions = useCallback((actions: MapAction[]) => {
    for (const action of actions) {
      try {
        switch (action.action) {
          case 'highlightRoutes':
            executeHighlightRoutes(action);
            break;

          case 'showStops':
            executeShowStops(action);
            break;

          case 'zoomTo':
            callbacks.flyTo(action.lng, action.lat, action.zoom);
            break;

          case 'filterModes': {
            const validModes = action.show.filter(
              (m): m is TransitMode => ALL_MODES.includes(m as TransitMode),
            );
            if (validModes.length > 0) {
              callbacks.setVisibleModes(new Set(validModes));
            } else {
              // If no valid modes specified, show all
              callbacks.setVisibleModes(new Set(ALL_MODES));
            }
            break;
          }

          case 'clearHighlights':
            callbacks.clearHighlights();
            aiStateRef.current = { highlightedRouteIds: [], markers: [] };
            break;
        }
      } catch {
        // Silently skip any action that fails (DM6)
      }
    }
  }, [executeHighlightRoutes, executeShowStops, callbacks]);

  const clearAiState = useCallback(() => {
    callbacks.clearHighlights();
    aiStateRef.current = { highlightedRouteIds: [], markers: [] };
  }, [callbacks]);

  return { executeActions, clearAiState };
}
