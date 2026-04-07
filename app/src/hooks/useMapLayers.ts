import { useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import {
  type TransitMode,
  MODE_STYLES,
  STOP_COLORS,
  RAIL_FERRY_MODES,
  RAPIDRIDE_NAMES,
} from '../types/transit';

interface TransitGeoJSON {
  routes: GeoJSON.FeatureCollection | null;
  stops: GeoJSON.FeatureCollection | null;
}

type TransitDataMap = Partial<Record<TransitMode, TransitGeoJSON>>;

function routeLayerId(mode: TransitMode, suffix?: string): string {
  return suffix ? `routes-${mode}-${suffix}` : `routes-${mode}`;
}
function stopLayerId(mode: TransitMode): string {
  return `stops-${mode}`;
}
function stopLabelLayerId(mode: TransitMode): string {
  return `stops-${mode}-labels`;
}

/** All route layer IDs (for interactions) */
export function getAllRouteLayerIds(): string[] {
  const ids: string[] = [];
  for (const { mode } of RAIL_FERRY_MODES) {
    ids.push(routeLayerId(mode));
  }
  ids.push('routes-bus-rapid', 'routes-bus-regular');
  return ids;
}

/** All highlight layer IDs */
export function getAllHighlightLayerIds(): string[] {
  const ids: string[] = [];
  for (const { mode } of RAIL_FERRY_MODES) {
    ids.push(routeLayerId(mode, 'highlight'));
  }
  ids.push('routes-bus-rapid-highlight', 'routes-bus-regular-highlight');
  return ids;
}

/** All stop layer IDs (for interactions) */
export function getAllStopLayerIds(): string[] {
  const ids: string[] = [];
  for (const { mode } of RAIL_FERRY_MODES) {
    ids.push(stopLayerId(mode));
  }
  ids.push('stops-bus');
  return ids;
}

/** Mode -> list of layer IDs that belong to it (routes + highlights + stops + labels) */
export function getLayerIdsForMode(mode: TransitMode): string[] {
  if (mode === 'bus') {
    return [
      'routes-bus-rapid', 'routes-bus-rapid-highlight',
      'routes-bus-regular', 'routes-bus-regular-highlight',
      'stops-bus', 'stops-bus-labels',
    ];
  }
  return [
    routeLayerId(mode),
    routeLayerId(mode, 'highlight'),
    stopLayerId(mode),
    stopLabelLayerId(mode),
  ];
}

function addRouteLayer(
  map: maplibregl.Map,
  id: string,
  source: string,
  style: { color: string; width: number; dasharray?: number[] },
  minzoom: number,
  filter?: maplibregl.FilterSpecification,
) {
  const paint: Record<string, unknown> = {
    'line-color': style.color,
    'line-width': style.width,
    'line-opacity': 0.85,
  };
  if (style.dasharray) {
    paint['line-dasharray'] = style.dasharray;
  }

  map.addLayer({
    id,
    type: 'line',
    source,
    minzoom,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint,
    ...(filter ? { filter } : {}),
  } as maplibregl.LayerSpecification);
}

function addHighlightLayer(
  map: maplibregl.Map,
  id: string,
  source: string,
  style: { color: string; width: number; dasharray?: number[] },
  minzoom: number,
) {
  const paint: Record<string, unknown> = {
    'line-color': style.color,
    'line-width': style.width + 2,
    'line-opacity': 0,
  };
  if (style.dasharray) {
    paint['line-dasharray'] = style.dasharray;
  }

  // Highlight layers start hidden (filter matches nothing).
  // For bus highlight layers, the source filter (RapidRide vs regular)
  // is baked into the highlight filter update logic in useMapInteractions.
  map.addLayer({
    id,
    type: 'line',
    source,
    minzoom,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint,
    filter: ['==', ['get', 'routeId'], ''] as maplibregl.FilterSpecification,
  } as maplibregl.LayerSpecification);
}

function addStopLayer(
  map: maplibregl.Map,
  id: string,
  source: string,
  color: string,
  minzoom: number,
) {
  map.addLayer({
    id,
    type: 'circle',
    source,
    minzoom,
    paint: {
      'circle-radius': 4,
      'circle-color': color,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    },
  } as maplibregl.LayerSpecification);
}

function addStopLabelLayer(
  map: maplibregl.Map,
  id: string,
  source: string,
  minzoom: number,
) {
  map.addLayer({
    id,
    type: 'symbol',
    source,
    minzoom,
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#333',
      'text-halo-color': '#fff',
      'text-halo-width': 1.5,
    },
  } as maplibregl.LayerSpecification);
}

