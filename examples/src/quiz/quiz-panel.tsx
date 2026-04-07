import { useEffect, useMemo, useRef, useState } from 'react';
import { getReviewTargets } from '../adaptive/shared.js';
import { CertificationTrack, Topic } from '../types.js';
import { QuizGenerationResponse, requestQuiz } from './client.js';
import { getStoredQuizResult, StoredQuizResultRecord, writeQuizResult } from './storage.js';
import { buildQuizTurn, QuizMode, QuizPayload, QuizScope, scoreQuiz } from './shared.js';

interface QuizSessionState {
  completedAt: string | null;
  mode: QuizMode;
  modeLabel: string;
  quiz: QuizPayload;
  restored: boolean;
  scope: QuizScope;
  score: number | null;
  selectedAnswers: Record<string, string>;
  submitted: boolean;
}

interface QuizPanelProps {
  onTopicQuizCompleted?: (record: StoredQuizResultRecord) => void;
  reviewLaunchRequest?: {
    launchId: number;
    topicId: string;
  } | null;
  topic: Topic;
  track: CertificationTrack;
}

function createSessionFromResponse(scope: QuizScope, response: QuizGenerationResponse): QuizSessionState {
  return {
    completedAt: null,
    mode: response.mode,
    modeLabel: response.modeLabel,
    quiz: response.quiz,
    restored: false,
    scope,
    score: null,
    selectedAnswers: {},
    submitted: false,
  };
}

function createSessionFromRecord(record: StoredQuizResultRecord): QuizSessionState {
  return {
    completedAt: record.completedAt,
    mode: record.mode,
    modeLabel: record.modeLabel,
    quiz: record.quiz,
    restored: true,
    scope: record.scope,
    score: record.score,
    selectedAnswers: record.selectedAnswers,
    submitted: true,
  };
}

function formatScopeLabel(scope: QuizScope, topicName: string, trackLabel: string): string {
  return scope === 'topic' ? `${topicName} topic quiz` : `${trackLabel} track quiz`;
}

