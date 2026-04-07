import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.js';
import { QUIZ_RESULTS_STORAGE_KEY } from './storage.js';

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createQuizResponse(scope: 'topic' | 'track') {
  return {
    grounding: {
      scope,
      topicId: scope === 'topic' ? 's3' : null,
      topicName: scope === 'topic' ? 'Amazon S3' : null,
      activeTopicId: 's3',
      activeTopicName: 'Amazon S3',
      trackId: 'cloud-practitioner',
      trackLabel: 'Cloud Practitioner',
      title: scope === 'topic' ? 'Amazon S3 topic quiz' : 'Cloud Practitioner track quiz',
      sourceTopics:
        scope === 'topic'
          ? [
              { topicId: 's3', topicName: 'Amazon S3' },
              { topicId: 'ebs', topicName: 'Amazon EBS' },
            ]
          : [
              { topicId: 's3', topicName: 'Amazon S3' },
              { topicId: 'lambda', topicName: 'AWS Lambda' },
              { topicId: 'iam', topicName: 'AWS Identity and Access Management (IAM)' },
              { topicId: 'rds', topicName: 'Amazon RDS' },
            ],
      snippets:
        scope === 'topic'
          ? [
              {
                id: 's3-overview',
                topicId: 's3',
                topicName: 'Amazon S3',
                title: 'Amazon S3 overview',
                excerpt: 'Amazon S3 is AWS object storage for durable assets and backups.',
                source: 'overview',
              },
            ]
          : [
              {
                id: 'track-s3-overview',
                topicId: 's3',
                topicName: 'Amazon S3',
                title: 'Amazon S3 overview',
                excerpt: 'Amazon S3 is AWS object storage for durable assets and backups.',
                source: 'overview',
              },
              {
                id: 'track-lambda-overview',
                topicId: 'lambda',
                topicName: 'AWS Lambda',
                title: 'AWS Lambda overview',
                excerpt: 'AWS Lambda runs code in response to events without managing servers.',
                source: 'overview',
              },
            ],
    },
    mode: 'mock' as const,
    modeLabel: 'Demo mode',
    quiz: {
      id: scope === 'topic' ? 'topic-s3' : 'track-cp',
      scope,
      title: scope === 'topic' ? 'Amazon S3 topic quiz' : 'Cloud Practitioner track quiz',
      grounding: {
        scope,
        topicId: scope === 'topic' ? 's3' : null,
        topicName: scope === 'topic' ? 'Amazon S3' : null,
        activeTopicId: 's3',
        activeTopicName: 'Amazon S3',
        trackId: 'cloud-practitioner',
        trackLabel: 'Cloud Practitioner',
        title: scope === 'topic' ? 'Amazon S3 topic quiz' : 'Cloud Practitioner track quiz',
        sourceTopics:
          scope === 'topic'
            ? [
                { topicId: 's3', topicName: 'Amazon S3' },
                { topicId: 'ebs', topicName: 'Amazon EBS' },
              ]
            : [
                { topicId: 's3', topicName: 'Amazon S3' },
                { topicId: 'lambda', topicName: 'AWS Lambda' },
                { topicId: 'iam', topicName: 'AWS Identity and Access Management (IAM)' },
                { topicId: 'rds', topicName: 'Amazon RDS' },
              ],
        snippets:
          scope === 'topic'
            ? [
                {
                  id: 's3-overview',
                  topicId: 's3',
                  topicName: 'Amazon S3',
                  title: 'Amazon S3 overview',
                  excerpt: 'Amazon S3 is AWS object storage for durable assets and backups.',
                  source: 'overview',
                },
              ]
            : [
                {
                  id: 'track-s3-overview',
                  topicId: 's3',
                  topicName: 'Amazon S3',
                  title: 'Amazon S3 overview',
                  excerpt: 'Amazon S3 is AWS object storage for durable assets and backups.',
                  source: 'overview',
                },
                {
                  id: 'track-lambda-overview',
                  topicId: 'lambda',
                  topicName: 'AWS Lambda',
                  title: 'AWS Lambda overview',
                  excerpt: 'AWS Lambda runs code in response to events without managing servers.',
                  source: 'overview',
                },
              ],
      },
      questions: [
        {
          id: `${scope}-q1`,
          stem:
            'Scenario: A team needs durable object storage for website assets and backups without attaching a volume to Amazon EC2. Which AWS service is the best fit?',
          correctChoiceId: `${scope}-q1-choice-2`,
          explanation:
            'Amazon S3 is the best answer because it provides durable object storage for shared assets, while Amazon EBS is attached block storage for EC2.',
          choices: [
            { id: `${scope}-q1-choice-1`, text: 'Amazon EBS' },
            { id: `${scope}-q1-choice-2`, text: 'Amazon S3' },
            { id: `${scope}-q1-choice-3`, text: 'Amazon RDS' },
            { id: `${scope}-q1-choice-4`, text: 'AWS Lambda' },
          ],
        },
        {
          id: `${scope}-q2`,
          stem: 'Which study note best reflects the Shared Responsibility Model for Amazon S3?',
          correctChoiceId: `${scope}-q2-choice-1`,
          explanation:
            'The Shared Responsibility Model applies directly to Amazon S3: AWS secures the service, while you configure bucket policies, encryption, and public access settings.',
          choices: [
            {
              id: `${scope}-q2-choice-1`,
              text: 'AWS secures the managed storage platform, while you remain responsible for bucket policies, encryption choices, and who can read the data.',
            },
            {
              id: `${scope}-q2-choice-2`,
              text: 'AWS automatically writes least-privilege policies after a bucket is created, so customer access reviews are optional.',
            },
            {
              id: `${scope}-q2-choice-3`,
              text: 'The Shared Responsibility Model applies only to Amazon EC2 and not to managed services such as Amazon S3.',
            },
            {
              id: `${scope}-q2-choice-4`,
              text: 'S3 security is only about storage class selection, not about identity or encryption settings.',
            },
          ],
        },
        {
          id: `${scope}-q3`,
          stem: scope === 'topic' ? 'Which trade-off should you remember about Amazon S3?' : 'Which trade-off should you remember about AWS Lambda?',
          correctChoiceId: `${scope}-q3-choice-3`,
          explanation:
            scope === 'topic'
              ? 'Amazon S3 is object storage, so workloads that need low-latency block access or direct in-place edits should use another pattern such as Amazon EBS.'
              : 'AWS Lambda reduces server management, but cold starts and execution limits still matter when comparing it with Amazon EC2.',
          choices: [
            { id: `${scope}-q3-choice-1`, text: 'It is always the best answer for any AWS exam scenario.' },
            { id: `${scope}-q3-choice-2`, text: 'It removes the need to reason about operational trade-offs.' },
            {
              id: `${scope}-q3-choice-3`,
              text:
                scope === 'topic'
                  ? 'S3 is object storage, so workloads that need block access or direct in-place edits should use another pattern.'
                  : 'Lambda reduces server management, but cold starts and execution duration limits still shape workload fit.',
            },
            { id: `${scope}-q3-choice-4`, text: 'It is mainly a pricing feature and rarely a service-selection decision.' },
          ],
        },
        {
          id: `${scope}-q4`,
          stem: scope === 'topic' ? 'Which operational checkpoint matters most for Amazon S3?' : 'Which operational checkpoint matters most for Amazon RDS?',
          correctChoiceId: `${scope}-q4-choice-4`,
          explanation:
            scope === 'topic'
              ? 'Bucket policies, versioning, access logs, and lifecycle rules all affect recoverability and governance for Amazon S3.'
              : 'Backups, parameter groups, Multi-AZ failover, and read replicas determine how Amazon RDS behaves under load or during incidents.',
          choices: [
            { id: `${scope}-q4-choice-1`, text: 'It no longer needs monitoring after deployment.' },
            { id: `${scope}-q4-choice-2`, text: 'It is mainly a branding decision, not an operational one.' },
            { id: `${scope}-q4-choice-3`, text: 'Its use cases matter, but operations rarely change AWS architectures.' },
            {
              id: `${scope}-q4-choice-4`,
              text:
                scope === 'topic'
                  ? 'Bucket policies, versioning, access logs, and lifecycle rules are operational controls that influence recoverability and governance.'
                  : 'Backups, parameter groups, Multi-AZ failover, and read replicas are operational settings that determine resilience and incident behavior.',
            },
          ],
        },
      ],
    },
  };
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('Quiz panel', () => {
  it('keeps topic content visible while rendering topic and track quizzes inline', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      const payload = JSON.parse(String(options?.body ?? '{}')) as { scope: 'topic' | 'track' };
      await wait(30);

      return new Response(JSON.stringify(createQuizResponse(payload.scope)), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(screen.getByRole('heading', { name: 'Amazon S3' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Use cases' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Generate topic quiz/i }));

    expect(screen.getByText(/Generating quiz/i)).toBeInTheDocument();
    expect(await screen.findByText(/Demo mode/i)).toBeInTheDocument();
    expect(await screen.findByText(/Scenario: A team needs durable object storage/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Amazon S3' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Use cases' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(16);

    await user.click(screen.getByRole('button', { name: /Current track/i }));
    await user.click(screen.getByRole('button', { name: /Generate track quiz/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId('quiz-question')).toHaveLength(4);
    });
    expect(screen.getByRole('heading', { name: 'Amazon S3' })).toBeInTheDocument();
    expect(screen.getAllByText(/Cloud Practitioner/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Amazon S3 • AWS Lambda • AWS Identity and Access Management \(IAM\) • Amazon RDS/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('scores completed quizzes, writes the storage contract, and restores latest topic and track attempts', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url, options) => {
        const payload = JSON.parse(String(options?.body ?? '{}')) as { scope: 'topic' | 'track' };
        await wait(30);

        return new Response(JSON.stringify(createQuizResponse(payload.scope)), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }),
    );

    const { unmount } = render(<App />);

    await user.click(screen.getByRole('button', { name: /Generate topic quiz/i }));
    await screen.findByText(/Demo mode/i);

    const topicQuestions = await screen.findAllByTestId('quiz-question');

    await user.click(within(topicQuestions[0]).getAllByRole('radio')[1]);
    await user.click(within(topicQuestions[1]).getAllByRole('radio')[0]);
    await user.click(within(topicQuestions[2]).getAllByRole('radio')[2]);
    await user.click(within(topicQuestions[3]).getAllByRole('radio')[3]);
    await user.click(screen.getByRole('button', { name: /Submit quiz/i }));

    expect(await screen.findByText('4/4')).toBeInTheDocument();
    expect(screen.getAllByText(/Correct/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Shared Responsibility Model applies directly to Amazon S3/i).length).toBeGreaterThan(0);

    let storedValue = JSON.parse(window.localStorage.getItem(QUIZ_RESULTS_STORAGE_KEY) ?? '{}');

    expect(storedValue.topic.scope).toBe('topic');
    expect(storedValue.topic.topicId).toBe('s3');
    expect(storedValue.topic.trackId).toBe('cloud-practitioner');
    expect(storedValue.topic.score).toBe(4);
    expect(storedValue.topic.totalQuestions).toBe(4);
    expect(Date.parse(storedValue.topic.completedAt)).not.toBeNaN();

    await user.click(screen.getByRole('button', { name: /Current track/i }));
    await user.click(screen.getByRole('button', { name: /Generate track quiz/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId('quiz-question')).toHaveLength(4);
    });

    const trackQuestions = await screen.findAllByTestId('quiz-question');

    await user.click(within(trackQuestions[0]).getAllByRole('radio')[0]);
    await user.click(within(trackQuestions[1]).getAllByRole('radio')[0]);
    await user.click(within(trackQuestions[2]).getAllByRole('radio')[2]);
    await user.click(within(trackQuestions[3]).getAllByRole('radio')[3]);
    await user.click(screen.getByRole('button', { name: /Submit quiz/i }));

    expect(await screen.findByText('3/4')).toBeInTheDocument();

    storedValue = JSON.parse(window.localStorage.getItem(QUIZ_RESULTS_STORAGE_KEY) ?? '{}');

    expect(storedValue.track.scope).toBe('track');
    expect(storedValue.track.topicId).toBeNull();
    expect(storedValue.track.trackId).toBe('cloud-practitioner');
    expect(storedValue.track.score).toBe(3);
    expect(storedValue.track.totalQuestions).toBe(4);
    expect(Date.parse(storedValue.track.completedAt)).not.toBeNaN();

    unmount();
    render(<App />);

    expect(await screen.findByText(/Restored the latest completed attempt saved in local storage/i)).toBeInTheDocument();
    expect(screen.getByText('4/4')).toBeInTheDocument();
    expect((within(screen.getAllByTestId('quiz-question')[0]).getAllByRole('radio')[1] as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole('button', { name: /Current track/i }));

    await waitFor(() => {
      expect(screen.getByText('3/4')).toBeInTheDocument();
    });
    expect((within(screen.getAllByTestId('quiz-question')[2]).getAllByRole('radio')[2] as HTMLInputElement).checked).toBe(true);
  });

  it('shows weak-result remediation with concrete AWS review targets and retries in place', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url, options) => {
        const payload = JSON.parse(String(options?.body ?? '{}')) as { scope: 'topic' | 'track' };
        await wait(30);

        return new Response(JSON.stringify(createQuizResponse(payload.scope)), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }),
    );

    render(<App />);

    await user.click(screen.getByRole('button', { name: /Generate topic quiz/i }));
    const topicQuestions = await screen.findAllByTestId('quiz-question');

    await user.click(within(topicQuestions[0]).getAllByRole('radio')[1]);
    await user.click(within(topicQuestions[1]).getAllByRole('radio')[0]);
    await user.click(within(topicQuestions[2]).getAllByRole('radio')[0]);
    await user.click(within(topicQuestions[3]).getAllByRole('radio')[0]);
    await user.click(screen.getByRole('button', { name: /Submit quiz/i }));

    const remediation = await screen.findByTestId('quiz-remediation');
    const remediationItems = within(remediation).getAllByRole('listitem');

    expect(within(remediation).getByRole('heading', { name: /Review Amazon S3 before the next retry/i })).toBeInTheDocument();
    expect(within(remediation).getByText(/Amazon S3 topic quiz landed at 50%/i)).toBeInTheDocument();
    expect(remediationItems).toHaveLength(6);
    expect(within(remediation).getByText(/S3 bucket policies and public access settings/i)).toBeInTheDocument();
    expect(within(remediation).getByText(/IAM permissions for S3 access/i)).toBeInTheDocument();
    expect(within(remediation).getByText(/Shared Responsibility Model for Amazon S3/i)).toBeInTheDocument();
    expect(within(remediation).getByText(/AWS Well-Architected Framework trade-offs for durability and cost/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Retry topic quiz/i }));

    expect(await screen.findByText(/Scenario: A team needs durable object storage/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Submit quiz/i })).toBeDisabled();
    expect(screen.queryByText('2/4')).not.toBeInTheDocument();
  });
});
