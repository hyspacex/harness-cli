import { TutorGrounding, TutorRequestInput } from './shared.js';

export type TutorMode = 'mock' | 'live';

export type TutorStreamEvent =
  | {
      type: 'meta';
      grounding: TutorGrounding;
      mode: TutorMode;
      modeLabel: string;
    }
  | {
      type: 'delta';
      delta: string;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'done';
    };

export async function requestTutorResponse(
  input: TutorRequestInput,
  onEvent: (event: TutorStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/tutor', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal,
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(errorText || 'The tutor could not start a response.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        onEvent(JSON.parse(line) as TutorStreamEvent);
      });
  }

  const finalLine = buffer.trim();

  if (finalLine) {
    onEvent(JSON.parse(finalLine) as TutorStreamEvent);
  }
}
