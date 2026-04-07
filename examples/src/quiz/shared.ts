import { certificationTracks, getTopic, getTopicsForTrack } from '../data/curriculum.js';
import { CertificationTrackId, Topic } from '../types.js';

export type QuizScope = 'topic' | 'track';
export type QuizMode = 'mock' | 'live';

export interface QuizRequestInput {
  scope: QuizScope;
  topicId: string;
  trackId: CertificationTrackId;
}

export interface QuizGroundingSource {
  id: string;
  topicId: string;
  topicName: string;
  title: string;
  excerpt: string;
  source:
    | 'overview'
    | 'use-case'
    | 'trade-off'
    | 'exam-signal'
    | 'best-practice'
    | 'operational-note'
    | 'pricing-note';
}

export interface QuizGrounding {
  scope: QuizScope;
  topicId: string | null;
  topicName: string | null;
  activeTopicId: string;
  activeTopicName: string;
  trackId: CertificationTrackId;
  trackLabel: string;
  title: string;
  sourceTopics: Array<{
    topicId: string;
    topicName: string;
  }>;
  snippets: QuizGroundingSource[];
}

export interface QuizChoice {
  id: string;
  text: string;
}

export interface QuizQuestion {
  id: string;
  stem: string;
  choices: QuizChoice[];
  correctChoiceId: string;
  explanation: string;
}

export interface QuizPayload {
  id: string;
  scope: QuizScope;
  title: string;
  questions: QuizQuestion[];
  grounding: QuizGrounding;
}

export interface QuizTurnContext {
  grounding: QuizGrounding;
  systemPrompt: string;
  userPrompt: string;
  activeTopic: Topic;
  sourceTopics: Topic[];
}

interface TopicScenarioTemplate {
  prompt: string;
  comparisonTopicIds?: string[];
}

interface ModelQuizCandidate {
  title?: string;
  questions?: Array<{
    stem?: string;
    choices?: Array<
      | string
      | {
          text?: string;
        }
    >;
    correctChoiceIndex?: number;
    explanation?: string;
  }>;
}

const SCENARIO_TEMPLATES: Record<string, TopicScenarioTemplate> = {
  ec2: {
    prompt:
      'A team needs long-running compute, custom operating-system agents, and stable host access for a migrated workload. Which AWS service is the best fit?',
    comparisonTopicIds: ['lambda', 'ebs'],
  },
  lambda: {
    prompt:
      'A product team is building an event-driven workflow with bursty demand and wants to avoid managing servers. Which AWS service is the best fit?',
    comparisonTopicIds: ['ec2', 'rds'],
  },
  s3: {
    prompt:
      'A team needs durable storage for static website assets, backups, and shared objects that many AWS services can read without attaching a volume to EC2. Which AWS service is the best fit?',
    comparisonTopicIds: ['ebs', 'rds'],
  },
  ebs: {
    prompt:
      'An EC2-hosted database needs low-latency attached block storage in the same Availability Zone as the instance. Which AWS service is the best fit?',
    comparisonTopicIds: ['s3', 'rds'],
  },
  rds: {
    prompt:
      'A line-of-business application needs SQL queries, joins, transactions, and managed backups without self-managing database servers. Which AWS service is the best fit?',
    comparisonTopicIds: ['dynamodb', 'ec2'],
  },
  dynamodb: {
    prompt:
      'A serverless application needs predictable key-value access at very high scale with no database server management. Which AWS service is the best fit?',
    comparisonTopicIds: ['rds', 'lambda'],
  },
  vpc: {
    prompt:
      'A solutions architect needs private subnets, route control, and traffic segmentation around an application stack. Which AWS service is the best fit?',
    comparisonTopicIds: ['cloudfront', 'iam'],
  },
  cloudfront: {
    prompt:
      'A global audience needs faster delivery of web assets while offloading requests from the origin and protecting it at the edge. Which AWS service is the best fit?',
    comparisonTopicIds: ['s3', 'vpc'],
  },
  iam: {
    prompt:
      'An architecture review is focused on least-privilege AWS access for administrators, services, and workloads that call AWS APIs. Which AWS service is the best fit?',
    comparisonTopicIds: ['cognito', 'vpc'],
  },
  cognito: {
    prompt:
      'A mobile application needs customer sign-up, sign-in, and token issuance without building a custom identity store from scratch. Which AWS service is the best fit?',
    comparisonTopicIds: ['iam', 'lambda'],
  },
};

