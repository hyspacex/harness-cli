import { useEffect, useRef, useState, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_STYLE, SEATTLE_CENTER, INITIAL_ZOOM, ALL_MODES, type TransitMode } from '../types/transit';
import { useMapLayers, getLayerIdsForMode, getAllRouteLayerIds, getAllHighlightLayerIds } from '../hooks/useMapLayers';
import { useMapInteractions } from '../hooks/useMapInteractions';
import { useTransitContext } from '../context/TransitContext';

interface TransitGeoJSON {
  routes: GeoJSON.FeatureCollection | null;
  stops: GeoJSON.FeatureCollection | null;
}

type TransitDataMap = Partial<Record<TransitMode, TransitGeoJSON>>;

export interface MapContainerHandle {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  setSelectedStopMarker: (lng: number, lat: number) => void;
  clearSelectedStopMarker: () => void;
  /** Highlight specific routes by routeId (AI-driven). Pass empty array to clear. */
  highlightRoutes: (routeIds: string[]) => void;
  /** Show markers at multiple stop locations (AI-driven) */
  showStopMarkers: (stops: Array<{ lng: number; lat: number; name: string }>) => void;
  /** Clear all AI-driven highlights and markers */
  clearAiHighlights: () => void;
}

interface Props {
  data: TransitDataMap;
}

function createMarkerElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.width = '20px';
  el.style.height = '20px';
  el.style.borderRadius = '50%';
  el.style.border = '3px solid #1a73e8';
  el.style.backgroundColor = 'rgba(26, 115, 232, 0.25)';
  el.style.boxShadow = '0 0 0 4px rgba(26, 115, 232, 0.15)';
  el.style.pointerEvents = 'none';
  return el;
}

function createAiMarkerElement(name: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.alignItems = 'center';
  el.style.pointerEvents = 'none';

  const dot = document.createElement('div');
  dot.style.width = '14px';
  dot.style.height = '14px';
  dot.style.borderRadius = '50%';
  dot.style.border = '2.5px solid #e53e3e';
  dot.style.backgroundColor = 'rgba(229, 62, 62, 0.3)';
  dot.style.boxShadow = '0 0 0 3px rgba(229, 62, 62, 0.15)';
  el.appendChild(dot);

  if (name) {
    const label = document.createElement('div');
    label.textContent = name;
    label.style.fontSize = '11px';
    label.style.fontWeight = '600';
    label.style.color = '#333';
    label.style.backgroundColor = 'rgba(255,255,255,0.92)';
    label.style.padding = '1px 5px';
    label.style.borderRadius = '3px';
    label.style.marginTop = '2px';
    label.style.whiteSpace = 'nowrap';
    label.style.boxShadow = '0 1px 3px rgba(0,0,0,0.12)';
    el.appendChild(label);
  }

  return el;
}

