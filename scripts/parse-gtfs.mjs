#!/usr/bin/env node

/**
 * GTFS Parse Script
 *
 * Downloads and parses King County Metro and Sound Transit GTFS static feeds,
 * producing GeoJSON files for routes (LineStrings from shapes.txt) and stops
 * (Points from stops.txt), split by transit mode.
 *
 * Feeds used:
 *   - King County Metro: http://metro.kingcounty.gov/GTFS/google_transit.zip
 *     Covers: Metro bus routes, Seattle Streetcar (SLU, First Hill), Water Taxi,
 *     Link Light Rail (1 Line, 2 Line), some ST Express
 *   - Sound Transit: https://www.soundtransit.org/GTFS-rail/40_gtfs.zip
 *     Covers: Link Light Rail (1 Line, 2 Line, T Line), Sounder commuter rail,
 *     ST Express buses
 *
 * Output: public/data/*.geojson
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { Open } from 'unzipper';

const OUTPUT_DIR = join(import.meta.dirname, '..', 'public', 'data');

// GTFS route_type values (per GTFS spec)
const ROUTE_TYPE = {
  TRAM_STREETCAR: 0,    // Streetcar, Light rail
  SUBWAY_METRO: 1,      // Subway, Metro
  RAIL: 2,              // Commuter rail (Sounder)
  BUS: 3,               // Bus
  FERRY: 4,             // Ferry (Water Taxi)
  CABLE_TRAM: 5,
  AERIAL_LIFT: 6,
  FUNICULAR: 7,
  TROLLEYBUS: 11,
  MONORAIL: 12,
};

// Transit mode classification
// GTFS route_type 0 = Tram/Streetcar/Light Rail, 2 = Rail (Sounder), 3 = Bus, 4 = Ferry
// We further classify route_type 0 into "light_rail" vs "streetcar" based on route names
function classifyMode(routeType, routeShortName, routeLongName) {
  const rt = Number(routeType);
  const name = `${routeShortName} ${routeLongName}`.toLowerCase();

  if (rt === ROUTE_TYPE.FERRY) return 'ferry';
  if (rt === ROUTE_TYPE.RAIL) return 'commuter_rail';
  if (rt === ROUTE_TYPE.BUS) return 'bus';
  if (rt === ROUTE_TYPE.TRAM_STREETCAR || rt === ROUTE_TYPE.SUBWAY_METRO) {
    // Distinguish streetcar from light rail
    if (name.includes('streetcar') || name.includes('south lake union') || name.includes('first hill')) {
      return 'streetcar';
    }
    return 'light_rail';
  }
  // Extended GTFS types
  if (rt >= 100 && rt <= 199) return 'commuter_rail'; // Railway Service
  if (rt >= 200 && rt <= 299) return 'bus';           // Coach Service
  if (rt >= 400 && rt <= 499) return 'light_rail';    // Urban Railway Service
  if (rt >= 700 && rt <= 799) return 'bus';           // Bus Service
  if (rt >= 900 && rt <= 999) return 'light_rail';    // Tram Service
  if (rt >= 1000 && rt <= 1099) return 'ferry';       // Water Transport
  if (rt >= 1200 && rt <= 1299) return 'ferry';       // Ferry Service

  return 'bus'; // default fallback
}

// Display name overrides for routes where GTFS data uses numeric codes
// instead of descriptive names (e.g., KC Metro Water Taxi routes)
const DISPLAY_NAME_OVERRIDES = {
  '973': 'West Seattle Water Taxi',
  '975': 'Vashon Island Water Taxi',
};

// Colors per mode
const MODE_COLORS = {
  light_rail: '#00A651',    // Link green
  commuter_rail: '#6D3A8E', // Sounder purple
  streetcar: '#E8601C',     // Streetcar orange
  ferry: '#1B5E9E',         // Ferry navy blue
  bus: '#888888',           // Bus gray (not used in F01 but kept for pipeline)
};

const FEEDS = [
  {
    name: 'King County Metro',
    url: 'http://metro.kingcounty.gov/GTFS/google_transit.zip',
    agency: 'kcm',
  },
  {
    name: 'Sound Transit',
    url: 'https://www.soundtransit.org/GTFS-rail/40_gtfs.zip',
    agency: 'st',
  },
];

async function downloadFeed(feedUrl, destPath) {
  console.log(`  Downloading: ${feedUrl}`);
  const response = await fetch(feedUrl, {
    headers: { 'User-Agent': 'seattle-transit-map/1.0' },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${feedUrl}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(destPath, buffer);
  console.log(`  Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
}

async function parseCsvFromZip(zipPath, fileName) {
  const directory = await Open.file(zipPath);
  const entry = directory.files.find(f => f.path === fileName);
  if (!entry) {
    console.warn(`  Warning: ${fileName} not found in ZIP`);
    return [];
  }

  const rows = [];
  const stream = entry.stream();
  const parser = stream.pipe(parse({ columns: true, skip_empty_lines: true, trim: true, bom: true }));

  for await (const row of parser) {
    rows.push(row);
  }
  return rows;
}

async function processFeed(feed) {
  const tmpPath = join(tmpdir(), `gtfs-${feed.agency}.zip`);

  try {
    await downloadFeed(feed.url, tmpPath);
  } catch (err) {
    console.error(`\nError downloading ${feed.name} GTFS feed:`);
    console.error(`  URL: ${feed.url}`);
    console.error(`  ${err.message}`);
    console.error(`  Skipping ${feed.name} feed. Some transit data may be missing.\n`);
    return null;
  }

  console.log(`  Parsing ${feed.name} GTFS data...`);

  const [routes, trips, shapes, stops, stopTimes] = await Promise.all([
    parseCsvFromZip(tmpPath, 'routes.txt'),
    parseCsvFromZip(tmpPath, 'trips.txt'),
    parseCsvFromZip(tmpPath, 'shapes.txt'),
    parseCsvFromZip(tmpPath, 'stops.txt'),
    parseCsvFromZip(tmpPath, 'stop_times.txt'),
  ]);

  console.log(`  Routes: ${routes.length}, Trips: ${trips.length}, Shapes: ${shapes.length} points, Stops: ${stops.length}, StopTimes: ${stopTimes.length}`);

  // Build route lookup: route_id -> route info
  const routeMap = new Map();
  for (const r of routes) {
    const mode = classifyMode(r.route_type, r.route_short_name || '', r.route_long_name || '');
    const shortName = r.route_short_name || '';
    const displayName = DISPLAY_NAME_OVERRIDES[shortName] || '';
    routeMap.set(r.route_id, {
      routeId: `${feed.agency}:${r.route_id}`,
      shortName: displayName || shortName,
      longName: r.route_long_name || '',
      color: r.route_color ? `#${r.route_color}` : MODE_COLORS[mode],
      textColor: r.route_text_color ? `#${r.route_text_color}` : '#FFFFFF',
      type: Number(r.route_type),
      mode,
      agency: feed.agency,
    });
  }

  // Build shape lookup: shape_id -> [[lon, lat], ...]
  const shapeMap = new Map();
  for (const s of shapes) {
    const id = s.shape_id;
    if (!shapeMap.has(id)) shapeMap.set(id, []);
    shapeMap.get(id).push({
      seq: Number(s.shape_pt_sequence),
      lat: Number(s.shape_pt_lat),
      lon: Number(s.shape_pt_lon),
    });
  }
  // Sort each shape by sequence
  for (const [, pts] of shapeMap) {
    pts.sort((a, b) => a.seq - b.seq);
  }

  // Build trip -> route and trip -> shape mappings
  // Pick one representative shape per route (the longest one)
  const routeShapes = new Map(); // route_id -> shape_id (best)
  const routeShapeLengths = new Map(); // route_id -> best shape point count
  const tripRouteMap = new Map(); // trip_id -> route_id

  for (const t of trips) {
    tripRouteMap.set(t.trip_id, t.route_id);
    if (t.shape_id && shapeMap.has(t.shape_id)) {
      const pts = shapeMap.get(t.shape_id);
      const current = routeShapeLengths.get(t.route_id) || 0;
      if (pts.length > current) {
        routeShapes.set(t.route_id, t.shape_id);
        routeShapeLengths.set(t.route_id, pts.length);
      }
    }
  }

  // Build stop -> routes mapping using stop_times + trips
  const stopRoutes = new Map(); // stop_id -> Set of route_id
  for (const st of stopTimes) {
    const routeId = tripRouteMap.get(st.trip_id);
    if (routeId) {
      if (!stopRoutes.has(st.stop_id)) stopRoutes.set(st.stop_id, new Set());
      stopRoutes.get(st.stop_id).add(routeId);
    }
  }

  // Build route GeoJSON features
  const routeFeatures = [];
  for (const [routeId, info] of routeMap) {
    const shapeId = routeShapes.get(routeId);
    if (!shapeId) continue;
    const pts = shapeMap.get(shapeId);
    if (!pts || pts.length < 2) continue;

    routeFeatures.push({
      type: 'Feature',
      properties: {
        routeId: info.routeId,
        shortName: info.shortName,
        longName: info.longName,
        color: info.color,
        textColor: info.textColor,
        mode: info.mode,
        agency: info.agency,
        routeType: info.type,
      },
      geometry: {
        type: 'LineString',
        coordinates: pts.map(p => [p.lon, p.lat]),
      },
    });
  }

  // Build stop GeoJSON features
  const stopFeatures = [];
  for (const s of stops) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (isNaN(lat) || isNaN(lon)) continue;

    // Get routes serving this stop
    const routeIds = stopRoutes.get(s.stop_id);
    const routeNames = [];
    const routeModes = new Set();
    if (routeIds) {
      for (const rid of routeIds) {
        const rInfo = routeMap.get(rid);
        if (rInfo) {
          const displayName = rInfo.shortName || rInfo.longName;
          if (displayName && !routeNames.includes(displayName)) {
            routeNames.push(displayName);
          }
          routeModes.add(rInfo.mode);
        }
      }
    }

    // Determine the stop's primary mode (highest priority)
    let stopMode = 'bus';
    if (routeModes.has('light_rail')) stopMode = 'light_rail';
    else if (routeModes.has('commuter_rail')) stopMode = 'commuter_rail';
    else if (routeModes.has('streetcar')) stopMode = 'streetcar';
    else if (routeModes.has('ferry')) stopMode = 'ferry';

    stopFeatures.push({
      type: 'Feature',
      properties: {
        stopId: `${feed.agency}:${s.stop_id}`,
        name: s.stop_name || 'Unknown Stop',
        mode: stopMode,
        routes: routeNames,
        agency: feed.agency,
        locationType: Number(s.location_type || 0),
      },
      geometry: {
        type: 'Point',
        coordinates: [lon, lat],
      },
    });
  }

  return { routeFeatures, stopFeatures, routeMap };
}

function splitByMode(features, featureType) {
  const byMode = {};
  for (const f of features) {
    const mode = f.properties.mode;
    if (!byMode[mode]) byMode[mode] = [];
    byMode[mode].push(f);
  }
  return byMode;
}

async function main() {
  console.log('Seattle Transit Map - GTFS Data Pipeline\n');
  console.log('========================================\n');

  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const allRouteFeatures = [];
  const allStopFeatures = [];
  let successCount = 0;

  for (const feed of FEEDS) {
    console.log(`\nProcessing ${feed.name}...`);
    const result = await processFeed(feed);
    if (result) {
      allRouteFeatures.push(...result.routeFeatures);
      allStopFeatures.push(...result.stopFeatures);
      successCount++;
    }
  }

  if (successCount === 0) {
    console.error('\nFATAL: No GTFS feeds could be downloaded. Cannot generate transit data.');
    console.error('Check your internet connection and try again.');
    process.exit(1);
  }

  if (successCount < FEEDS.length) {
    console.warn(`\nWarning: Only ${successCount} of ${FEEDS.length} feeds were processed. Some transit data may be incomplete.`);
  }

  // Split routes and stops by mode
  const routesByMode = splitByMode(allRouteFeatures);
  const stopsByMode = splitByMode(allStopFeatures);

  // Exclude bus routes from the output files used in F01
  // (Bus routes are deferred to F02 but we still save them for future use)
  const modes = ['light_rail', 'commuter_rail', 'streetcar', 'ferry', 'bus'];

  console.log('\n--- Output Summary ---');

  for (const mode of modes) {
    const routeCount = (routesByMode[mode] || []).length;
    const stopCount = (stopsByMode[mode] || []).length;

    if (routeCount > 0 || stopCount > 0) {
      // Write routes GeoJSON
      const routesGeoJSON = {
        type: 'FeatureCollection',
        features: routesByMode[mode] || [],
      };
      const routesPath = join(OUTPUT_DIR, `routes-${mode}.geojson`);
      writeFileSync(routesPath, JSON.stringify(routesGeoJSON));
      console.log(`  routes-${mode}.geojson: ${routeCount} routes (${(JSON.stringify(routesGeoJSON).length / 1024).toFixed(0)} KB)`);

      // Write stops GeoJSON
      const stopsGeoJSON = {
        type: 'FeatureCollection',
        features: stopsByMode[mode] || [],
      };
      const stopsPath = join(OUTPUT_DIR, `stops-${mode}.geojson`);
      writeFileSync(stopsPath, JSON.stringify(stopsGeoJSON));
      console.log(`  stops-${mode}.geojson: ${stopCount} stops (${(JSON.stringify(stopsGeoJSON).length / 1024).toFixed(0)} KB)`);
    }
  }

  // Also write a combined non-bus routes file for convenience
  const nonBusRoutes = allRouteFeatures.filter(f => f.properties.mode !== 'bus');
  const nonBusStops = allStopFeatures.filter(f => f.properties.mode !== 'bus');

  const combinedRoutes = {
    type: 'FeatureCollection',
    features: nonBusRoutes,
  };
  writeFileSync(join(OUTPUT_DIR, 'routes-rail-ferry.geojson'), JSON.stringify(combinedRoutes));

  const combinedStops = {
    type: 'FeatureCollection',
    features: nonBusStops,
  };
  writeFileSync(join(OUTPUT_DIR, 'stops-rail-ferry.geojson'), JSON.stringify(combinedStops));

  console.log(`\n  routes-rail-ferry.geojson: ${nonBusRoutes.length} routes (combined non-bus)`);
  console.log(`  stops-rail-ferry.geojson: ${nonBusStops.length} stops (combined non-bus)`);

  console.log('\n========================================');
  console.log(`GTFS pipeline complete. ${allRouteFeatures.length} total routes, ${allStopFeatures.length} total stops.`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
}

main().catch(err => {
  console.error('\nFATAL: GTFS pipeline failed:');
  console.error(`  ${err.message}`);
  process.exit(1);
});
