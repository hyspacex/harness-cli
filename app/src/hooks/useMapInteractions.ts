import { useEffect, useRef, useCallback, type MutableRefObject } from 'react';
import maplibregl from 'maplibre-gl';
import { getAllRouteLayerIds, getAllHighlightLayerIds, getAllStopLayerIds } from './useMapLayers';
import { MODE_LABELS, type TransitMode } from '../types/transit';

interface InteractionCallbacks {
  onHoverRoute: (routeId: string | null) => void;
  onClickRoute: (routeId: string | null) => void;
  onClickStop: (feature: maplibregl.MapGeoJSONFeature, lngLat: maplibregl.LngLat) => void;
  onClickBackground: () => void;
}

/**
 * Sets up hover/click interactions on route and stop layers.
 * Updates highlight layers to visually distinguish hovered/selected routes.
 */
export function useMapInteractions(
  map: maplibregl.Map | null,
  mapLoaded: boolean,
  hoveredRouteId: string | null,
  selectedRouteId: string | null,
  callbacks: InteractionCallbacks,
) {
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  // Keep refs in sync
  selectedRef.current = selectedRouteId;

  const updateHighlights = useCallback((mapInst: maplibregl.Map, hovered: string | null, clicked: string | null) => {
    const activeId = clicked || hovered;
    const allRouteLayers = getAllRouteLayerIds();
    const allHighlightLayers = getAllHighlightLayerIds();

    for (const layerId of allRouteLayers) {
      if (!mapInst.getLayer(layerId)) continue;
      mapInst.setPaintProperty(layerId, 'line-opacity', activeId ? 0.15 : 0.85);
    }

    for (const hlId of allHighlightLayers) {
      if (!mapInst.getLayer(hlId)) continue;
      if (activeId) {
        mapInst.setFilter(hlId, ['==', ['get', 'routeId'], activeId]);
        mapInst.setPaintProperty(hlId, 'line-opacity', 1);
      } else {
        mapInst.setFilter(hlId, ['==', ['get', 'routeId'], '']);
        mapInst.setPaintProperty(hlId, 'line-opacity', 0);
      }
    }
  }, []);

  useEffect(() => {
    if (!map || !mapLoaded) return;

    const routeLayerIds = getAllRouteLayerIds();
    const stopLayerIds = getAllStopLayerIds();
    const allInteractiveLayers = [...routeLayerIds, ...stopLayerIds];

    const handlers: Array<{ event: string; layer?: string; handler: (...args: unknown[]) => void }> = [];

    function on(event: string, layerOrHandler: string | ((...args: unknown[]) => void), handler?: (...args: unknown[]) => void) {
      if (typeof layerOrHandler === 'string' && handler) {
        map!.on(event as 'mouseenter', layerOrHandler, handler as (e: maplibregl.MapMouseEvent) => void);
        handlers.push({ event, layer: layerOrHandler, handler: handler as (...args: unknown[]) => void });
      } else if (typeof layerOrHandler === 'function') {
        map!.on(event as 'click', layerOrHandler as (e: maplibregl.MapMouseEvent) => void);
        handlers.push({ event, handler: layerOrHandler as (...args: unknown[]) => void });
      }
    }

    // Route hover and click
    for (const layerId of routeLayerIds) {
      on('mouseenter', layerId, () => {
        map!.getCanvas().style.cursor = 'pointer';
      });

      on('mousemove', layerId, (e: unknown) => {
        const ev = e as maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] };
        if (ev.features && ev.features.length > 0) {
          const routeId = ev.features[0].properties?.routeId as string | undefined;
          if (routeId && routeId !== hoveredRef.current) {
            hoveredRef.current = routeId;
            callbacks.onHoverRoute(routeId);
            updateHighlights(map!, routeId, selectedRef.current);
          }
        }
      });

      on('mouseleave', layerId, () => {
        map!.getCanvas().style.cursor = '';
        hoveredRef.current = null;
        callbacks.onHoverRoute(null);
        updateHighlights(map!, null, selectedRef.current);
      });

      on('click', layerId, (e: unknown) => {
        const ev = e as maplibregl.MapMouseEvent;
        ev.preventDefault();
        const features = map!.queryRenderedFeatures(ev.point, { layers: [layerId] });
        if (features.length > 0) {
          const routeId = features[0].properties?.routeId as string | undefined;
          if (routeId) {
            const newSelected = selectedRef.current === routeId ? null : routeId;
            selectedRef.current = newSelected;
            callbacks.onClickRoute(newSelected);
            updateHighlights(map!, hoveredRef.current, newSelected);
          }
        }
      });
    }

    // Stop hover and click
    for (const layerId of stopLayerIds) {
      on('mouseenter', layerId, () => {
        map!.getCanvas().style.cursor = 'pointer';
      });

      on('mouseleave', layerId, () => {
        map!.getCanvas().style.cursor = '';
      });

      on('click', layerId, (e: unknown) => {
        const ev = e as maplibregl.MapMouseEvent;
        ev.preventDefault();
        const features = map!.queryRenderedFeatures(ev.point, { layers: [layerId] });
        if (features.length > 0) {
          callbacks.onClickStop(features[0], ev.lngLat);
        }
      });
    }

    // Background click clears selection
    on('click', (e: unknown) => {
      const ev = e as maplibregl.MapMouseEvent;
      const features = map!.queryRenderedFeatures(ev.point, { layers: allInteractiveLayers });
      if (features.length === 0) {
        selectedRef.current = null;
        callbacks.onClickBackground();
        updateHighlights(map!, hoveredRef.current, null);
      }
    });

    return () => {
      for (const { event, layer, handler } of handlers) {
        if (layer) {
          map!.off(event as 'mouseenter', layer, handler as (e: maplibregl.MapMouseEvent) => void);
        } else {
          map!.off(event as 'click', handler as (e: maplibregl.MapMouseEvent) => void);
        }
      }
    };
  }, [map, mapLoaded, callbacks, updateHighlights]);

  // Sync external highlight state changes
  useEffect(() => {
    if (!map || !mapLoaded) return;
    updateHighlights(map, hoveredRouteId, selectedRouteId);
  }, [map, mapLoaded, hoveredRouteId, selectedRouteId, updateHighlights]);
}

/** Show a popup for a clicked stop */
export function showStopPopup(
  map: maplibregl.Map,
  popupRef: MutableRefObject<maplibregl.Popup | null>,
  feature: maplibregl.MapGeoJSONFeature,
  lngLat: maplibregl.LngLat,
) {
  const props = feature.properties;
  if (!props) return;

  const name = props.name || 'Unknown Stop';
  const mode = (props.mode || '') as TransitMode;
  const modeLabel = MODE_LABELS[mode] || mode.replace('_', ' ');

  let routes: string[] = [];
  try {
    const raw = props.routes;
    routes = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch {
    routes = [];
  }

  const routeList = routes.length > 0
    ? routes.map((r: string) => `<li>${escapeHtml(r)}</li>`).join('')
    : '<li><em>No route data available</em></li>';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 220px;">
      <h3 style="margin: 0 0 6px 0; font-size: 14px; color: #222;">${escapeHtml(name)}</h3>
      <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">
        ${escapeHtml(modeLabel)}
      </div>
      <div style="font-size: 12px; color: #444;">
        <strong>Routes:</strong>
        <ul style="margin: 4px 0 0 16px; padding: 0;">${routeList}</ul>
      </div>
    </div>
  `;

  if (popupRef.current) {
    popupRef.current.remove();
  }

  const popup = new maplibregl.Popup({ closeOnClick: true, maxWidth: '260px' })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);

  popupRef.current = popup;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
