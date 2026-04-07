import { useState, useCallback, useRef, useMemo } from 'react';
import type { TransitMode, ChatMessage, AiChatState, MapAction, MapSelectionContext } from '../types/transit';
import { MODE_LABELS } from '../types/transit';

interface TransitGeoJSON {
  routes: GeoJSON.FeatureCollection | null;
  stops: GeoJSON.FeatureCollection | null;
}

type TransitDataMap = Partial<Record<TransitMode, TransitGeoJSON>>;

const API_KEY = import.meta.env.VITE_AI_API_KEY as string | undefined;

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Builds structured transit context from loaded GeoJSON data
 * for injection into the LLM system prompt.
 */
function buildTransitContext(data: TransitDataMap): string {
  const sections: string[] = [];

  // Process each non-bus mode: include all routes and all stops
  const nonBusModes: TransitMode[] = ['light_rail', 'commuter_rail', 'streetcar', 'ferry'];
  for (const mode of nonBusModes) {
    const modeData = data[mode];
    if (!modeData) continue;

    const label = MODE_LABELS[mode];
    const routeLines: string[] = [];
    const stopNames: string[] = [];

    if (modeData.routes) {
      const seen = new Set<string>();
      for (const feature of modeData.routes.features) {
        const props = feature.properties as Record<string, unknown>;
        const shortName = props.shortName as string;
        const longName = props.longName as string;
        const key = `${shortName}|${longName}`;
        if (!seen.has(key)) {
          seen.add(key);
          routeLines.push(`  - ${shortName}${longName ? ` (${longName})` : ''}`);
        }
      }
    }

    if (modeData.stops) {
      const seen = new Set<string>();
      for (const feature of modeData.stops.features) {
        const props = feature.properties as Record<string, unknown>;
        const name = props.name as string;
        if (name && !seen.has(name)) {
          seen.add(name);
          stopNames.push(name);
        }
      }
    }

    sections.push(
      `## ${label}\n` +
      `Routes:\n${routeLines.join('\n')}\n` +
      `Stations/Stops (${stopNames.length}):\n${stopNames.map(n => `  - ${n}`).join('\n')}`
    );
  }

  // Bus: include only RapidRide routes and a summary count
  const busData = data.bus;
  if (busData) {
    const rapidRideNames = new Set([
      'A Line', 'B Line', 'C Line', 'D Line', 'E Line', 'F Line', 'G Line', 'H Line',
    ]);
    const rapidRideRoutes: string[] = [];
    let totalBusRoutes = 0;

    if (busData.routes) {
      const seenRoutes = new Set<string>();
      for (const feature of busData.routes.features) {
        const props = feature.properties as Record<string, unknown>;
        const shortName = props.shortName as string;
        const longName = props.longName as string;
        if (!seenRoutes.has(shortName)) {
          seenRoutes.add(shortName);
          totalBusRoutes++;
          if (rapidRideNames.has(shortName)) {
            rapidRideRoutes.push(`  - ${shortName}${longName ? ` (${longName})` : ''}`);
          }
        }
      }
    }

    let busStopCount = 0;
    if (busData.stops) {
      const seenStops = new Set<string>();
      for (const feature of busData.stops.features) {
        const props = feature.properties as Record<string, unknown>;
        const name = props.name as string;
        if (name && !seenStops.has(name)) {
          seenStops.add(name);
          busStopCount++;
        }
      }
    }

    sections.push(
      `## Bus\n` +
      `Total bus routes: ${totalBusRoutes}\n` +
      `RapidRide lines (premium frequent service):\n${rapidRideRoutes.join('\n')}\n` +
      `Total bus stops: ${busStopCount} (shown on map at zoom 13+)`
    );
  }

  return sections.join('\n\n');
}

