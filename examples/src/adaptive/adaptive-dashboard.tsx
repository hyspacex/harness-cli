import { CertificationTrack } from '../types.js';
import { AdaptiveRecommendation, AdaptiveTopicState, isImmediateReviewState } from './shared.js';
import { StoredAdaptiveState } from './storage.js';

interface AdaptiveDashboardProps {
  activeTopicId: string;
  adaptiveState: StoredAdaptiveState;
  onSelectTopic: (topicId: string) => void;
  onStartReview: (topicId: string) => void;
  track: CertificationTrack;
}

function getStateClassName(state: string): string {
  return state.toLowerCase().replace(/\s+/g, '-');
}

function formatScore(score: number | null, totalQuestions: number | null): string {
  if (score === null || totalQuestions === null) {
    return 'No topic quiz yet';
  }

  return `${score}/${totalQuestions} correct`;
}

function formatInterval(intervalDays: number | null): string {
  if (intervalDays === null) {
    return 'No schedule yet';
  }

  if (intervalDays === 0) {
    return 'Same-day follow-up';
  }

  if (intervalDays === 1) {
    return '1 day';
  }

  return `${intervalDays} days`;
}

function formatTopicProgressCopy(topicState: AdaptiveTopicState): string {
  const scoreLabel = formatScore(topicState.score, topicState.totalQuestions);

  if (!topicState.lastReviewedAt || !topicState.nextDueAt) {
    return scoreLabel;
  }

  return `${scoreLabel} • ${topicState.reviewState}`;
}

function getRecommendationButtonLabel(recommendation: AdaptiveRecommendation): string {
  if (recommendation.kind === 'review') {
    return 'Start review';
  }

  if (recommendation.kind === 'retry') {
    return 'Open retry path';
  }

  return 'Open topic';
}

