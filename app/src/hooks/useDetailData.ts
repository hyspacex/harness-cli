import { useMemo } from 'react';
import type { TransitMode, RouteDetail, StopDetail, StopSummary } from '../types/transit';
import { MODE_LABELS, MODE_STYLES, ALL_MODES } from '../types/transit';

interface TransitGeoJSON {
  routes: GeoJSON.FeatureCollection | null;
  stops: GeoJSON.FeatureCollection | null;
}

type TransitDataMap = Partial<Record<TransitMode, TransitGeoJSON>>;

interface RouteRecord {
  routeId: string;
  shortName: string;
  longName: string;
  mode: TransitMode;
  color: string;
  coordinates: number[][];
}

interface StopRecord {
  stopId: string;
  name: string;
  mode: TransitMode;
  coordinates: [number, number];
  routes: string[];
}

/**
 * Projects a point onto a LineString and returns the distance
 * along the line (as a fraction 0-1) of the closest point.
 */
function projectOntoLine(
  point: [number, number],
  lineCoords: number[][],
): number {
  let minDist = Infinity;
  let bestFraction = 0;
  let accumulated = 0;
  let totalLength = 0;

  // First pass: compute total length
  for (let i = 1; i < lineCoords.length; i++) {
    totalLength += segmentLength(lineCoords[i - 1], lineCoords[i]);
  }

  if (totalLength === 0) return 0;

  // Second pass: find closest segment and project
  accumulated = 0;
  for (let i = 1; i < lineCoords.length; i++) {
    const a = lineCoords[i - 1];
    const b = lineCoords[i];
    const segLen = segmentLength(a, b);

    const t = clampedProjection(point, a, b);
    const projX = a[0] + t * (b[0] - a[0]);
    const projY = a[1] + t * (b[1] - a[1]);
    const dist = Math.hypot(point[0] - projX, point[1] - projY);

    if (dist < minDist) {
      minDist = dist;
      bestFraction = (accumulated + t * segLen) / totalLength;
    }

    accumulated += segLen;
  }

  return bestFraction;
}

