/** Core transit domain types */

export type TransitMode = 'light_rail' | 'commuter_rail' | 'streetcar' | 'ferry' | 'bus';

/** Display labels for each transit mode */
export const MODE_LABELS: Record<TransitMode, string> = {
  light_rail: 'Light Rail',
  commuter_rail: 'Commuter Rail',
  streetcar: 'Streetcar',
  ferry: 'Ferry',
  bus: 'Bus',
};

/** Visual style for a transit mode's route lines */
export interface ModeStyle {
  color: string;
  width: number;
  dasharray?: number[];
}

/** Visual styling per transit mode */
export const MODE_STYLES: Record<TransitMode, ModeStyle> = {
  light_rail: { color: '#00A651', width: 4 },
  commuter_rail: { color: '#6D3A8E', width: 3.5, dasharray: [8, 4] },
  streetcar: { color: '#E8601C', width: 3 },
  ferry: { color: '#1B5E9E', width: 2.5, dasharray: [6, 4] },
  bus: { color: '#D4A017', width: 2 },
};

/** Stop marker colors per mode */
export const STOP_COLORS: Record<TransitMode, string> = {
  light_rail: '#00A651',
  commuter_rail: '#6D3A8E',
  streetcar: '#E8601C',
  ferry: '#1B5E9E',
  bus: '#D4A017',
};

/** Properties attached to a route GeoJSON feature */
export interface RouteFeatureProperties {
  routeId: string;
  shortName: string;
  longName: string;
  color: string;
  textColor: string;
  mode: TransitMode;
  agency: string;
  routeType: number;
}

/** Properties attached to a stop GeoJSON feature */
export interface StopFeatureProperties {
  stopId: string;
  name: string;
  mode: TransitMode;
  routes: string[];
  agency: string;
  locationType: number;
}

/** Configuration for a transit mode's layers on the map */
export interface TransitModeConfig {
  mode: TransitMode;
  minZoomRoutes: number;
  minZoomStops: number;
}

/** Known RapidRide line short names */
export const RAPIDRIDE_NAMES = new Set([
  'A Line', 'B Line', 'C Line', 'D Line', 'E Line', 'F Line', 'G Line', 'H Line',
]);

/** All transit modes and their zoom visibility settings (excludes bus which has special handling) */
export const RAIL_FERRY_MODES: TransitModeConfig[] = [
  { mode: 'light_rail', minZoomRoutes: 0, minZoomStops: 10 },
  { mode: 'commuter_rail', minZoomRoutes: 0, minZoomStops: 10 },
  { mode: 'streetcar', minZoomRoutes: 11, minZoomStops: 12 },
  { mode: 'ferry', minZoomRoutes: 0, minZoomStops: 10 },
];

/** All five transit modes */
export const ALL_MODES: TransitMode[] = [
  'light_rail', 'commuter_rail', 'streetcar', 'ferry', 'bus',
];

/** Resolved route details for the detail panel */
export interface RouteDetail {
  routeId: string;
  shortName: string;
  longName: string;
  mode: TransitMode;
  color: string;
  stops: StopSummary[];
}

/** Resolved stop details for the detail panel */
export interface StopDetail {
  stopId: string;
  name: string;
  mode: TransitMode;
  coordinates: [number, number];
  /** Routes grouped by mode for cross-mode display */
  routesByMode: { mode: TransitMode; label: string; routes: string[] }[];
}

/** Minimal stop info for display in a route's stop list */
export interface StopSummary {
  stopId: string;
  name: string;
  coordinates: [number, number];
}

/** Chat message role */
export type ChatRole = 'user' | 'assistant' | 'error';

/** A single message in the chat history */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  /** Parsed map actions extracted from AI response (assistant messages only) */
  mapActions?: MapAction[];
}

/** State of the AI chat */
export interface AiChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  apiKeyConfigured: boolean;
}

/** Context about the currently selected map element, injected into AI prompts */
export interface MapSelectionContext {
  type: 'route' | 'stop';
  name: string;
  /** Route short name (for routes) or stop name */
  details: string;
}

// ── Map Action Types ────────────────────────────────────────────────────

/** Highlight specific routes on the map by short name */
export interface HighlightRoutesAction {
  action: 'highlightRoutes';
  /** Route short names, e.g. ["1 Line", "2 Line"] */
  routeNames: string[];
}

/** Show specific stops with markers and optionally zoom to them */
export interface ShowStopsAction {
  action: 'showStops';
  /** Stop names, e.g. ["Capitol Hill Station", "University of Washington Station"] */
  stopNames: string[];
}

/** Zoom/fly the map to a specific location */
export interface ZoomToAction {
  action: 'zoomTo';
  /** Longitude */
  lng: number;
  /** Latitude */
  lat: number;
  /** Optional zoom level (default 14) */
  zoom?: number;
}

/** Filter visible transit modes */
export interface FilterModesAction {
  action: 'filterModes';
  /** Which modes to show. If empty, shows all modes. */
  show: TransitMode[];
}

/** Clear all AI-driven highlights */
export interface ClearHighlightsAction {
  action: 'clearHighlights';
}

/** Union of all map action types */
export type MapAction =
  | HighlightRoutesAction
  | ShowStopsAction
  | ZoomToAction
  | FilterModesAction
  | ClearHighlightsAction;

/** Map constants */
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
export const SEATTLE_CENTER: [number, number] = [-122.3321, 47.6062];
export const INITIAL_ZOOM = 11;
