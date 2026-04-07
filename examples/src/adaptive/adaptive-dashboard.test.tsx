import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.js';
import { recordTopicQuizResult } from './storage.js';
import { StoredQuizResultRecord } from '../quiz/storage.js';
import { getTopicLabel } from './shared.js';

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-06T22:15:00.000Z'));
});

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('adaptive dashboard', () => {
  it('rehydrates persisted review obligations, momentum, and next-step recommendations after remount', () => {
    recordTopicQuizResult(createTopicRecord('s3', 4, '2026-04-06T22:00:00.000Z'));
    recordTopicQuizResult(createTopicRecord('iam', 2, '2026-04-06T22:05:00.000Z'));
    recordTopicQuizResult(createTopicRecord('iam', 3, '2026-04-06T22:10:00.000Z'));

    const { unmount } = render(<App />);

    expect(screen.getByRole('heading', { name: /Confidence, review timing, and learning momentum/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('review-item-iam')).getByText('Scheduled')).toBeInTheDocument();
    expect(within(screen.getByTestId('review-item-iam')).getByText(/Next review in 2 days/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('review-item-s3')).getByText(/Next review in 3 days/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('momentum-xp')).getByText('30')).toBeInTheDocument();
    expect(within(screen.getByTestId('momentum-streak')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('momentum-completed')).getByText('1')).toBeInTheDocument();

    const firstRecommendation = screen.getAllByTestId('recommendation-item')[0];

    expect(firstRecommendation.textContent).not.toContain('IAM');

    unmount();
    render(<App />);

    expect(within(screen.getByTestId('review-item-iam')).getByText('Scheduled')).toBeInTheDocument();
    expect(within(screen.getByTestId('review-item-s3')).getByText(/Next review in 3 days/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('momentum-xp')).getByText('30')).toBeInTheDocument();
    expect(screen.getAllByTestId('recommendation-item')[0].textContent).not.toContain('IAM');
  });
});
