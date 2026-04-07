import { describe, expect, it } from 'vitest';
import { buildNextReviewRecord, deriveAdaptiveTrackSnapshot, isImmediateReviewState } from './shared.js';

describe('adaptive review derivation', () => {
  it('surfaces a weak IAM result before a strong S3 result, then reschedules IAM later after a successful follow-up review', () => {
    const topicAttempts = {
      iam: {
        completedAt: '2026-04-06T22:05:00.000Z',
        score: 2,
        totalQuestions: 4,
      },
      s3: {
        completedAt: '2026-04-06T22:00:00.000Z',
        score: 4,
        totalQuestions: 4,
      },
    };
    const initialReviewRecords = {
      iam: buildNextReviewRecord(null, topicAttempts.iam),
      s3: buildNextReviewRecord(null, topicAttempts.s3),
    };
    const weakIamSnapshot = deriveAdaptiveTrackSnapshot(
      'cloud-practitioner',
      topicAttempts,
      initialReviewRecords,
      undefined,
      '2026-04-06T22:05:00.000Z',
    );

    expect(weakIamSnapshot.reviewQueue[0].topicId).toBe('iam');
    expect(weakIamSnapshot.reviewQueue[0].reviewState).toBe('Due now');
    expect(weakIamSnapshot.reviewQueue[0].timingLabel).toBe('Due now');
    expect(weakIamSnapshot.topics.s3.reviewState).toBe('Scheduled');
    expect(weakIamSnapshot.recommendations[0].kind).toBe('review');
    expect(weakIamSnapshot.recommendations[0].topicId).toBe('iam');

    const previousIamNextDueAt = weakIamSnapshot.topics.iam.nextDueAt;
    const recoveredAttempts = {
      ...topicAttempts,
      iam: {
        completedAt: '2026-04-06T22:10:00.000Z',
        score: 3,
        totalQuestions: 4,
      },
    };
    const recoveredReviewRecords = {
      ...initialReviewRecords,
      iam: buildNextReviewRecord(initialReviewRecords.iam, recoveredAttempts.iam),
    };
    const recoveredIamSnapshot = deriveAdaptiveTrackSnapshot(
      'cloud-practitioner',
      recoveredAttempts,
      recoveredReviewRecords,
      undefined,
      '2026-04-06T22:10:00.000Z',
    );

    expect(recoveredIamSnapshot.topics.iam.reviewState).toBe('Scheduled');
    expect(Date.parse(recoveredIamSnapshot.topics.iam.nextDueAt as string)).toBeGreaterThan(
      Date.parse(previousIamNextDueAt as string),
    );
    expect(recoveredIamSnapshot.reviewQueue.every((item) => !isImmediateReviewState(item.reviewState))).toBe(true);
    expect(recoveredIamSnapshot.recommendations[0].kind).toBe('study');
    expect(recoveredIamSnapshot.recommendations[0].topicId).not.toBe('iam');
  });

  it('derives visible topic, category, and review state from raw topic attempts', () => {
    const adaptiveState = deriveAdaptiveTrackSnapshot(
      'cloud-practitioner',
      {
        iam: {
          completedAt: '2026-04-06T22:20:00.000Z',
          score: 2,
          totalQuestions: 4,
        },
        s3: {
          completedAt: '2026-04-06T22:15:00.000Z',
          score: 3,
          totalQuestions: 4,
        },
      },
      {},
      undefined,
      '2026-04-06T22:20:00.000Z',
    );

    expect(adaptiveState.topics.s3.confidenceState).toBe('Confident');
    expect(adaptiveState.topics.s3.reviewState).toBe('Scheduled');
    expect(adaptiveState.topics.iam.confidenceState).toBe('Needs review');
    expect(adaptiveState.topics.iam.reviewState).toBe('Due now');
    expect(adaptiveState.categories.storage.dominantState).toBe('Confident');
    expect(adaptiveState.categories.security.dominantState).toBe('Needs review');
    expect(adaptiveState.reviewQueue.map((item) => item.topicId)).toEqual(['iam', 's3']);
  });
});
