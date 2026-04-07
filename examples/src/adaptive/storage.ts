import { CertificationTrackId } from '../types.js';
import { readQuizResults, StoredQuizResultRecord } from '../quiz/storage.js';
import {
  AdaptiveTopicAttempt,
  AdaptiveTrackSnapshot,
  buildNextReviewRecord,
  deriveAdaptiveTrackSnapshot,
  extractTopicAttempts,
  extractTopicReviewRecords,
  getInitialMomentum,
  isDueReviewAt,
  recordCompletedReviewMomentum,
} from './shared.js';

export const ADAPTIVE_STATE_STORAGE_KEY = 'aws-learning-platform.adaptive-state.v1';

export interface StoredAdaptiveState extends AdaptiveTrackSnapshot {
  lastUpdatedAt: string;
  trackId: CertificationTrackId;
  trackStates: Partial<Record<CertificationTrackId, AdaptiveTrackSnapshot>>;
  version: 1;
}

function getEmptySnapshot(trackId: CertificationTrackId, nowIso?: string): AdaptiveTrackSnapshot {
  return deriveAdaptiveTrackSnapshot(trackId, {}, {}, getInitialMomentum(), nowIso);
}

function readRawAdaptiveState(): StoredAdaptiveState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const rawValue = window.localStorage.getItem(ADAPTIVE_STATE_STORAGE_KEY);

  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredAdaptiveState>;
    const topLevelSnapshot: AdaptiveTrackSnapshot = {
      categories: parsed.categories ?? {},
      momentum: parsed.momentum ?? getInitialMomentum(),
      recommendations: parsed.recommendations ?? [],
      reviewQueue: parsed.reviewQueue ?? [],
      topics: parsed.topics ?? {},
    };

    return {
      ...topLevelSnapshot,
      lastUpdatedAt: parsed.lastUpdatedAt ?? new Date(0).toISOString(),
      trackId: parsed.trackId ?? 'cloud-practitioner',
      trackStates: parsed.trackStates ?? (parsed.trackId ? { [parsed.trackId]: topLevelSnapshot } : {}),
      version: 1,
    };
  } catch {
    return null;
  }
}

function writeAdaptiveState(state: StoredAdaptiveState): StoredAdaptiveState {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ADAPTIVE_STATE_STORAGE_KEY, JSON.stringify(state));
  }

  return state;
}

function getSnapshotForTrack(
  storedState: StoredAdaptiveState | null,
  trackId: CertificationTrackId,
): AdaptiveTrackSnapshot | null {
  if (!storedState) {
    return null;
  }

  return storedState.trackStates[trackId] ?? (storedState.trackId === trackId
    ? {
        categories: storedState.categories,
        momentum: storedState.momentum,
        recommendations: storedState.recommendations,
        reviewQueue: storedState.reviewQueue,
        topics: storedState.topics,
      }
    : null);
}

function persistSnapshot(
  trackId: CertificationTrackId,
  snapshot: AdaptiveTrackSnapshot,
  storedState: StoredAdaptiveState | null,
  lastUpdatedAt: string,
): StoredAdaptiveState {
  return writeAdaptiveState({
    ...snapshot,
    lastUpdatedAt,
    trackId,
    trackStates: {
      ...(storedState?.trackStates ?? {}),
      [trackId]: snapshot,
    },
    version: 1,
  });
}

function buildBootstrapSnapshot(
  trackId: CertificationTrackId,
  storedState: StoredAdaptiveState | null,
  nowIso: string,
): AdaptiveTrackSnapshot {
  const currentSnapshot = getSnapshotForTrack(storedState, trackId);

  if (currentSnapshot) {
    const topicAttempts = extractTopicAttempts(currentSnapshot);
    const reviewRecords = extractTopicReviewRecords(currentSnapshot);

    return deriveAdaptiveTrackSnapshot(
      trackId,
      topicAttempts,
      reviewRecords,
      currentSnapshot.momentum ?? getInitialMomentum(),
      nowIso,
    );
  }

  const topicAttempts: Partial<Record<string, AdaptiveTopicAttempt>> = {};
  const latestTopicRecord = readQuizResults().topic;

  if (latestTopicRecord && latestTopicRecord.trackId === trackId && latestTopicRecord.topicId) {
    topicAttempts[latestTopicRecord.topicId] = {
      completedAt: latestTopicRecord.completedAt,
      score: latestTopicRecord.score,
      totalQuestions: latestTopicRecord.totalQuestions,
    };
  }

  return Object.keys(topicAttempts).length > 0
    ? deriveAdaptiveTrackSnapshot(trackId, topicAttempts, {}, getInitialMomentum(), nowIso)
    : getEmptySnapshot(trackId, nowIso);
}

export function syncAdaptiveState(trackId: CertificationTrackId): StoredAdaptiveState {
  const storedState = readRawAdaptiveState();
  const nowIso = new Date().toISOString();
  const snapshot = buildBootstrapSnapshot(trackId, storedState, nowIso);

  return persistSnapshot(trackId, snapshot, storedState, nowIso);
}

export function recordTopicQuizResult(record: StoredQuizResultRecord): StoredAdaptiveState {
  if (record.scope !== 'topic' || !record.topicId) {
    return syncAdaptiveState(record.trackId);
  }

  const storedState = readRawAdaptiveState();
  const currentSnapshot =
    getSnapshotForTrack(storedState, record.trackId) ?? buildBootstrapSnapshot(record.trackId, storedState, record.completedAt);
  const topicAttempts = extractTopicAttempts(currentSnapshot);
  const reviewRecords = extractTopicReviewRecords(currentSnapshot);
  const previousTopicState = currentSnapshot.topics[record.topicId];

  const nextAttempt: AdaptiveTopicAttempt = {
    completedAt: record.completedAt,
    score: record.score,
    totalQuestions: record.totalQuestions,
  };
  topicAttempts[record.topicId] = nextAttempt;
  reviewRecords[record.topicId] = buildNextReviewRecord(reviewRecords[record.topicId], nextAttempt);

  const nextMomentum = isDueReviewAt(
    previousTopicState ?? {
      lastReviewedAt: null,
      nextDueAt: null,
    },
    record.completedAt,
  )
    ? recordCompletedReviewMomentum(currentSnapshot.momentum, record.completedAt)
    : currentSnapshot.momentum ?? getInitialMomentum();
  const nextSnapshot = deriveAdaptiveTrackSnapshot(
    record.trackId,
    topicAttempts,
    reviewRecords,
    nextMomentum,
    record.completedAt,
  );

  return persistSnapshot(record.trackId, nextSnapshot, storedState, record.completedAt);
}
