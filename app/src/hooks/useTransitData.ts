import { useEffect, useState } from 'react';
import type { TransitMode } from '../types/transit';

interface TransitGeoJSON {
  routes: GeoJSON.FeatureCollection | null;
  stops: GeoJSON.FeatureCollection | null;
}

type TransitDataMap = Partial<Record<TransitMode, TransitGeoJSON>>;

const MODES_TO_LOAD: TransitMode[] = [
  'light_rail', 'commuter_rail', 'streetcar', 'ferry', 'bus',
];

/**
 * Fetches GeoJSON route and stop data for all transit modes.
 * Returns a map of mode -> { routes, stops }.
 */
export function useTransitData(): { data: TransitDataMap; loading: boolean; error: string | null } {
  const [data, setData] = useState<TransitDataMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      const result: TransitDataMap = {};
      let failCount = 0;

      const promises = MODES_TO_LOAD.map(async (mode) => {
        try {
          const [routesResp, stopsResp] = await Promise.all([
            fetch(`/data/routes-${mode}.geojson`),
            fetch(`/data/stops-${mode}.geojson`),
          ]);

          const routes = routesResp.ok ? await routesResp.json() : null;
          const stops = stopsResp.ok ? await stopsResp.json() : null;

          if (!cancelled) {
            result[mode] = { routes, stops };
          }
        } catch {
          failCount++;
          result[mode] = { routes: null, stops: null };
        }
      });

      await Promise.all(promises);

      if (!cancelled) {
        setData(result);
        setLoading(false);
        if (failCount === MODES_TO_LOAD.length) {
          setError('Unable to load transit data. Please check your connection and reload.');
        }
      }
    }

    loadAll();
    return () => { cancelled = true; };
  }, []);

  return { data, loading, error };
}