export function QuizPanel({ onTopicQuizCompleted, reviewLaunchRequest, topic, track }: QuizPanelProps) {
  const [selectedScope, setSelectedScope] = useState<QuizScope>('topic');
  const [session, setSession] = useState<QuizSessionState | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const lastHandledReviewLaunchId = useRef<number | null>(null);

  const previewGrounding = useMemo(() => {
    return buildQuizTurn({
      scope: selectedScope,
      topicId: topic.id,
      trackId: track.id,
    }).grounding;
  }, [selectedScope, topic.id, track.id]);
  const visibleGrounding = session?.quiz.grounding ?? previewGrounding;
  const allQuestionsAnswered = session
    ? session.quiz.questions.every((question) => Boolean(session.selectedAnswers[question.id]))
    : false;
  const weakTopicResult =
    session?.submitted && session.scope === 'topic' && session.score !== null && session.score / session.quiz.questions.length < 0.75
      ? {
          reviewTargets: getReviewTargets(topic),
          scorePercent: Math.round((session.score / session.quiz.questions.length) * 100),
        }
      : null;

  useEffect(() => {
    activeController.current?.abort();
    activeController.current = null;
    setInlineError(null);
    setStatus('idle');

    const stored = getStoredQuizResult(selectedScope, topic.id, track.id);
    setSession(stored ? createSessionFromRecord(stored) : null);
  }, [selectedScope, topic.id, track.id]);

  useEffect(() => {
    return () => {
      activeController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!reviewLaunchRequest || reviewLaunchRequest.topicId !== topic.id) {
      return;
    }

    if (lastHandledReviewLaunchId.current === reviewLaunchRequest.launchId) {
      return;
    }

    lastHandledReviewLaunchId.current = reviewLaunchRequest.launchId;
    void handleGenerateQuiz('topic');
  }, [reviewLaunchRequest, topic.id]);

  async function handleGenerateQuiz(scopeOverride?: QuizScope) {
    if (status === 'loading') {
      return;
    }

    const nextScope = scopeOverride ?? selectedScope;

    activeController.current?.abort();

    const controller = new AbortController();
    activeController.current = controller;
    setInlineError(null);
    setStatus('loading');

    try {
      const response = await requestQuiz(
        {
          scope: nextScope,
          topicId: topic.id,
          trackId: track.id,
        },
        controller.signal,
      );

      setSelectedScope(nextScope);
      setSession(createSessionFromResponse(nextScope, response));
      setStatus('idle');
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setInlineError(error instanceof Error ? error.message : 'The quiz could not be generated.');
      setStatus('idle');
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
      }
    }
  }

  function handleAnswerChange(questionId: string, choiceId: string) {
    setSession((current) => {
      if (!current || current.submitted) {
        return current;
      }

      return {
        ...current,
        restored: false,
        selectedAnswers: {
          ...current.selectedAnswers,
          [questionId]: choiceId,
        },
      };
    });
  }

  function handleSubmitQuiz() {
    if (!session || session.submitted || !allQuestionsAnswered) {
      return;
    }

    const nextScore = scoreQuiz(session.quiz, session.selectedAnswers);
    const completedAt = new Date().toISOString();
    const storedRecord: StoredQuizResultRecord = {
      topicId: selectedScope === 'topic' ? topic.id : null,
      trackId: track.id,
      scope: selectedScope,
      score: nextScore,
      totalQuestions: session.quiz.questions.length,
      completedAt,
      mode: session.mode,
      modeLabel: session.modeLabel,
      quiz: session.quiz,
      selectedAnswers: session.selectedAnswers,
    };

    writeQuizResult(storedRecord);
    if (selectedScope === 'topic') {
      onTopicQuizCompleted?.(storedRecord);
    }
    setSession({
      ...session,
      completedAt,
      restored: false,
      score: nextScore,
      submitted: true,
    });
  }

  return (
    <section className="quiz-card" aria-label="AWS quiz">
      <div className="section-heading">
        <div>
          <p className="eyebrow">AI-generated quiz</p>
          <h3>Check your AWS reasoning without leaving the study shell</h3>
        </div>
        <div className="tutor-badges">
          {session?.modeLabel ? (
            <span className={`mode-badge ${session.mode === 'mock' ? 'mock' : 'live'}`}>{session.modeLabel}</span>
          ) : null}
          <span className="topic-badge">{track.label}</span>
        </div>
      </div>

      <p className="quiz-intro">
        Generate a topic or track quiz inline, keep the current AWS notes visible above, and review AWS-specific
        explanations after you submit.
      </p>

      <div className="quiz-scope-switcher" role="tablist" aria-label="Quiz scope">
        <button
          type="button"
          className={`scope-button ${selectedScope === 'topic' ? 'active' : ''}`}
          aria-selected={selectedScope === 'topic'}
          onClick={() => setSelectedScope('topic')}
        >
          Current topic
        </button>
        <button
          type="button"
          className={`scope-button ${selectedScope === 'track' ? 'active' : ''}`}
          aria-selected={selectedScope === 'track'}
          onClick={() => setSelectedScope('track')}
        >
          Current track
        </button>
      </div>

      <div className="quiz-actions-card">
        <div>
          <p className="quiz-target-label">Selected quiz scope</p>
          <h4>{formatScopeLabel(selectedScope, topic.name, track.label)}</h4>
          <p className="quiz-target-copy">
            {selectedScope === 'topic'
              ? `Generate a grounded quiz from ${topic.name} while keeping the ${topic.name} study notes in view.`
              : `Generate a grounded quiz across ${track.label} topics while keeping ${topic.name} open in the study flow.`}
          </p>
        </div>
        <button type="button" className="submit-button" onClick={() => void handleGenerateQuiz()} disabled={status === 'loading'}>
          {status === 'loading'
            ? 'Generating quiz...'
            : selectedScope === 'topic'
              ? 'Generate topic quiz'
              : 'Generate track quiz'}
        </button>
      </div>

      {status === 'loading' ? (
        <p className="quiz-loading">Building a grounded AWS quiz from the current {selectedScope} context now.</p>
      ) : null}

      {session ? (
        <section className="quiz-surface">
          <div className="quiz-surface-header">
            <div>
              <h4>{session.quiz.title}</h4>
              <p className="quiz-target-copy">
                {session.restored
                  ? 'Restored the latest completed attempt saved in local storage for this scope.'
                  : session.submitted
                    ? 'Latest completed attempt saved locally for refresh-safe review.'
                    : 'Answer every question once, then score the attempt inline.'}
              </p>
            </div>
            {session.submitted && session.score !== null ? (
              <div className="quiz-score-card">
                <strong>
                  {session.score}/{session.quiz.questions.length}
                </strong>
                <span>{Math.round((session.score / session.quiz.questions.length) * 100)}%</span>
              </div>
            ) : null}
          </div>

          <div className="quiz-question-stack">
            {session.quiz.questions.map((question, index) => {
              const selectedChoiceId = session.selectedAnswers[question.id];
              const isCorrect = session.submitted && selectedChoiceId === question.correctChoiceId;
              const correctChoice = question.choices.find((choice) => choice.id === question.correctChoiceId);

              return (
                <fieldset
                  key={question.id}
                  className={`quiz-question-card ${session.submitted ? (isCorrect ? 'correct' : 'incorrect') : ''}`}
                  data-testid="quiz-question"
                >
                  <legend>
                    <span className="quiz-question-number">Question {index + 1}</span>
                    <strong>{question.stem}</strong>
                  </legend>
                  <div className="quiz-choice-list">
                    {question.choices.map((choice) => {
                      const isSelected = selectedChoiceId === choice.id;

                      return (
                        <label
                          key={choice.id}
                          className={`quiz-choice ${isSelected ? 'selected' : ''} ${
                            session.submitted && question.correctChoiceId === choice.id ? 'answer' : ''
                          }`}
                        >
                          <input
                            type="radio"
                            name={question.id}
                            value={choice.id}
                            checked={isSelected}
                            onChange={() => handleAnswerChange(question.id, choice.id)}
                            disabled={session.submitted}
                          />
                          <span>{choice.text}</span>
                        </label>
                      );
                    })}
                  </div>

                  {session.submitted ? (
                    <div className="quiz-feedback-panel">
                      <p className={`quiz-result-badge ${isCorrect ? 'correct' : 'incorrect'}`}>
                        {isCorrect ? 'Correct' : 'Incorrect'}
                      </p>
                      <p className="quiz-correct-answer">
                        Correct answer: <strong>{correctChoice?.text}</strong>
                      </p>
                      <p className="quiz-explanation">{question.explanation}</p>
                    </div>
                  ) : null}
                </fieldset>
              );
            })}
          </div>

          {!session.submitted ? (
            <div className="quiz-submit-row">
              <button type="button" className="submit-button" disabled={!allQuestionsAnswered} onClick={handleSubmitQuiz}>
                Submit quiz
              </button>
              {!allQuestionsAnswered ? (
                <p className="quiz-target-copy">
                  Answer all {session.quiz.questions.length} questions to score the latest attempt.
                </p>
              ) : null}
            </div>
          ) : null}

          {session.completedAt ? <p className="quiz-saved-note">Saved locally at {session.completedAt}.</p> : null}

          {weakTopicResult ? (
            <section className="remediation-card" aria-label="Quiz remediation" data-testid="quiz-remediation">
              <div className="adaptive-row">
                <div>
                  <p className="eyebrow">Remediation path</p>
                  <h4>Review {topic.name} before the next retry</h4>
                </div>
                <span className="state-pill needs-review">Needs review</span>
              </div>
              <p className="quiz-target-copy">
                Your last {topic.name} topic quiz landed at {weakTopicResult.scorePercent}%, which is below the 75%
                confidence bar. Revisit these AWS concepts, then retry from this same study flow.
              </p>
              <ul className="remediation-target-list">
                {weakTopicResult.reviewTargets.map((reviewTarget) => (
                  <li key={reviewTarget}>{reviewTarget}</li>
                ))}
              </ul>
              <div className="quiz-submit-row">
                <button
                  type="button"
                  className="submit-button"
                  onClick={() => void handleGenerateQuiz('topic')}
                  disabled={status === 'loading'}
                >
                  Retry topic quiz
                </button>
                <p className="quiz-target-copy">
                  The retry keeps {topic.name}, its study notes, and this remediation path in the same page context.
                </p>
              </div>
            </section>
          ) : null}
        </section>
      ) : (
        <p className="quiz-empty">
          No {selectedScope} quiz is open yet. Generate one here and keep the current AWS topic notes alongside it.
        </p>
      )}

      {inlineError ? <p className="tutor-error">{inlineError}</p> : null}

      <details className="grounding-panel" open={Boolean(visibleGrounding)}>
        <summary>Quiz context</summary>
        <div className="grounding-details">
          <div className="grounding-metadata">
            <div>
              <span>Scope</span>
              <strong>{visibleGrounding.scope}</strong>
            </div>
            <div>
              <span>Active topic</span>
              <strong>{visibleGrounding.activeTopicName}</strong>
            </div>
            <div>
              <span>Certification track</span>
              <strong>{visibleGrounding.trackLabel}</strong>
            </div>
          </div>
          <div>
            <span className="grounding-label">AWS source topics</span>
            <p className="quiz-source-topics">
              {visibleGrounding.sourceTopics.map((sourceTopic) => sourceTopic.topicName).join(' • ')}
            </p>
          </div>
          <div>
            <span className="grounding-label">Retrieved AWS snippets</span>
            <ul className="grounding-snippet-list">
              {visibleGrounding.snippets.map((snippet) => (
                <li key={snippet.id} className="grounding-snippet">
                  <strong>{snippet.title}</strong>
                  <p>{snippet.excerpt}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}