export function AdaptiveDashboard({
  activeTopicId,
  adaptiveState,
  onSelectTopic,
  onStartReview,
  track,
}: AdaptiveDashboardProps) {
  const topicStates = Object.entries(adaptiveState.topics);
  const categoryStates = Object.entries(adaptiveState.categories);
  const confidentTopics = topicStates.filter(([, topicState]) => topicState.confidenceState === 'Confident').length;
  const needsReviewTopics = topicStates.filter(([, topicState]) => topicState.confidenceState === 'Needs review').length;
  const unattemptedTopics = topicStates.filter(([, topicState]) => topicState.confidenceState === 'Unattempted').length;
  const dueReviewCount = adaptiveState.reviewQueue.filter((item) => isImmediateReviewState(item.reviewState)).length;

  return (
    <section className="adaptive-card" aria-labelledby="adaptive-dashboard-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Adaptive dashboard</p>
          <h2 id="adaptive-dashboard-heading">Confidence, review timing, and learning momentum</h2>
        </div>
        <div className="tutor-badges">
          <span className="topic-badge">{track.label}</span>
        </div>
      </div>

      <div className="adaptive-summary-grid">
        <article className="adaptive-summary-card">
          <span className="grounding-label">Confident topics</span>
          <strong>{confidentTopics}</strong>
          <p>Topics above the 75% confidence bar from completed topic quizzes.</p>
        </article>
        <article className="adaptive-summary-card">
          <span className="grounding-label">Needs review</span>
          <strong>{needsReviewTopics}</strong>
          <p>Weak quiz results rise here first so remediation outranks new downstream content.</p>
        </article>
        <article className="adaptive-summary-card">
          <span className="grounding-label">Unattempted</span>
          <strong>{unattemptedTopics}</strong>
          <p>These topics stay visible until the learner covers the active track more completely.</p>
        </article>
        <article className="adaptive-summary-card" data-testid="momentum-xp">
          <span className="grounding-label">XP total</span>
          <strong>{adaptiveState.momentum.xp}</strong>
          <p>Earned from completed due reviews that move the spaced-review loop forward.</p>
        </article>
        <article className="adaptive-summary-card" data-testid="momentum-streak">
          <span className="grounding-label">Streak days</span>
          <strong>{adaptiveState.momentum.streakDays}</strong>
          <p>Increases when review completions land on consecutive UTC days.</p>
        </article>
        <article className="adaptive-summary-card" data-testid="momentum-completed">
          <span className="grounding-label">Completed reviews</span>
          <strong>{adaptiveState.momentum.completedReviews}</strong>
          <p>Counts the due reviews that were finished from the main study flow.</p>
        </article>
      </div>

      <section className="adaptive-panel" data-testid="review-panel">
        <div className="adaptive-panel-heading">
          <div>
            <p className="eyebrow">Review loop</p>
            <h3>Due now and next scheduled reviews</h3>
          </div>
          <span className={`state-pill ${dueReviewCount > 0 ? 'due-now' : 'scheduled'}`}>
            {dueReviewCount > 0 ? `${dueReviewCount} due now` : 'Next review scheduled'}
          </span>
        </div>

        {adaptiveState.reviewQueue.length > 0 ? (
          <div className="review-queue-list">
            {adaptiveState.reviewQueue.map((item) => (
              <article
                key={`review-queue-${item.topicId}`}
                className={`review-queue-card ${isImmediateReviewState(item.reviewState) ? 'due' : 'scheduled'}`}
                data-testid={`review-item-${item.topicId}`}
              >
                <div className="adaptive-row">
                  <div>
                    <strong>{item.label}</strong>
                    <p className="adaptive-copy">{item.timingLabel}</p>
                  </div>
                  <span className={`state-pill ${getStateClassName(item.reviewState)}`}>{item.reviewState}</span>
                </div>
                <div className="review-meta-row">
                  <div>
                    <span className="grounding-label">Next interval</span>
                    <strong>{formatInterval(item.intervalDays)}</strong>
                  </div>
                  <div>
                    <span className="grounding-label">Review count</span>
                    <strong>{item.reviewCount}</strong>
                  </div>
                  <div>
                    <span className="grounding-label">Confidence</span>
                    <strong>{item.confidenceState}</strong>
                  </div>
                </div>
                {isImmediateReviewState(item.reviewState) ? (
                  <button
                    type="button"
                    className="relationship-chip"
                    onClick={() => onStartReview(item.topicId)}
                  >
                    Start review
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="adaptive-empty">
            Finish a topic quiz and the next scheduled review will appear here with due timing and spaced intervals.
          </p>
        )}
      </section>

      <div className="adaptive-grid">
        <section className="adaptive-panel">
          <div className="adaptive-panel-heading">
            <div>
              <p className="eyebrow">Category confidence</p>
              <h3>Service-category rollup</h3>
            </div>
          </div>
          <div className="category-progress-grid">
            {categoryStates.map(([categoryId, categoryState]) => (
              <article key={categoryId} className="category-progress-card" data-testid={`category-progress-${categoryId}`}>
                <div className="adaptive-row">
                  <strong>{categoryState.label}</strong>
                  <span className={`state-pill ${getStateClassName(categoryState.dominantState)}`}>
                    {categoryState.dominantState}
                  </span>
                </div>
                <p className="adaptive-copy">
                  {categoryState.confidentCount} confident • {categoryState.needsReviewCount} needs review •{' '}
                  {categoryState.unattemptedCount} unattempted
                </p>
              </article>
            ))}
          </div>
        </section>

        <section className="adaptive-panel">
          <div className="adaptive-panel-heading">
            <div>
              <p className="eyebrow">Recommended next</p>
              <h3>Queue that reacts to review timing and quiz outcomes</h3>
            </div>
          </div>
          {adaptiveState.recommendations.length > 0 ? (
            <div className="recommendation-list">
              {adaptiveState.recommendations.map((recommendation, index) => (
                <article
                  key={`${recommendation.kind}-${recommendation.topicId}`}
                  className="recommendation-card"
                  data-testid="recommendation-item"
                >
                  <div className="adaptive-row">
                    <div>
                      <span className="recommendation-rank">#{index + 1}</span>
                      <strong>{recommendation.label}</strong>
                    </div>
                    <span className={`recommendation-kind ${recommendation.kind}`}>{recommendation.kind}</span>
                  </div>
                  <p className="adaptive-copy">{recommendation.reason}</p>
                  <button
                    type="button"
                    className="relationship-chip"
                    onClick={() =>
                      recommendation.kind === 'review'
                        ? onStartReview(recommendation.topicId)
                        : onSelectTopic(recommendation.topicId)
                    }
                  >
                    {getRecommendationButtonLabel(recommendation)}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="adaptive-empty">
              No unattempted, due-review, or needs-review topics remain for this track. The current topic list is
              exhausted for the prototype scope.
            </p>
          )}
        </section>
      </div>

      <section className="adaptive-panel">
        <div className="adaptive-panel-heading">
          <div>
            <p className="eyebrow">Topic confidence</p>
            <h3>Quiz-derived topic states</h3>
          </div>
        </div>
        <div className="topic-progress-list">
          {topicStates.map(([topicId, topicState]) => (
            <button
              key={topicId}
              type="button"
              className={`topic-progress-row ${topicId === activeTopicId ? 'active' : ''}`}
              data-testid={`topic-progress-${topicId}`}
              onClick={() => onSelectTopic(topicId)}
            >
              <div>
                <strong>{topicState.label}</strong>
                <p className="adaptive-copy">{formatTopicProgressCopy(topicState)}</p>
              </div>
              <span className={`state-pill ${getStateClassName(topicState.confidenceState)}`}>
                {topicState.confidenceState}
              </span>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