/** RapidRide route filter */
const RAPIDRIDE_SHORT_NAMES = Array.from(RAPIDRIDE_NAMES);
const rapidRideRouteFilter: maplibregl.FilterSpecification = [
  'in', ['get', 'shortName'], ['literal', RAPIDRIDE_SHORT_NAMES],
];
const regularBusRouteFilter: maplibregl.FilterSpecification = [
  '!', ['in', ['get', 'shortName'], ['literal', RAPIDRIDE_SHORT_NAMES]],
];

/**
 * Adds all transit layers to the map once data is available.
 * Bus routes use split layers for RapidRide (zoom 11+) vs regular (zoom 13+).
 */
export function useMapLayers(
  map: maplibregl.Map | null,
  data: TransitDataMap,
  mapLoaded: boolean,
): boolean {
  const layersAddedRef = useRef(false);
  const [layersReady, setLayersReady] = useState(false);

  useEffect(() => {
    if (!map || !mapLoaded || layersAddedRef.current) return;
    if (Object.keys(data).length === 0) return;

    layersAddedRef.current = true;

    // Non-bus modes
    for (const { mode, minZoomRoutes, minZoomStops } of RAIL_FERRY_MODES) {
      const modeData = data[mode];
      if (!modeData) continue;

      const style = MODE_STYLES[mode];
      const srcRoutes = `routes-${mode}`;
      const srcStops = `stops-${mode}`;

      if (modeData.routes) {
        map.addSource(srcRoutes, { type: 'geojson', data: modeData.routes });
        addRouteLayer(map, routeLayerId(mode), srcRoutes, style, minZoomRoutes);
        addHighlightLayer(map, routeLayerId(mode, 'highlight'), srcRoutes, style, minZoomRoutes);
      }

      if (modeData.stops) {
        map.addSource(srcStops, { type: 'geojson', data: modeData.stops });
        addStopLayer(map, stopLayerId(mode), srcStops, STOP_COLORS[mode], minZoomStops);
        addStopLabelLayer(map, stopLabelLayerId(mode), srcStops, minZoomStops);
      }
    }

    // Bus mode: split into RapidRide (zoom 11+) and regular (zoom 13+)
    const busData = data.bus;
    if (busData) {
      const busStyle = MODE_STYLES.bus;

      if (busData.routes) {
        map.addSource('routes-bus', { type: 'geojson', data: busData.routes });
        addRouteLayer(map, 'routes-bus-rapid', 'routes-bus', busStyle, 11, rapidRideRouteFilter);
        addHighlightLayer(map, 'routes-bus-rapid-highlight', 'routes-bus', busStyle, 11);
        addRouteLayer(map, 'routes-bus-regular', 'routes-bus', busStyle, 13, regularBusRouteFilter);
        addHighlightLayer(map, 'routes-bus-regular-highlight', 'routes-bus', busStyle, 13);
      }

      if (busData.stops) {
        map.addSource('stops-bus', { type: 'geojson', data: busData.stops });
        // All bus stops at zoom 13+ (when all bus routes are visible)
        addStopLayer(map, 'stops-bus', 'stops-bus', STOP_COLORS.bus, 13);
        addStopLabelLayer(map, 'stops-bus-labels', 'stops-bus', 14);
      }
    }

    setLayersReady(true);
  }, [map, data, mapLoaded]);

  return layersReady;
}