const MapContainer = forwardRef<MapContainerHandle, Props>(function MapContainer({ data }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const aiMarkersRef = useRef<maplibregl.Marker[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  const {
    visibleModes,
    hoveredRouteId,
    selectedRouteId,
    setHoveredRouteId,
    selectRoute,
    selectStop,
    clearSelection,
  } = useTransitContext();

  // Initialize map
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: SEATTLE_CENTER,
      zoom: INITIAL_ZOOM,
      minZoom: 7,
      maxZoom: 18,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      setMapLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Add layers when data and map are ready
  const layersReady = useMapLayers(mapRef.current, data, mapLoaded);

  // Expose imperative handle for parent
  useImperativeHandle(ref, () => ({
    flyTo: (lng: number, lat: number, zoom?: number) => {
      mapRef.current?.flyTo({
        center: [lng, lat],
        zoom: zoom ?? 15,
        duration: 800,
      });
    },
    setSelectedStopMarker: (lng: number, lat: number) => {
      if (markerRef.current) {
        markerRef.current.remove();
      }
      if (mapRef.current) {
        markerRef.current = new maplibregl.Marker({ element: createMarkerElement() })
          .setLngLat([lng, lat])
          .addTo(mapRef.current);
      }
    },
    clearSelectedStopMarker: () => {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
    },
    highlightRoutes: (routeIds: string[]) => {
      const map = mapRef.current;
      if (!map) return;

      const allRouteLayers = getAllRouteLayerIds();
      const allHighlightLayers = getAllHighlightLayerIds();

      if (routeIds.length === 0) {
        // Clear AI highlights: restore normal opacity
        for (const layerId of allRouteLayers) {
          if (map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'line-opacity', 0.85);
          }
        }
        for (const hlId of allHighlightLayers) {
          if (map.getLayer(hlId)) {
            map.setFilter(hlId, ['==', ['get', 'routeId'], '']);
            map.setPaintProperty(hlId, 'line-opacity', 0);
          }
        }
        return;
      }

      // Dim all routes
      for (const layerId of allRouteLayers) {
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, 'line-opacity', 0.15);
        }
      }

      // Highlight matching routes across all highlight layers
      const filterExpr: maplibregl.FilterSpecification =
        routeIds.length === 1
          ? ['==', ['get', 'routeId'], routeIds[0]]
          : ['in', ['get', 'routeId'], ['literal', routeIds]];

      for (const hlId of allHighlightLayers) {
        if (map.getLayer(hlId)) {
          map.setFilter(hlId, filterExpr);
          map.setPaintProperty(hlId, 'line-opacity', 1);
        }
      }
    },
    showStopMarkers: (stops: Array<{ lng: number; lat: number; name: string }>) => {
      // Remove existing AI markers
      for (const m of aiMarkersRef.current) {
        m.remove();
      }
      aiMarkersRef.current = [];

      const map = mapRef.current;
      if (!map) return;

      for (const stop of stops) {
        const marker = new maplibregl.Marker({ element: createAiMarkerElement(stop.name) })
          .setLngLat([stop.lng, stop.lat])
          .addTo(map);
        aiMarkersRef.current.push(marker);
      }
    },
    clearAiHighlights: () => {
      const map = mapRef.current;
      if (!map) return;

      // Clear route highlights
      const allRouteLayers = getAllRouteLayerIds();
      const allHighlightLayers = getAllHighlightLayerIds();

      for (const layerId of allRouteLayers) {
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, 'line-opacity', 0.85);
        }
      }
      for (const hlId of allHighlightLayers) {
        if (map.getLayer(hlId)) {
          map.setFilter(hlId, ['==', ['get', 'routeId'], '']);
          map.setPaintProperty(hlId, 'line-opacity', 0);
        }
      }

      // Remove AI markers
      for (const m of aiMarkersRef.current) {
        m.remove();
      }
      aiMarkersRef.current = [];
    },
  }), []);

  // Interaction callbacks
  const onStopClick = useCallback((feature: maplibregl.MapGeoJSONFeature, lngLat: maplibregl.LngLat) => {
    const props = feature.properties;
    if (!props) return;
    const stopId = props.stopId as string;
    if (stopId) {
      selectStop(stopId);
      // Fly to stop and show marker
      mapRef.current?.flyTo({
        center: [lngLat.lng, lngLat.lat],
        zoom: Math.max(mapRef.current.getZoom(), 14),
        duration: 600,
      });
      if (markerRef.current) markerRef.current.remove();
      if (mapRef.current) {
        markerRef.current = new maplibregl.Marker({ element: createMarkerElement() })
          .setLngLat([lngLat.lng, lngLat.lat])
          .addTo(mapRef.current);
      }
    }
  }, [selectStop]);

  const onBackgroundClick = useCallback(() => {
    clearSelection();
    if (markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
    }
  }, [clearSelection]);

  const callbacks = useMemo(() => ({
    onHoverRoute: setHoveredRouteId,
    onClickRoute: (routeId: string | null) => {
      selectRoute(routeId);
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
    },
    onClickStop: onStopClick,
    onClickBackground: onBackgroundClick,
  }), [setHoveredRouteId, selectRoute, onStopClick, onBackgroundClick]);

  useMapInteractions(
    mapRef.current,
    layersReady,
    hoveredRouteId,
    selectedRouteId,
    callbacks,
  );

  // Toggle layer visibility when visibleModes changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    for (const mode of ALL_MODES) {
      const layerIds = getLayerIdsForMode(mode);
      const visible = visibleModes.has(mode);
      for (const layerId of layerIds) {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
        }
      }
    }
  }, [visibleModes, mapLoaded]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});

export default MapContainer;
