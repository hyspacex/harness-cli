import { IncomingMessage, ServerResponse } from 'node:http';
import { QuizGenerationResponse } from './client.js';
import { buildQuizTurn, normalizeModelQuiz, generateMockQuiz, QuizMode, QuizRequestInput } from './shared.js';

interface QuizRuntimeConfig {
  apiKey: string;
  mode: 'auto' | 'mock' | 'live';
  model: string;
}

function getQuizRuntimeConfig(env: NodeJS.ProcessEnv = process.env): QuizRuntimeConfig {
  const normalizedMode = (env.AWS_QUIZ_MODE ?? 'auto').toLowerCase();
  const mode = normalizedMode === 'mock' || normalizedMode === 'live' ? normalizedMode : 'auto';

  return {
    apiKey: env.OPENAI_API_KEY ?? '',
    mode,
    model: env.AWS_QUIZ_OPENAI_MODEL ?? 'gpt-4.1-mini',
  };
}

function resolveQuizMode(config: QuizRuntimeConfig): QuizMode {
  if (config.mode === 'mock') {
    return 'mock';
  }

  if (!config.apiKey) {
    return 'mock';
  }

  return 'live';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJsonBody(request: IncomingMessage): Promise<QuizRequestInput> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as QuizRequestInput;
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    return trimmed;
  }

  const match = trimmed.match(/\{[\s\S]*\}/u);

  if (!match) {
    throw new Error('Live quiz generation did not return JSON.');
  }

  return match[0];
}

async function getLiveQuizResponse(systemPrompt: string, userPrompt: string, config: QuizRuntimeConfig) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.5,
      response_format: {
        type: 'json_object',
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Live quiz request failed with status ${response.status}.`);
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
    throw new Error('Live quiz generation returned an empty response.');
  }

  return JSON.parse(extractJsonBlock(text)) as unknown;
}

async function buildQuizResponse(input: QuizRequestInput): Promise<QuizGenerationResponse> {
  const context = buildQuizTurn(input);
  const config = getQuizRuntimeConfig();
  const resolvedMode = resolveQuizMode(config);

  await sleep(220);

  if (resolvedMode === 'live') {
    try {
      const livePayload = await getLiveQuizResponse(context.systemPrompt, context.userPrompt, config);

      return {
        grounding: context.grounding,
        mode: 'live',
        modeLabel: 'Live AI',
        quiz: normalizeModelQuiz(livePayload, context),
      };
    } catch (error) {
      if (config.mode === 'live') {
        throw error;
      }
    }
  }

  return {
    grounding: context.grounding,
    mode: 'mock',
    modeLabel: 'Demo mode',
    quiz: generateMockQuiz(context),
  };
}

export function createQuizMiddleware() {
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (request.method !== 'POST' || request.url !== '/api/quiz') {
      next();
      return;
    }

    try {
      const payload = await buildQuizResponse(await readJsonBody(request));

      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(error instanceof Error ? error.message : 'Unexpected quiz failure.');
    }
  };
}