const SYSTEM_PROMPT_TEMPLATE = `You are a helpful transit assistant for the Seattle Transit Explorer, an interactive map application showing Seattle's public transportation network.

You have detailed knowledge of the following transit data, derived from official GTFS feeds:

{TRANSIT_CONTEXT}

## Important guidelines:
- Always reference official route designations (e.g., "1 Line", "2 Line", "T Line" for light rail, not generic "Link Light Rail")
- Reference actual station and stop names from the data above
- If asked about routes between locations, identify which routes serve relevant stops
- If asked about a stop or station, mention which routes serve it and which transit mode it belongs to
- Be concise and helpful. Focus on answering the transit question directly.
- You only have static route and stop data. You cannot provide real-time arrivals, schedules, fares, or live tracking.
- If a question is outside your transit data scope, say so clearly.
- Seattle's transit system includes: Link Light Rail (Sound Transit), Sounder Commuter Rail (Sound Transit), Seattle Streetcar, King County Water Taxi (ferry), and King County Metro (bus).

## Map Actions

You MUST include a \`mapActions\` JSON block at the END of every response. This block tells the map application what to display. Wrap it in a fenced code block tagged "mapActions":

\`\`\`mapActions
[
  { "action": "highlightRoutes", "routeNames": ["1 Line", "2 Line"] },
  { "action": "showStops", "stopNames": ["Capitol Hill Station"] },
  { "action": "zoomTo", "lng": -122.3221, "lat": 47.6195, "zoom": 14 },
  { "action": "filterModes", "show": ["light_rail", "commuter_rail", "streetcar", "ferry", "bus"] },
  { "action": "clearHighlights" }
]
\`\`\`

Rules for map actions:
- Include ONLY actions relevant to your response. Do not include all action types every time.
- For "highlightRoutes": use exact route shortNames from the data (e.g., "1 Line", "A Line", "S Line").
- For "showStops": use exact stop names from the data (e.g., "Capitol Hill Station", "Westlake Station").
- For "zoomTo": provide approximate coordinates for the area you're discussing. Use zoom 14-15 for single stops, 12-13 for areas, 11 for city-wide views.
- For "filterModes": list the modes that should be VISIBLE. Valid modes: "light_rail", "commuter_rail", "streetcar", "ferry", "bus". Use this when the user asks to show only specific modes or hide modes. To show everything, include all 5 modes.
- For "clearHighlights": use when the user asks to reset or clear the map.
- When mentioning specific routes, always include a "highlightRoutes" action.
- When mentioning specific stops, always include a "showStops" action with the stop names, and a "zoomTo" action if discussing a specific location.
- When the user asks to filter modes (e.g., "show only light rail", "hide buses"), include a "filterModes" action.
- Do NOT include "filterModes" unless the user specifically asks to show/hide transit modes.
- Keep the mapActions block compact. The map validates all references against real data and silently skips invalid ones.`;

/**
 * Extracts the mapActions JSON block and returns the clean prose + parsed actions.
 */
export function parseMapActions(rawText: string): { prose: string; actions: MapAction[] } {
  // Match fenced code block tagged mapActions
  const pattern = /```mapActions\s*\n([\s\S]*?)```/;
  const match = rawText.match(pattern);

  if (!match) {
    return { prose: rawText.trim(), actions: [] };
  }

  // Remove the action block from prose
  const prose = rawText.replace(pattern, '').trim();

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) {
      return { prose, actions: [] };
    }

    // Validate each action has the right shape
    const actions: MapAction[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || !item.action) continue;

      switch (item.action) {
        case 'highlightRoutes':
          if (Array.isArray(item.routeNames)) {
            actions.push({ action: 'highlightRoutes', routeNames: item.routeNames });
          }
          break;
        case 'showStops':
          if (Array.isArray(item.stopNames)) {
            actions.push({ action: 'showStops', stopNames: item.stopNames });
          }
          break;
        case 'zoomTo':
          if (typeof item.lng === 'number' && typeof item.lat === 'number') {
            actions.push({
              action: 'zoomTo',
              lng: item.lng,
              lat: item.lat,
              zoom: typeof item.zoom === 'number' ? item.zoom : undefined,
            });
          }
          break;
        case 'filterModes':
          if (Array.isArray(item.show)) {
            actions.push({ action: 'filterModes', show: item.show });
          }
          break;
        case 'clearHighlights':
          actions.push({ action: 'clearHighlights' });
          break;
      }
    }

    return { prose, actions };
  } catch {
    // Malformed JSON — return prose without actions
    return { prose, actions: [] };
  }
}

