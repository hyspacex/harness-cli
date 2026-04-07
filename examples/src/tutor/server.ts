import { IncomingMessage, ServerResponse } from 'node:http';
import { buildTutorTurn, TutorRequestInput } from './shared.js';
import { generateMockTutorResponse } from './mock.js';
import { TutorMode, TutorStreamEvent } from './client.js';

interface TutorRuntimeConfig {
  apiKey: string;
  forceFailureAfterChunk: boolean;
  mode: 'auto' | 'mock' | 'live';
  model: string;
}

function getTutorRuntimeConfig(env: NodeJS.ProcessEnv = process.env): TutorRuntimeConfig {
  const normalizedMode = (env.AWS_TUTOR_MODE ?? 'auto').toLowerCase();
  const mode = normalizedMode === 'mock' || normalizedMode === 'live' ? normalizedMode : 'auto';

  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    forceFailureAfterChunk: env.AWS_TUTOR_FAIL_AFTER_CHUNK === '1',
    mode,
    model: env.AWS_TUTOR_OPENAI_MODEL ?? 'gpt-4.1-mini',
  };
}

function resolveTutorMode(config: TutorRuntimeConfig): TutorMode {
  if (config.mode === 'mock') {
    return 'mock';
  }

  if (!config.apiKey) {
    return 'mock';
  }

  return config.mode === 'live' || config.apiKey ? 'live' : 'mock';
}

function chunkResponse(text: string): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  const chunks: string[] = [];
  let currentChunk = '';

  words.forEach((word) => {
    const candidate = currentChunk ? `${currentChunk} ${word}` : word;

    if (candidate.length > 26 && currentChunk) {
      chunks.push(`${currentChunk} `);
      currentChunk = word;
      return;
    }

    currentChunk = candidate;
  });

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeEvent(response: ServerResponse, event: TutorStreamEvent): void {
  response.write(`${JSON.stringify(event)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<TutorRequestInput> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as TutorRequestInput;
}

async function getLiveTutorResponse(systemPrompt: string, userPrompt: string, config: TutorRuntimeConfig): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Live tutor request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const text = payload.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error('Live tutor returned an empty response.');
  }

  return text;
}

async function streamTutorReply(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = await readJsonBody(request);
  const context = buildTutorTurn(input);
  const config = getTutorRuntimeConfig();
  const mode = resolveTutorMode(config);

  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders?.();

  writeEvent(response, {
    type: 'meta',
    grounding: context.grounding,
    mode,
    modeLabel: mode === 'mock' ? 'Demo mode' : 'Live AI',
  });

  try {
    const fullResponse =
      mode === 'live'
        ? await getLiveTutorResponse(context.systemPrompt, context.userPrompt, config)
        : generateMockTutorResponse(context);
    const chunks = chunkResponse(fullResponse);

    for (let index = 0; index < chunks.length; index += 1) {
      writeEvent(response, {
        type: 'delta',
        delta: chunks[index],
      });
      await sleep(140);

      if (config.forceFailureAfterChunk && index === 0) {
        writeEvent(response, {
          type: 'error',
          message: 'The tutor lost its connection after the first streamed chunk. Partial guidance is preserved below, and you can retry from this topic.',
        });
        response.end();
        return;
      }
    }

    writeEvent(response, { type: 'done' });
    response.end();
  } catch (error) {
    writeEvent(response, {
      type: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'The tutor could not complete the request. Try again or switch to demo mode.',
    });
    response.end();
  }
}

export function createTutorMiddleware() {
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (request.method !== 'POST' || request.url !== '/api/tutor') {
      next();
      return;
    }

    try {
      await streamTutorReply(request, response);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(error instanceof Error ? error.message : 'Unexpected tutor failure.');
    }
  };
}
