import { describe, expect, it } from 'vitest';
import { buildQuizTurn, generateMockQuiz, hasScenarioQuestion } from './shared.js';

describe('quiz grounding and question generation', () => {
  it('assembles different grounding for topic and track quiz scopes', () => {
    const topicQuiz = buildQuizTurn({
      scope: 'topic',
      topicId: 's3',
      trackId: 'cloud-practitioner',
    });
    const trackQuiz = buildQuizTurn({
      scope: 'track',
      topicId: 's3',
      trackId: 'cloud-practitioner',
    });

    expect(topicQuiz.grounding.scope).toBe('topic');
    expect(topicQuiz.grounding.topicName).toBe('Amazon S3');
    expect(topicQuiz.grounding.sourceTopics[0]?.topicName).toBe('Amazon S3');
    expect(trackQuiz.grounding.scope).toBe('track');
    expect(trackQuiz.grounding.topicName).toBeNull();
    expect(trackQuiz.grounding.trackLabel).toBe('Cloud Practitioner');
    expect(trackQuiz.grounding.sourceTopics.length).toBeGreaterThan(1);
    expect(trackQuiz.grounding.sourceTopics.some((topic) => topic.topicName !== 'Amazon S3')).toBe(true);
    expect(trackQuiz.grounding.snippets.map((snippet) => snippet.excerpt)).not.toEqual(
      topicQuiz.grounding.snippets.map((snippet) => snippet.excerpt),
    );
  });

  it('generates a scenario-led quiz with AWS-specific explanations', () => {
    const quiz = generateMockQuiz(
      buildQuizTurn({
        scope: 'topic',
        topicId: 's3',
        trackId: 'cloud-practitioner',
      }),
    );

    expect(quiz.questions).toHaveLength(4);
    expect(quiz.questions.every((question) => question.choices.length >= 3)).toBe(true);
    expect(hasScenarioQuestion(quiz)).toBe(true);
    expect(quiz.questions[0].stem).toMatch(/Scenario:/);
    expect(quiz.questions.some((question) => /Shared Responsibility Model|AWS Well-Architected Framework|Amazon S3/i.test(question.explanation))).toBe(true);
  });

  it('uses a different lead scenario for track quizzes than for topic quizzes', () => {
    const topicTurn = buildQuizTurn({
      scope: 'topic',
      topicId: 's3',
      trackId: 'cloud-practitioner',
    });
    const trackTurn = buildQuizTurn({
      scope: 'track',
      topicId: 's3',
      trackId: 'cloud-practitioner',
    });

    const topicQuiz = generateMockQuiz(topicTurn);
    const trackQuiz = generateMockQuiz(trackTurn);
    const expectedTrackTopicId = trackTurn.grounding.sourceTopics[1]?.topicId ?? trackTurn.grounding.activeTopicId;

    expect(topicQuiz.questions[0].id).toBe('s3-scenario-1');
    expect(trackQuiz.questions[0].id).toBe(`${expectedTrackTopicId}-scenario-1`);
    expect(trackQuiz.questions[0].stem).not.toBe(topicQuiz.questions[0].stem);
  });
});
