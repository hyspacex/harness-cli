import { CertificationTrackId } from '../types.js';
import { QuizMode, QuizPayload, QuizScope } from './shared.js';

export const QUIZ_RESULTS_STORAGE_KEY = 'aws-learning-platform.quiz-results.v1';

export interface StoredQuizResultRecord {
  topicId: string | null;
  trackId: CertificationTrackId;
  scope: QuizScope;
  score: number;
  totalQuestions: number;
  completedAt: string;
  mode: QuizMode;
  modeLabel: string;
  quiz: QuizPayload;
  selectedAnswers: Record<string, string>;
}

export interface StoredQuizResults {
  version: 1;
  topic: StoredQuizResultRecord | null;
  track: StoredQuizResultRecord | null;
}

function getEmptyStore(): StoredQuizResults {
  return {
    version: 1,
    topic: null,
    track: null,
  };
}

export function readQuizResults(): StoredQuizResults {
  if (typeof window === 'undefined') {
    return getEmptyStore();
  }

  const rawValue = window.localStorage.getItem(QUIZ_RESULTS_STORAGE_KEY);

  if (!rawValue) {
    return getEmptyStore();
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredQuizResults>;

    return {
      version: 1,
      topic: parsed.topic ?? null,
      track: parsed.track ?? null,
    };
  } catch {
    return getEmptyStore();
  }
}

export function writeQuizResult(record: StoredQuizResultRecord): StoredQuizResults {
  const current = readQuizResults();
  const nextValue: StoredQuizResults = {
    ...current,
    [record.scope]: record,
  };

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(QUIZ_RESULTS_STORAGE_KEY, JSON.stringify(nextValue));
  }

  return nextValue;
}

export function getStoredQuizResult(
  scope: QuizScope,
  topicId: string,
  trackId: CertificationTrackId,
): StoredQuizResultRecord | null {
  const record = readQuizResults()[scope];

  if (!record || record.trackId !== trackId) {
    return null;
  }

  if (scope === 'topic' && record.topicId !== topicId) {
    return null;
  }

  return record;
}