function uniqueBy<T>(entries: T[], getKey: (entry: T) => string): T[] {
  const seen = new Set<string>();

  return entries.filter((entry) => {
    const key = getKey(entry);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function firstSentence(text: string | undefined): string {
  if (!text) {
    return '';
  }

  const normalized = text.trim();
  const match = normalized.match(/^[^.?!]+[.?!]?/u);

  return (match?.[0] ?? normalized).trim();
}

function getTrack(trackId: CertificationTrackId) {
  const track = certificationTracks.find((entry) => entry.id === trackId);

  if (!track) {
    throw new Error(`Unknown certification track: ${trackId}`);
  }

  return track;
}

function getScenarioTemplate(topic: Topic): TopicScenarioTemplate {
  return (
    SCENARIO_TEMPLATES[topic.id] ?? {
      prompt: `A learner is reviewing ${topic.name} for an AWS certification scenario. Which AWS service is the best fit?`,
      comparisonTopicIds: topic.relatedTopics,
    }
  );
}

function pickTopicScopeSources(topic: Topic, trackId: CertificationTrackId): Topic[] {
  const fallbackTopicIds = getTopicsForTrack(trackId)
    .filter((entry) => entry.id !== topic.id)
    .map((entry) => entry.id);
  const candidateTopicIds = uniqueBy(
    [topic.id, ...topic.relatedTopics, ...topic.prerequisites, ...fallbackTopicIds],
    (entry) => entry,
  );

  return candidateTopicIds
    .map((topicId) => getTopic(topicId))
    .filter((entry) => entry.tracks.includes(trackId))
    .slice(0, 3);
}

function pickTrackScopeSources(activeTopic: Topic, trackId: CertificationTrackId): Topic[] {
  const trackTopics = getTopicsForTrack(trackId);
  const additionalTopics = uniqueBy(
    [
      ...trackTopics.filter((topic) => topic.id !== activeTopic.id),
      ...trackTopics.filter((topic) => topic.categoryId !== activeTopic.categoryId),
    ],
    (entry) => entry.id,
  );
  const selectedTopics = uniqueBy([activeTopic, ...additionalTopics], (entry) => entry.id);

  return selectedTopics.slice(0, 4);
}

function buildGroundingSnippets(scope: QuizScope, activeTopic: Topic, sourceTopics: Topic[]): QuizGroundingSource[] {
  const snippets: QuizGroundingSource[] = [];

  sourceTopics.forEach((topic, topicIndex) => {
    const isActiveTopic = topic.id === activeTopic.id;
    const pushSnippet = (
      source: QuizGroundingSource['source'],
      title: string,
      excerpt: string | undefined,
      sourceIndex: number,
    ) => {
      const value = firstSentence(excerpt);

      if (!value) {
        return;
      }

      snippets.push({
        id: `${scope}-${topic.id}-${source}-${sourceIndex}`,
        topicId: topic.id,
        topicName: topic.name,
        title,
        excerpt: value,
        source,
      });
    };

    pushSnippet('overview', `${topic.name} overview`, topic.overview, topicIndex);
    pushSnippet('trade-off', `${topic.name} trade-off`, topic.tradeOffs[0], topicIndex);

    if (isActiveTopic || scope === 'track') {
      pushSnippet('use-case', `${topic.name} use case`, topic.useCases[0], topicIndex);
      pushSnippet('best-practice', `${topic.name} best practice`, topic.bestPracticeNotes[0]?.description, topicIndex);
      pushSnippet('operational-note', `${topic.name} operational note`, topic.operationalNotes[0], topicIndex);
    }
  });

  return uniqueBy(snippets, (entry) => entry.id).slice(0, scope === 'track' ? 8 : 6);
}

function buildStatementChoices(correct: string, distractors: string[], questionId: string, correctSlot: number): QuizChoice[] {
  const pool = uniqueBy(
    [correct, ...distractors]
      .map((entry) => entry.trim())
      .filter(Boolean),
    (entry) => entry,
  );
  const safeDistractors = pool.filter((entry) => entry !== correct).slice(0, 3);
  const finalTexts = [...safeDistractors];
  finalTexts.splice(Math.min(correctSlot, finalTexts.length), 0, correct);

  return finalTexts.map((text, index) => ({
    id: `${questionId}-choice-${index + 1}`,
    text,
  }));
}

function buildServiceChoices(correctTopic: Topic, trackId: CertificationTrackId, preferredIds: string[], questionId: string, correctSlot: number): QuizChoice[] {
  const distractorTopics = uniqueBy(
    [
      ...preferredIds.filter((topicId) => topicId !== correctTopic.id),
      ...getTopicsForTrack(trackId)
        .map((topic) => topic.id)
        .filter((topicId) => topicId !== correctTopic.id),
    ],
    (entry) => entry,
  )
    .map((topicId) => getTopic(topicId))
    .slice(0, 3);
  const finalTopics = [...distractorTopics];
  finalTopics.splice(Math.min(correctSlot, finalTopics.length), 0, correctTopic);

  return finalTopics.map((topic, index) => ({
    id: `${questionId}-choice-${index + 1}`,
    text: topic.name,
  }));
}

function getBestPracticeQuestion(topic: Topic, trackLabel: string, questionNumber: number): QuizQuestion {
  const questionId = `${topic.id}-best-practice-${questionNumber}`;
  const note = topic.bestPracticeNotes[0];
  const usesSharedResponsibility = note?.title.toLowerCase().includes('shared responsibility');
  const correct = usesSharedResponsibility
    ? `AWS secures the managed ${topic.shortLabel} platform, while you still own configuration choices such as access controls, encryption, and data handling.`
    : `The AWS Well-Architected Framework treats ${topic.shortLabel} decisions as trade-offs across pillars such as reliability, security, performance, and cost.`;
  const choices = buildStatementChoices(
    correct,
    [
      `${topic.name} removes all architectural trade-offs once you enable the service.`,
      `AWS automatically rewrites your workload design so ${topic.name} never needs governance or operational review.`,
      `${topic.name} best practice is to postpone security and resilience decisions until after the deployment is live.`,
    ],
    questionId,
    questionNumber % 4,
  );
  const correctChoiceId = choices.find((choice) => choice.text === correct)?.id ?? choices[0].id;
  const explanation = note
    ? `${note.title} is the right anchor for ${topic.name} because ${note.description}`
    : `${topic.name} still needs AWS best-practice reasoning around service trade-offs, not just recall of feature names.`;

  return {
    id: questionId,
    stem: `Which study note best reflects the main best-practice takeaway for ${topic.name} on the ${trackLabel} track?`,
    choices,
    correctChoiceId,
    explanation,
  };
}

function getTradeOffQuestion(topic: Topic, questionNumber: number): QuizQuestion {
  const questionId = `${topic.id}-trade-off-${questionNumber}`;
  const correct = firstSentence(topic.tradeOffs[0]);
  const choices = buildStatementChoices(
    correct,
    [
      firstSentence(topic.useCases[0]),
      firstSentence(topic.operationalNotes[0]),
      `${topic.name} is the correct answer whenever a question mentions AWS, so its trade-offs rarely matter on the exam.`,
    ],
    questionId,
    (questionNumber + 1) % 4,
  );
  const correctChoiceId = choices.find((choice) => choice.text === correct)?.id ?? choices[0].id;

  return {
    id: questionId,
    stem: `Which trade-off should you remember when deciding whether ${topic.name} is the right AWS service?`,
    choices,
    correctChoiceId,
    explanation: `${topic.name} is often tested through service-selection trade-offs. ${firstSentence(topic.tradeOffs[0])} That is why exam scenarios compare ${topic.shortLabel} with adjacent AWS options instead of asking for a pure definition.`,
  };
}

function getOperationalQuestion(topic: Topic, questionNumber: number): QuizQuestion {
  const questionId = `${topic.id}-operations-${questionNumber}`;
  const correct = firstSentence(topic.operationalNotes[0] ?? topic.pricingNotes[0]);
  const choices = buildStatementChoices(
    correct,
    [
      firstSentence(topic.useCases[0]),
      firstSentence(topic.tradeOffs[0]),
      `${topic.name} no longer needs monitoring, lifecycle controls, or cost review once it is provisioned.`,
    ],
    questionId,
    (questionNumber + 2) % 4,
  );
  const correctChoiceId = choices.find((choice) => choice.text === correct)?.id ?? choices[0].id;
  const explanation = topic.operationalNotes[0]
    ? `${topic.name} still needs operational discipline. ${firstSentence(topic.operationalNotes[0])} That is the kind of best-practice reasoning AWS certification questions expect.`
    : `${topic.name} pricing and operating model still matter. ${firstSentence(topic.pricingNotes[0])}`;

  return {
    id: questionId,
    stem: `Which note is the strongest operational checkpoint for ${topic.name} in an AWS architecture review?`,
    choices,
    correctChoiceId,
    explanation,
  };
}

function getScenarioQuestion(topic: Topic, trackId: CertificationTrackId, trackLabel: string, questionNumber: number): QuizQuestion {
  const questionId = `${topic.id}-scenario-${questionNumber}`;
  const scenario = getScenarioTemplate(topic);
  const choices = buildServiceChoices(
    topic,
    trackId,
    scenario.comparisonTopicIds ?? topic.relatedTopics,
    questionId,
    (questionNumber + 1) % 4,
  );
  const correctChoiceId = choices.find((choice) => choice.text === topic.name)?.id ?? choices[0].id;
  const comparisonTopicName =
    scenario.comparisonTopicIds?.map((topicId) => getTopic(topicId).name).join(' and ') ??
    topic.relatedTopics.map((topicId) => getTopic(topicId).name).join(' and ');
  const explanation = `${topic.name} is the best answer here because ${firstSentence(topic.useCases[0])} The service-selection trade-off is that ${firstSentence(topic.tradeOffs[0])} On the ${trackLabel} track, compare ${topic.name} with ${comparisonTopicName || 'other AWS services'} instead of assuming every managed service solves the same problem.`;

  return {
    id: questionId,
    stem: `Scenario: ${scenario.prompt}`,
    choices,
    correctChoiceId,
    explanation,
  };
}

function buildQuestionSet(scope: QuizScope, activeTopic: Topic, sourceTopics: Topic[], trackId: CertificationTrackId, trackLabel: string): QuizQuestion[] {
  if (scope === 'topic') {
    return [
      getScenarioQuestion(activeTopic, trackId, trackLabel, 1),
      getBestPracticeQuestion(activeTopic, trackLabel, 2),
      getTradeOffQuestion(activeTopic, 3),
      getOperationalQuestion(activeTopic, 4),
    ];
  }

  const questionTopics = [...sourceTopics];
  const scenarioTopic = questionTopics[1] ?? questionTopics[0] ?? activeTopic;
  const bestPracticeTopic = questionTopics[1] ?? activeTopic;
  const tradeOffTopic = questionTopics[2] ?? questionTopics[1] ?? activeTopic;
  const operationalTopic = questionTopics[3] ?? questionTopics[2] ?? questionTopics[1] ?? activeTopic;

  return [
    getScenarioQuestion(scenarioTopic, trackId, trackLabel, 1),
    getBestPracticeQuestion(bestPracticeTopic, trackLabel, 2),
    getTradeOffQuestion(tradeOffTopic, 3),
    getOperationalQuestion(operationalTopic, 4),
  ];
}

export function buildQuizTurn(input: QuizRequestInput): QuizTurnContext {
  const activeTopic = getTopic(input.topicId);
  const track = getTrack(input.trackId);
  const sourceTopics =
    input.scope === 'topic'
      ? pickTopicScopeSources(activeTopic, track.id)
      : pickTrackScopeSources(activeTopic, track.id);
  const grounding: QuizGrounding = {
    scope: input.scope,
    topicId: input.scope === 'topic' ? activeTopic.id : null,
    topicName: input.scope === 'topic' ? activeTopic.name : null,
    activeTopicId: activeTopic.id,
    activeTopicName: activeTopic.name,
    trackId: track.id,
    trackLabel: track.label,
    title: input.scope === 'topic' ? `${activeTopic.name} topic quiz` : `${track.label} track quiz`,
    sourceTopics: sourceTopics.map((topic) => ({
      topicId: topic.id,
      topicName: topic.name,
    })),
    snippets: buildGroundingSnippets(input.scope, activeTopic, sourceTopics),
  };

  const systemPrompt = [
    'You are generating a grounded AWS certification quiz for an embedded study shell.',
    'Return JSON only.',
    'Create exactly 4 multiple-choice questions.',
    'Each question must include at least 4 choices, a zero-based correctChoiceIndex, and an AWS-specific explanation.',
    'At least one question must be scenario-based and force a trade-off, service choice, or best-practice decision.',
    `Quiz scope: ${grounding.scope}.`,
    `Current certification track: ${grounding.trackLabel}.`,
    `Current study topic: ${grounding.activeTopicName}.`,
    'Retrieved AWS quiz context:',
    ...grounding.snippets.map((snippet) => `- ${snippet.title}: ${snippet.excerpt}`),
  ].join('\n');
  const userPrompt = [
    `Build a ${grounding.title}.`,
    `Active topic: ${grounding.activeTopicName}.`,
    `Track: ${grounding.trackLabel}.`,
    input.scope === 'track'
      ? `Cover multiple AWS topics from this track, including ${grounding.sourceTopics.map((topic) => topic.topicName).join(', ')}.`
      : `Keep the quiz centered on ${grounding.activeTopicName} while comparing it with nearby AWS services when useful.`,
  ].join('\n');

  return {
    grounding,
    systemPrompt,
    userPrompt,
    activeTopic,
    sourceTopics,
  };
}

export function generateMockQuiz(context: QuizTurnContext): QuizPayload {
  return {
    id: `${context.grounding.scope}-${context.grounding.activeTopicId}-${Date.now()}`,
    scope: context.grounding.scope,
    title: context.grounding.title,
    questions: buildQuestionSet(
      context.grounding.scope,
      context.activeTopic,
      context.sourceTopics,
      context.grounding.trackId,
      context.grounding.trackLabel,
    ),
    grounding: context.grounding,
  };
}

export function scoreQuiz(quiz: QuizPayload, selectedAnswers: Record<string, string>): number {
  return quiz.questions.reduce((score, question) => {
    return selectedAnswers[question.id] === question.correctChoiceId ? score + 1 : score;
  }, 0);
}

export function hasScenarioQuestion(quiz: QuizPayload): boolean {
  return quiz.questions.some((question) => /^Scenario:/u.test(question.stem));
}

export function normalizeModelQuiz(candidate: unknown, context: QuizTurnContext): QuizPayload {
  const value = candidate as ModelQuizCandidate;

  if (!value || !Array.isArray(value.questions)) {
    throw new Error('Live quiz generation returned an invalid payload.');
  }

  const questions = value.questions.slice(0, 4).map((question, index) => {
    const questionId = `${context.grounding.scope}-${index + 1}`;
    const choiceTexts = (question.choices ?? [])
      .map((choice) => (typeof choice === 'string' ? choice : choice?.text ?? ''))
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!question.stem?.trim() || choiceTexts.length < 3 || typeof question.correctChoiceIndex !== 'number') {
      throw new Error('Live quiz generation returned an incomplete question.');
    }

    const choices = choiceTexts.map((text, choiceIndex) => ({
      id: `${questionId}-choice-${choiceIndex + 1}`,
      text,
    }));
    const correctChoiceId = choices[question.correctChoiceIndex]?.id;

    if (!correctChoiceId || !question.explanation?.trim()) {
      throw new Error('Live quiz generation returned an invalid correct answer or explanation.');
    }

    return {
      id: questionId,
      stem: question.stem.trim(),
      choices,
      correctChoiceId,
      explanation: question.explanation.trim(),
    };
  });

  if (questions.length < 4) {
    throw new Error('Live quiz generation did not return four questions.');
  }

  const quiz: QuizPayload = {
    id: `${context.grounding.scope}-${context.grounding.activeTopicId}-${Date.now()}`,
    scope: context.grounding.scope,
    title: value.title?.trim() || context.grounding.title,
    questions,
    grounding: context.grounding,
  };

  if (!hasScenarioQuestion(quiz)) {
    throw new Error('Live quiz generation did not include a scenario-based question.');
  }

  if (
    quiz.questions.some(
      (question) => !/(AWS|Amazon|Well-Architected|Shared Responsibility|Lambda|EC2|S3|RDS|DynamoDB|IAM|VPC|CloudFront|Cognito)/iu.test(question.explanation),
    )
  ) {
    throw new Error('Live quiz generation returned an explanation without concrete AWS grounding.');
  }

  return quiz;
}
