import { afterEach, describe, expect, it } from 'vitest';
import { getTopicLabel } from './shared.js';
import { ADAPTIVE_STATE_STORAGE_KEY, recordTopicQuizResult, syncAdaptiveState } from './storage.js';
import { StoredQuizResultRecord } from '../quiz/storage.js';

function createTopicRecord(topicId: string, score: number, completedAt: string): StoredQuizResultRecord {
  const topicName = getTopicLabel(topicId);

  return {
    completedAt,
    mode: 'mock',
    modeLabel: 'Demo mode',
    quiz: {
      grounding: {
        activeTopicId: topicId,
        activeTopicName: topicName,
        scope: 'topic',
        snippets: [],
        sourceTopics: [],
        title: `${topicName} topic quiz`,
        topicId,
        topicName,
        trackId: 'cloud-practitioner',
        trackLabel: 'Cloud Practitioner',
      },
      id: `${topicId}-quiz`,
      questions: [],
      scope: 'topic',
      title: `${topicName} topic quiz`,
    },
    scope: 'topic',
    score,
    selectedAnswers: {},
    topicId,
    totalQuestions: 4,
    trackId: 'cloud-practitioner',
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('adaptive storage', () => {
  it('persists review scheduling, momentum, and refresh-safe restoration after a due review is completed', () => {
    recordTopicQuizResult(createTopicRecord('s3', 4, '2026-04-06T22:00:00.000Z'));
    const weakIamState = recordTopicQuizResult(createTopicRecord('iam', 2, '2026-04-06T22:05:00.000Z'));

    expect(weakIamState.reviewQueue[0].topicId).toBe('iam');
    expect(weakIamState.reviewQueue[0].reviewState).toBe('Due now');
    expect(weakIamState.topics.s3.reviewState).toBe('Scheduled');
    expect(weakIamState.momentum.xp).toBe(0);

    const weakIamNextDueAt = weakIamState.topics.iam.nextDueAt;
    const recoveredIamState = recordTopicQuizResult(createTopicRecord('iam', 3, '2026-04-06T22:10:00.000Z'));

    expect(recoveredIamState.topics.iam.reviewState).toBe('Scheduled');
    expect(Date.parse(recoveredIamState.topics.iam.nextDueAt as string)).toBeGreaterThan(
      Date.parse(weakIamNextDueAt as string),
    );
    expect(recoveredIamState.momentum.xp).toBe(30);
    expect(recoveredIamState.momentum.completedReviews).toBe(1);
    expect(recoveredIamState.momentum.streakDays).toBe(1);
    expect(recoveredIamState.momentum.lastReviewCompletedAt).toBe('2026-04-06T22:10:00.000Z');
    expect(recoveredIamState.topics.iam.reviewCount).toBe(2);
    expect(recoveredIamState.recommendations[0].topicId).not.toBe('iam');

    const persisted = JSON.parse(window.localStorage.getItem(ADAPTIVE_STATE_STORAGE_KEY) ?? '{}');

    expect(persisted.trackId).toBe('cloud-practitioner');
    expect(persisted.reviewQueue[0].topicId).toBe('iam');
    expect(persisted.topics.iam.reviewCount).toBe(2);
    expect(persisted.topics.iam.lastReviewedAt).toBe('2026-04-06T22:10:00.000Z');
    expect(persisted.momentum.xp).toBe(30);
    expect(persisted.momentum.completedReviews).toBe(1);

    const refreshed = syncAdaptiveState('cloud-practitioner');

    expect(refreshed.topics.iam.reviewState).toBe('Scheduled');
    expect(refreshed.topics.s3.reviewState).toBe('Scheduled');
    expect(refreshed.momentum.xp).toBe(30);
    expect(refreshed.momentum.completedReviews).toBe(1);
    expect(refreshed.recommendations[0].topicId).not.toBe('iam');
  });
});