/**
 * Custom hook encapsulating AI chat state, message history,
 * API call logic, and error handling.
 */
export function useAiChat(
  data: TransitDataMap,
  mapSelection?: MapSelectionContext | null,
): AiChatState & {
  sendMessage: (content: string) => void;
  clearHistory: () => void;
  latestActions: MapAction[];
} {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [latestActions, setLatestActions] = useState<MapAction[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const apiKeyConfigured = Boolean(API_KEY && API_KEY.trim().length > 0);

  // Build system prompt with transit context and map selection
  const systemPrompt = useMemo(() => {
    const transitContext = buildTransitContext(data);
    let prompt = SYSTEM_PROMPT_TEMPLATE.replace('{TRANSIT_CONTEXT}', transitContext);
    if (mapSelection) {
      const selType = mapSelection.type === 'route' ? 'route' : 'stop/station';
      prompt += `\n\n## Currently Selected Map Element\nThe user has selected a ${selType} on the map: **${mapSelection.name}**\n${mapSelection.details}\nWhen the user asks questions like "What routes stop here?", "Where does this line go?", or "Tell me more about this", they are referring to this selected element. Use this context to answer without requiring the user to re-specify the name.`;
    }
    return prompt;
  }, [data, mapSelection]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading) return;
    if (!apiKeyConfigured) return;

    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);

    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Build conversation history for the API (last 20 messages for context window)
      const recentMessages = [...messages, userMessage]
        .filter(m => m.role !== 'error')
        .slice(-20);

      const apiMessages = recentMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY!,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          messages: apiMessages,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Consume the response body to release the connection
        await response.text().catch(() => '');
        let userFriendlyMessage: string;

        if (response.status === 401 || response.status === 403) {
          userFriendlyMessage = 'Authentication failed. Please check that your API key is valid.';
        } else if (response.status === 429) {
          userFriendlyMessage = 'Rate limit reached. Please wait a moment and try again.';
        } else if (response.status === 400) {
          userFriendlyMessage = 'The request was invalid. Please try rephrasing your question.';
        } else if (response.status >= 500) {
          userFriendlyMessage = 'The AI service is temporarily unavailable. Please try again later.';
        } else {
          userFriendlyMessage = 'Something went wrong while processing your request. Please try again.';
        }

        throw new Error(userFriendlyMessage);
      }

      const result = await response.json();
      const rawContent = result.content?.[0]?.text ?? 'I received your question but was unable to generate a response. Please try again.';

      // Parse structured map actions from the response
      const { prose, actions } = parseMapActions(rawContent);

      const assistantMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: prose,
        timestamp: Date.now(),
        mapActions: actions.length > 0 ? actions : undefined,
      };

      setMessages(prev => [...prev, assistantMessage]);
      setLatestActions(actions);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Request was cancelled, don't show error
        return;
      }

      let errorContent: string;
      if (err instanceof TypeError && err.message.includes('fetch')) {
        errorContent = 'Unable to connect to the AI service. Please check your internet connection and try again.';
      } else if (err instanceof Error) {
        errorContent = err.message;
      } else {
        errorContent = 'An unexpected error occurred. Please try again.';
      }

      const errorMessage: ChatMessage = {
        id: generateId(),
        role: 'error',
        content: errorContent,
        timestamp: Date.now(),
      };

      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }, [messages, isLoading, apiKeyConfigured, systemPrompt]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setLatestActions([]);
  }, []);

  return {
    messages,
    isLoading,
    apiKeyConfigured,
    sendMessage,
    clearHistory,
    latestActions,
  };
}
