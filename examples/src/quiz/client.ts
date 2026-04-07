import { QuizMode, QuizPayload, QuizRequestInput, QuizGrounding } from './shared.js';

export interface QuizGenerationResponse {
  grounding: QuizGrounding;
  mode: QuizMode;
  modeLabel: string;
  quiz: QuizPayload;
}

export async function requestQuiz(input: QuizRequestInput, signal?: AbortSignal): Promise<QuizGenerationResponse> {
  const response = await fetch('/api/quiz', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'The quiz could not be generated.');
  }

  return (await response.json()) as QuizGenerationResponse;
}
