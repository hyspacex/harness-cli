import { getCategory, getTopic, getTopicsForTrack, topics } from '../data/curriculum.js';
import { CertificationTrackId, ServiceCategoryId, Topic } from '../types.js';

export const CONFIDENCE_STATES = ['Unattempted', 'Needs review', 'Confident'] as const;
export const REVIEW_STATES = ['Not scheduled', 'Scheduled', 'Due today', 'Due now'] as const;
export const RECOMMENDATION_KINDS = ['review', 'retry', 'study', 'blocked'] as const;
export const ADAPTIVE_CONFIDENCE_BAR = 0.75;

const MAX_RECOMMENDATIONS = 4;
const MAX_INTERVAL_DAYS = 21;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const REVIEW_COMPLETION_XP = 30;

export type ConfidenceState = (typeof CONFIDENCE_STATES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export interface AdaptiveTopicAttempt {
  completedAt: string;
  score: number;
  totalQuestions: number;
}

export interface AdaptiveTopicReviewRecord {
  intervalDays: number | null;
  lastReviewedAt: string | null;
  nextDueAt: string | null;
  reviewCount: number;
}

export interface AdaptiveTopicState extends AdaptiveTopicReviewRecord {
  categoryId: ServiceCategoryId;
  completedAt: string | null;
  confidenceState: ConfidenceState;
  label: string;
  blockedBy: string[];
  prerequisites: string[];
  reviewState: ReviewState;
  reviewTargets: string[];
  score: number | null;
  totalQuestions: number | null;
}

export interface AdaptiveCategoryState {
  confidentCount: number;
  dominantState: ConfidenceState;
  label: string;
  needsReviewCount: number;
  topicCount: number;
  topicIds: string[];
  unattemptedCount: number;
}

export interface AdaptiveReviewQueueItem {
  confidenceState: ConfidenceState;
  intervalDays: number | null;
  label: string;
  nextDueAt: string | null;
  reviewCount: number;
  reviewState: ReviewState;
  timingLabel: string;
  topicId: string;
}

export interface AdaptiveMomentum {
  completedReviews: number;
  lastReviewCompletedAt: string | null;
  streakDays: number;
  xp: number;
}

export interface AdaptiveRecommendation {
  blockedBy: string[];
  kind: RecommendationKind;
  label: string;
  reason: string;
  topicId: string;
}

export interface AdaptiveTrackSnapshot {
  categories: Record<string, AdaptiveCategoryState>;
  momentum: AdaptiveMomentum;
  recommendations: AdaptiveRecommendation[];
  reviewQueue: AdaptiveReviewQueueItem[];
  topics: Record<string, AdaptiveTopicState>;
}

const reviewTargetMap: Partial<Record<string, string[]>> = {
  cloudfront: [
    'Cache behaviors and invalidation strategy',
    'Origin access control for private S3 assets',
    'Freshness versus performance trade-offs',
  ],
  cognito: [
    'User pools versus IAM roles',
    'Token handling and hosted UI configuration',
    'Federation and account-recovery flows',
  ],
  dynamodb: [
    'Partition-key and access-pattern design',
    'On-demand versus provisioned capacity',
    'Lambda integration and retry behavior',
  ],
  ebs: [
    'EBS volume classes and IOPS sizing',
    'Snapshot and recovery planning',
    'Availability Zone attachment constraints',
  ],
  ec2: [
    'Auto Scaling groups and launch templates',
    'Instance roles instead of static credentials',
    'EC2 versus Lambda workload fit',
  ],
  iam: [
    'Least-privilege IAM policies',
    'Role usage for Lambda and EC2',
    'MFA, Access Analyzer, and CloudTrail visibility',
    'Shared Responsibility Model for identity controls',
  ],
  lambda: [
    'Cold starts and execution duration limits',
    'Event-source retry semantics',
    'IAM roles and downstream permissions',
  ],
  rds: [
    'Backups and Multi-AZ failover',
    'Security groups and secret rotation',
    'RDS versus DynamoDB trade-offs',
  ],
  s3: [
    'S3 bucket policies and public access settings',
    'IAM permissions for S3 access',
    'S3 versioning and lifecycle rules',
    'S3 storage classes and retrieval trade-offs',
    'Shared Responsibility Model for Amazon S3',
    'AWS Well-Architected Framework trade-offs for durability and cost',
  ],
  vpc: [
    'Public versus private subnet placement',
    'Route tables and internet or NAT egress paths',
    'Security groups and segmentation boundaries',
  ],
};

function toDateValue(value: string): number {
  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? 0 : parsed;
}

function getUtcDayStart(value: string): number {
  const date = new Date(value);

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function getDayDifference(fromIso: string, toIso: string): number {
  return Math.round((getUtcDayStart(toIso) - getUtcDayStart(fromIso)) / MILLISECONDS_PER_DAY);
}

function addDays(value: string, days: number): string {
  return new Date(toDateValue(value) + days * MILLISECONDS_PER_DAY).toISOString();
}

function normalizeMomentum(momentum?: Partial<AdaptiveMomentum> | null): AdaptiveMomentum {
  return {
    completedReviews: momentum?.completedReviews ?? 0,
    lastReviewCompletedAt: momentum?.lastReviewCompletedAt ?? null,
    streakDays: momentum?.streakDays ?? 0,
    xp: momentum?.xp ?? 0,
  };
}

export function getInitialMomentum(): AdaptiveMomentum {
  return normalizeMomentum();
}

function getAttemptRatio(score: number | null, totalQuestions: number | null): number | null {
  if (score === null || totalQuestions === null || totalQuestions === 0) {
    return null;
  }

  return score / totalQuestions;
}

export function getConfidenceState(score: number | null, totalQuestions: number | null): ConfidenceState {
  const ratio = getAttemptRatio(score, totalQuestions);

  if (ratio === null) {
    return 'Unattempted';
  }

  return ratio >= ADAPTIVE_CONFIDENCE_BAR ? 'Confident' : 'Needs review';
}

function getReviewState(nextDueAt: string | null, lastReviewedAt: string | null, nowIso: string): ReviewState {
  if (!lastReviewedAt || !nextDueAt) {
    return 'Not scheduled';
  }

  if (toDateValue(nextDueAt) <= toDateValue(nowIso)) {
    return 'Due now';
  }

  return getDayDifference(nowIso, nextDueAt) === 0 ? 'Due today' : 'Scheduled';
}

function getReviewPriority(reviewState: ReviewState): number {
  switch (reviewState) {
    case 'Due now':
      return 0;
    case 'Due today':
      return 1;
    case 'Scheduled':
      return 2;
    default:
      return 3;
  }
}

function getNextIntervalDays(
  scoreRatio: number,
  previousRecord: AdaptiveTopicReviewRecord | null | undefined,
): number {
  if (scoreRatio < ADAPTIVE_CONFIDENCE_BAR) {
    return 0;
  }

  const previousIntervalDays = previousRecord?.intervalDays ?? null;

  if (previousIntervalDays === null) {
    return 3;
  }

  if (previousIntervalDays <= 0) {
    return 2;
  }

  if (previousIntervalDays <= 2) {
    return 5;
  }

  if (previousIntervalDays <= 5) {
    return 9;
  }

  return Math.min(previousIntervalDays * 2, MAX_INTERVAL_DAYS);
}

export function buildNextReviewRecord(
  previousRecord: AdaptiveTopicReviewRecord | null | undefined,
  attempt: AdaptiveTopicAttempt,
): AdaptiveTopicReviewRecord {
  const scoreRatio = getAttemptRatio(attempt.score, attempt.totalQuestions) ?? 0;
  const intervalDays = getNextIntervalDays(scoreRatio, previousRecord);

  return {
    intervalDays,
    lastReviewedAt: attempt.completedAt,
    nextDueAt: addDays(attempt.completedAt, intervalDays),
    reviewCount: (previousRecord?.reviewCount ?? 0) + 1,
  };
}

function normalizeReviewRecord(
  reviewRecord: AdaptiveTopicReviewRecord | null | undefined,
  attempt: AdaptiveTopicAttempt | undefined,
): AdaptiveTopicReviewRecord {
  if (reviewRecord?.lastReviewedAt || reviewRecord?.nextDueAt || reviewRecord?.reviewCount) {
    return {
      intervalDays: reviewRecord.intervalDays ?? 0,
      lastReviewedAt: reviewRecord.lastReviewedAt ?? null,
      nextDueAt: reviewRecord.nextDueAt ?? (reviewRecord.lastReviewedAt ?? null),
      reviewCount: reviewRecord.reviewCount ?? 0,
    };
  }

  if (attempt) {
    return buildNextReviewRecord(null, attempt);
  }

  return {
    intervalDays: null,
    lastReviewedAt: null,
    nextDueAt: null,
    reviewCount: 0,
  };
}

function countDependents(topicId: string, visibleTopics: Topic[]): number {
  return visibleTopics.filter((topic) => topic.prerequisites.includes(topicId)).length;
}

function formatTopicNames(topicIds: string[]): string {
  const topicNames = topicIds.map((topicId) => getTopic(topicId).shortLabel);

  if (topicNames.length <= 1) {
    return topicNames[0] ?? '';
  }

  if (topicNames.length === 2) {
    return `${topicNames[0]} and ${topicNames[1]}`;
  }

  return `${topicNames.slice(0, -1).join(', ')}, and ${topicNames[topicNames.length - 1]}`;
}

export function getReviewTargets(topic: Topic): string[] {
  const mappedTargets = reviewTargetMap[topic.id];

  if (mappedTargets) {
    return mappedTargets;
  }

  const fallbackTargets = [
    topic.operationalNotes[0],
    topic.tradeOffs[0],
    topic.bestPracticeNotes[0]?.title,
  ].filter(Boolean) as string[];

  return fallbackTargets.slice(0, 3);
}

function getDominantState(confidentCount: number, needsReviewCount: number, unattemptedCount: number): ConfidenceState {
  if (needsReviewCount > 0) {
    return 'Needs review';
  }

  if (confidentCount > 0 && unattemptedCount === 0) {
    return 'Confident';
  }

  return 'Unattempted';
}

function buildRecommendationReason(
  topic: Topic,
  state: AdaptiveTopicState,
  visibleTopics: Topic[],
): AdaptiveRecommendation {
  const dependentCount = countDependents(topic.id, visibleTopics);
  const blockedBy = state.blockedBy;
  const scoreRatio = getAttemptRatio(state.score, state.totalQuestions);

  if (state.confidenceState === 'Needs review' && scoreRatio !== null) {
    const reviewTargets = state.reviewTargets.slice(0, 2).join(' and ');

    return {
      blockedBy: [],
      kind: 'retry',
      label: `Retry ${topic.shortLabel}`,
      reason: `${topic.name} needs review because your last topic quiz landed at ${Math.round(scoreRatio * 100)}%. Revisit ${reviewTargets} before you retry.`,
      topicId: topic.id,
    };
  }

  if (blockedBy.length > 0) {
    const blockingNames = formatTopicNames(blockedBy);

    return {
      blockedBy,
      kind: 'blocked',
      label: `Unlock ${topic.shortLabel}`,
      reason: `${topic.name} is still blocked until ${blockingNames} ${blockedBy.length === 1 ? 'is' : 'are'} confident.`,
      topicId: topic.id,
    };
  }

  if (topic.prerequisites.length === 0) {
    return {
      blockedBy: [],
      kind: 'study',
      label: `Start ${topic.shortLabel}`,
      reason:
        dependentCount > 0
          ? `${topic.name} is unattempted and prerequisite-free, so it is a strong entry point that unlocks ${dependentCount} downstream topics.`
          : `${topic.name} is unattempted and prerequisite-free, so it is ready for focused study now.`,
      topicId: topic.id,
    };
  }

  const prerequisiteNames = formatTopicNames(topic.prerequisites);

  return {
    blockedBy: [],
    kind: 'study',
    label: `Study ${topic.shortLabel}`,
    reason: `${topic.name} is unattempted and newly unlocked because ${prerequisiteNames} ${topic.prerequisites.length === 1 ? 'is' : 'are'} confident.`,
    topicId: topic.id,
  };
}

export function formatReviewTiming(nextDueAt: string | null, reviewState: ReviewState, nowIso: string): string {
  if (!nextDueAt) {
    return 'No review scheduled yet';
  }

  if (reviewState === 'Due now') {
    return 'Due now';
  }

  if (reviewState === 'Due today') {
    return 'Due later today';
  }

  const dayDifference = Math.max(1, getDayDifference(nowIso, nextDueAt));

  if (dayDifference === 1) {
    return 'Next review tomorrow';
  }

  return `Next review in ${dayDifference} days`;
}

function buildDueReviewRecommendation(
  topic: Topic,
  state: AdaptiveTopicState,
  nowIso: string,
): AdaptiveRecommendation {
  const reviewTargets = state.reviewTargets.slice(0, 2).join(' and ');
  const scoreRatio = getAttemptRatio(state.score, state.totalQuestions);
  const timingText = state.reviewState === 'Due now' ? 'due now' : 'due later today';
  const performanceText =
    scoreRatio === null
      ? 'your previous topic activity'
      : `your last topic quiz landed at ${Math.round(scoreRatio * 100)}%`;

  return {
    blockedBy: [],
    kind: 'review',
    label: state.reviewState === 'Due now' ? `Review ${topic.shortLabel} now` : `Review ${topic.shortLabel}`,
    reason: `${topic.name} is ${timingText} because ${performanceText}. Revisit ${reviewTargets} and complete the topic review from the main study flow.`,
    topicId: topic.id,
  };
}

export function isImmediateReviewState(reviewState: ReviewState): boolean {
  return reviewState === 'Due now' || reviewState === 'Due today';
}

export function isDueReviewAt(
  topicState: Pick<AdaptiveTopicState, 'lastReviewedAt' | 'nextDueAt'>,
  completedAt: string,
): boolean {
  if (!topicState.lastReviewedAt || !topicState.nextDueAt) {
    return false;
  }

  return toDateValue(topicState.nextDueAt) <= toDateValue(completedAt);
}

export function recordCompletedReviewMomentum(
  momentum: AdaptiveMomentum | null | undefined,
  completedAt: string,
): AdaptiveMomentum {
  const currentMomentum = normalizeMomentum(momentum);
  const dayDifference = currentMomentum.lastReviewCompletedAt
    ? getDayDifference(currentMomentum.lastReviewCompletedAt, completedAt)
    : null;

  const nextStreakDays =
    dayDifference === null
      ? 1
      : dayDifference <= 0
        ? Math.max(currentMomentum.streakDays, 1)
        : dayDifference === 1
          ? currentMomentum.streakDays + 1
          : 1;

  return {
    completedReviews: currentMomentum.completedReviews + 1,
    lastReviewCompletedAt: completedAt,
    streakDays: nextStreakDays,
    xp: currentMomentum.xp + REVIEW_COMPLETION_XP,
  };
}

export function deriveAdaptiveTrackSnapshot(
  trackId: CertificationTrackId,
  topicAttempts: Partial<Record<string, AdaptiveTopicAttempt>>,
  reviewRecords: Partial<Record<string, AdaptiveTopicReviewRecord>> = {},
  momentum: AdaptiveMomentum = getInitialMomentum(),
  nowIso: string = new Date().toISOString(),
): AdaptiveTrackSnapshot {
  const visibleTopics = getTopicsForTrack(trackId);

  const topicStates = Object.fromEntries(
    visibleTopics.map((topic) => {
      const attempt = topicAttempts[topic.id];
      const reviewRecord = normalizeReviewRecord(reviewRecords[topic.id], attempt);
      const confidenceState = getConfidenceState(attempt?.score ?? null, attempt?.totalQuestions ?? null);

      return [
        topic.id,
        {
          categoryId: topic.categoryId,
          completedAt: attempt?.completedAt ?? null,
          confidenceState,
          intervalDays: reviewRecord.intervalDays,
          label: topic.name,
          blockedBy: topic.prerequisites.filter((prerequisiteId) => {
            const prerequisiteAttempt = topicAttempts[prerequisiteId];

            return getConfidenceState(
              prerequisiteAttempt?.score ?? null,
              prerequisiteAttempt?.totalQuestions ?? null,
            ) !== 'Confident';
          }),
          lastReviewedAt: reviewRecord.lastReviewedAt,
          nextDueAt: reviewRecord.nextDueAt,
          prerequisites: topic.prerequisites,
          reviewCount: reviewRecord.reviewCount,
          reviewState: getReviewState(reviewRecord.nextDueAt, reviewRecord.lastReviewedAt, nowIso),
          reviewTargets: getReviewTargets(topic),
          score: attempt?.score ?? null,
          totalQuestions: attempt?.totalQuestions ?? null,
        } satisfies AdaptiveTopicState,
      ];
    }),
  ) as Record<string, AdaptiveTopicState>;

  const categoryStates = Object.fromEntries(
    [...new Set(visibleTopics.map((topic) => topic.categoryId))].map((categoryId) => {
      const categoryTopics = visibleTopics.filter((topic) => topic.categoryId === categoryId);
      const confidentCount = categoryTopics.filter(
        (topic) => topicStates[topic.id].confidenceState === 'Confident',
      ).length;
      const needsReviewCount = categoryTopics.filter(
        (topic) => topicStates[topic.id].confidenceState === 'Needs review',
      ).length;
      const unattemptedCount = categoryTopics.filter(
        (topic) => topicStates[topic.id].confidenceState === 'Unattempted',
      ).length;

      return [
        categoryId,
        {
          confidentCount,
          dominantState: getDominantState(confidentCount, needsReviewCount, unattemptedCount),
          label: getCategory(categoryId).label,
          needsReviewCount,
          topicCount: categoryTopics.length,
          topicIds: categoryTopics.map((topic) => topic.id),
          unattemptedCount,
        } satisfies AdaptiveCategoryState,
      ];
    }),
  ) as Record<string, AdaptiveCategoryState>;

  const reviewQueue = visibleTopics
    .filter((topic) => topicStates[topic.id].lastReviewedAt && topicStates[topic.id].nextDueAt)
    .sort((left, right) => {
      const leftState = topicStates[left.id];
      const rightState = topicStates[right.id];
      const reviewPriorityDifference =
        getReviewPriority(leftState.reviewState) - getReviewPriority(rightState.reviewState);

      if (reviewPriorityDifference !== 0) {
        return reviewPriorityDifference;
      }

      return toDateValue(leftState.nextDueAt as string) - toDateValue(rightState.nextDueAt as string);
    })
    .map((topic) => {
      const topicState = topicStates[topic.id];

      return {
        confidenceState: topicState.confidenceState,
        intervalDays: topicState.intervalDays,
        label: topic.name,
        nextDueAt: topicState.nextDueAt,
        reviewCount: topicState.reviewCount,
        reviewState: topicState.reviewState,
        timingLabel: formatReviewTiming(topicState.nextDueAt, topicState.reviewState, nowIso),
        topicId: topic.id,
      } satisfies AdaptiveReviewQueueItem;
    });

  const dueReviewRecommendations = reviewQueue
    .filter((item) => isImmediateReviewState(item.reviewState))
    .map((item) => buildDueReviewRecommendation(getTopic(item.topicId), topicStates[item.topicId], nowIso));
  const dueReviewTopicIds = new Set(dueReviewRecommendations.map((recommendation) => recommendation.topicId));

  const needsReviewRecommendations = visibleTopics
    .filter((topic) => {
      const state = topicStates[topic.id];

      return state.confidenceState === 'Needs review' && !dueReviewTopicIds.has(topic.id);
    })
    .sort((left, right) => {
      const leftRatio = getAttemptRatio(topicStates[left.id].score, topicStates[left.id].totalQuestions) ?? 1;
      const rightRatio = getAttemptRatio(topicStates[right.id].score, topicStates[right.id].totalQuestions) ?? 1;

      if (leftRatio !== rightRatio) {
        return leftRatio - rightRatio;
      }

      return countDependents(right.id, visibleTopics) - countDependents(left.id, visibleTopics);
    })
    .map((topic) => buildRecommendationReason(topic, topicStates[topic.id], visibleTopics));

  const readyRecommendations = visibleTopics
    .filter((topic) => {
      const state = topicStates[topic.id];

      return state.confidenceState === 'Unattempted' && state.blockedBy.length === 0;
    })
    .sort((left, right) => {
      if (left.prerequisites.length !== right.prerequisites.length) {
        return left.prerequisites.length - right.prerequisites.length;
      }

      const dependentDifference = countDependents(right.id, visibleTopics) - countDependents(left.id, visibleTopics);

      if (dependentDifference !== 0) {
        return dependentDifference;
      }

      return left.name.localeCompare(right.name);
    })
    .map((topic) => buildRecommendationReason(topic, topicStates[topic.id], visibleTopics));

  const blockedRecommendations = visibleTopics
    .filter((topic) => {
      const state = topicStates[topic.id];

      return state.confidenceState === 'Unattempted' && state.blockedBy.length > 0;
    })
    .sort((left, right) => {
      const blockedDifference = topicStates[left.id].blockedBy.length - topicStates[right.id].blockedBy.length;

      if (blockedDifference !== 0) {
        return blockedDifference;
      }

      return countDependents(right.id, visibleTopics) - countDependents(left.id, visibleTopics);
    })
    .map((topic) => buildRecommendationReason(topic, topicStates[topic.id], visibleTopics));

  return {
    categories: categoryStates,
    momentum: normalizeMomentum(momentum),
    recommendations: [
      ...dueReviewRecommendations,
      ...needsReviewRecommendations,
      ...readyRecommendations,
      ...blockedRecommendations,
    ].slice(0, MAX_RECOMMENDATIONS),
    reviewQueue,
    topics: topicStates,
  };
}

export function extractTopicAttempts(
  snapshot: AdaptiveTrackSnapshot | null | undefined,
): Partial<Record<string, AdaptiveTopicAttempt>> {
  if (!snapshot) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(snapshot.topics)
      .filter(([, topicState]) => topicState.score !== null && topicState.totalQuestions !== null && topicState.completedAt)
      .map(([topicId, topicState]) => [
        topicId,
        {
          completedAt: topicState.completedAt as string,
          score: topicState.score as number,
          totalQuestions: topicState.totalQuestions as number,
        } satisfies AdaptiveTopicAttempt,
      ]),
  );
}

export function extractTopicReviewRecords(
  snapshot: AdaptiveTrackSnapshot | null | undefined,
): Partial<Record<string, AdaptiveTopicReviewRecord>> {
  if (!snapshot) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(snapshot.topics)
      .filter(
        ([, topicState]) =>
          topicState.reviewCount > 0 || Boolean(topicState.lastReviewedAt) || Boolean(topicState.nextDueAt),
      )
      .map(([topicId, topicState]) => [
        topicId,
        {
          intervalDays: topicState.intervalDays,
          lastReviewedAt: topicState.lastReviewedAt,
          nextDueAt: topicState.nextDueAt,
          reviewCount: topicState.reviewCount,
        } satisfies AdaptiveTopicReviewRecord,
      ]),
  );
}

export function getTopicLabel(topicId: string): string {
  const topic = topics.find((entry) => entry.id === topicId);

  return topic?.name ?? topicId;
}