function segmentLength(a: number[], b: number[]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function clampedProjection(
  p: [number, number],
  a: number[],
  b: number[],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
}

/**
 * Builds lookup indexes from transit GeoJSON data.
 * Returns functions to resolve route details and stop details by ID.
 */
export function useDetailData(data: TransitDataMap) {
  const indexes = useMemo(() => {
    const routeMap = new Map<string, RouteRecord>();
    const shortNameToRoute = new Map<string, RouteRecord>();
    const stopMap = new Map<string, StopRecord>();
    const allStops: StopRecord[] = [];

    for (const mode of ALL_MODES) {
      const modeData = data[mode];
      if (!modeData) continue;

      // Index routes
      if (modeData.routes) {
        for (const feature of modeData.routes.features) {
          const props = feature.properties as Record<string, unknown>;
          const geom = feature.geometry as GeoJSON.LineString;
          const record: RouteRecord = {
            routeId: props.routeId as string,
            shortName: props.shortName as string,
            longName: props.longName as string,
            mode: mode,
            color: MODE_STYLES[mode].color,
            coordinates: geom.coordinates,
          };
          routeMap.set(record.routeId, record);
          shortNameToRoute.set(record.shortName, record);
        }
      }

      // Index stops
      if (modeData.stops) {
        for (const feature of modeData.stops.features) {
          const props = feature.properties as Record<string, unknown>;
          const geom = feature.geometry as GeoJSON.Point;
          let routes: string[] = [];
          try {
            const raw = props.routes;
            routes = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw as string[] : []);
          } catch {
            routes = [];
          }
          const record: StopRecord = {
            stopId: props.stopId as string,
            name: props.name as string,
            mode: mode,
            coordinates: geom.coordinates as [number, number],
            routes,
          };
          stopMap.set(record.stopId, record);
          allStops.push(record);
        }
      }
    }

    return { routeMap, shortNameToRoute, stopMap, allStops };
  }, [data]);

  const resolveRoute = useMemo(() => {
    return (routeId: string): RouteDetail | null => {
      const route = indexes.routeMap.get(routeId);
      if (!route) return null;

      // Find all stops that serve this route (by shortName match)
      const matchingStops = indexes.allStops.filter(
        (s) => s.routes.includes(route.shortName),
      );

      // Deduplicate by stop name (keep first occurrence — platforms are close together)
      const seenNames = new Set<string>();
      const uniqueStops: StopRecord[] = [];
      for (const stop of matchingStops) {
        if (!seenNames.has(stop.name)) {
          seenNames.add(stop.name);
          uniqueStops.push(stop);
        }
      }

      // Sort stops along the route geometry using projection
      const sorted = uniqueStops
        .map((stop) => ({
          stop,
          fraction: projectOntoLine(stop.coordinates, route.coordinates),
        }))
        .sort((a, b) => a.fraction - b.fraction);

      const stops: StopSummary[] = sorted.map(({ stop }) => ({
        stopId: stop.stopId,
        name: stop.name,
        coordinates: stop.coordinates,
      }));

      return {
        routeId: route.routeId,
        shortName: route.shortName,
        longName: route.longName,
        mode: route.mode,
        color: route.color,
        stops,
      };
    };
  }, [indexes]);

  const resolveStop = useMemo(() => {
    return (stopId: string): StopDetail | null => {
      const stop = indexes.stopMap.get(stopId);
      if (!stop) return null;

      // Find all routes serving this stop from the stop's routes array
      const routeNames = stop.routes;

      // Find cross-mode connections: stops at the same station across different modes.
      // Strategy: exact name match OR geographic proximity (within ~200m) for different modes.
      const stopNameLower = stop.name.trim().toLowerCase();
      const connectedStops = indexes.allStops.filter((s) => {
        if (s.stopId === stop.stopId) return false;
        // Same name (same station, possibly different platform or mode)
        if (s.name.trim().toLowerCase() === stopNameLower) return true;
        // Different mode and geographically close (within ~0.002 degrees ≈ 200m)
        if (s.mode !== stop.mode) {
          const dlng = s.coordinates[0] - stop.coordinates[0];
          const dlat = s.coordinates[1] - stop.coordinates[1];
          return (dlng * dlng + dlat * dlat) < 0.000004;
        }
        return false;
      });

      // Collect all route names grouped by mode
      const modeRouteMap = new Map<TransitMode, Set<string>>();

      // Add the clicked stop's own routes under its mode
      if (routeNames.length > 0) {
        modeRouteMap.set(stop.mode, new Set(routeNames));
      }

      // Add connected stops' routes under their modes
      for (const connected of connectedStops) {
        if (connected.routes.length === 0) continue;
        const existing = modeRouteMap.get(connected.mode) ?? new Set<string>();
        for (const r of connected.routes) {
          existing.add(r);
        }
        modeRouteMap.set(connected.mode, existing);
      }

      // Build the grouped output, ordered by mode priority
      const routesByMode: StopDetail['routesByMode'] = [];
      for (const mode of ALL_MODES) {
        const routes = modeRouteMap.get(mode);
        if (routes && routes.size > 0) {
          routesByMode.push({
            mode,
            label: MODE_LABELS[mode],
            routes: Array.from(routes).sort(),
          });
        }
      }

      return {
        stopId: stop.stopId,
        name: stop.name,
        mode: stop.mode,
        coordinates: stop.coordinates,
        routesByMode,
      };
    };
  }, [indexes]);

  /** Resolve a stopId from a stop name + mode (for panel stop list clicks) */
  const findStopByName = useMemo(() => {
    return (name: string, routeShortName: string): StopRecord | null => {
      // Find the first stop with this name that serves this route
      return indexes.allStops.find(
        (s) => s.name === name && s.routes.includes(routeShortName),
      ) ?? null;
    };
  }, [indexes]);

  return { resolveRoute, resolveStop, findStopByName };
}
