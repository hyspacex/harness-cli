import { certificationTracks, getTopic, topics } from '../data/curriculum.js';
import { CertificationTrackId } from '../types.js';

export interface TutorRequestInput {
  prompt: string;
  topicId: string;
  trackId: CertificationTrackId;
}

export interface TutorSnippet {
  id: string;
  topicId: string;
  topicName: string;
  title: string;
  excerpt: string;
  source: 'overview' | 'trade-off' | 'exam-signal' | 'best-practice';
}

export interface TutorGrounding {
  prompt: string;
  topicId: string;
  topicName: string;
  trackId: CertificationTrackId;
  trackLabel: string;
  snippets: TutorSnippet[];
}

export interface TutorTurnContext {
  grounding: TutorGrounding;
  systemPrompt: string;
  userPrompt: string;
}

function normalize(text: string): string {
  return text.toLowerCase();
}

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

function getTopicAliases(topicId: string): string[] {
  const topic = getTopic(topicId);
  const withoutPrefixes = topic.name
    .replace(/^Amazon\s+/i, '')
    .replace(/^AWS\s+/i, '')
    .replace(/\s+\(.*\)$/u, '');

  return uniqueBy(
    [
      topic.name,
      topic.shortLabel,
      withoutPrefixes,
      withoutPrefixes.replace(/\s+/gu, ' '),
      withoutPrefixes.split(/\s+/u)[0] ?? '',
    ]
      .map((entry) => normalize(entry.trim()))
      .filter(Boolean),
    (entry) => entry,
  );
}

function getMentionedTopics(prompt: string, activeTopicId: string): string[] {
  const normalizedPrompt = normalize(prompt);
  const explicitMentions = topics
    .filter((topic) => getTopicAliases(topic.id).some((alias) => normalizedPrompt.includes(alias)))
    .map((topic) => topic.id);

  return uniqueBy([activeTopicId, ...explicitMentions], (entry) => entry);
}

export function retrieveCurriculumSnippets(input: TutorRequestInput): TutorSnippet[] {
  const activeTopic = getTopic(input.topicId);
  const mentionedTopicIds = getMentionedTopics(input.prompt, activeTopic.id);
  const relatedTopicIds = [...activeTopic.prerequisites, ...activeTopic.relatedTopics];
  const candidateTopicIds = uniqueBy(
    [activeTopic.id, ...mentionedTopicIds, ...relatedTopicIds].filter((topicId) =>
      getTopic(topicId).tracks.includes(input.trackId),
    ),
    (entry) => entry,
  );

  const snippets: TutorSnippet[] = [];

  candidateTopicIds.forEach((topicId, topicIndex) => {
    const topic = getTopic(topicId);
    const isActiveTopic = topic.id === activeTopic.id;

    const pushSnippet = (
      source: TutorSnippet['source'],
      title: string,
      excerpt: string | undefined,
      sourceIndex: number,
    ) => {
      if (!excerpt) {
        return;
      }

      snippets.push({
        id: `${topic.id}-${source}-${sourceIndex}`,
        topicId: topic.id,
        topicName: topic.name,
        title,
        excerpt,
        source,
      });
    };

    pushSnippet('overview', `${topic.name} overview`, topic.overview, topicIndex);
    pushSnippet('trade-off', `${topic.name} trade-off`, topic.tradeOffs[0], topicIndex);

    if (isActiveTopic) {
      pushSnippet('exam-signal', `${topic.name} exam signal`, topic.examSignals[0], topicIndex);
      pushSnippet('best-practice', `${topic.name} best practice`, topic.bestPracticeNotes[0]?.description, topicIndex);
    }
  });

  return uniqueBy(snippets, (entry) => entry.id).slice(0, 4);
}

export function buildTutorTurn(input: TutorRequestInput): TutorTurnContext {
  const prompt = input.prompt.trim();

  if (!prompt) {
    throw new Error('Tutor prompt is required.');
  }

  const topic = getTopic(input.topicId);
  const track = certificationTracks.find((entry) => entry.id === input.trackId);

  if (!track) {
    throw new Error(`Unknown certification track: ${input.trackId}`);
  }

  const snippets = retrieveCurriculumSnippets({
    prompt,
    topicId: topic.id,
    trackId: track.id,
  });

  const grounding: TutorGrounding = {
    prompt,
    topicId: topic.id,
    topicName: topic.name,
    trackId: track.id,
    trackLabel: track.label,
    snippets,
  };

  const systemPrompt = [
    'You are an AWS certification tutor embedded in a study topic view.',
    'Stay within AWS learning. If the learner asks for Azure, GCP, or non-AWS teaching, refuse that lesson and redirect them toward the closest AWS concept, current topic, or current certification track.',
    'Teach rather than only answer. Include at least one trade-off or comparison and one pedagogical move such as a follow-up question, hint, or explicit next study action.',
    `Current certification track: ${track.label}.`,
    `Current topic: ${topic.name}.`,
    'Retrieved AWS curriculum snippets:',
    ...snippets.map((snippet) => `- ${snippet.title}: ${snippet.excerpt}`),
  ].join('\n');

  const userPrompt = [
    `Learner question: ${prompt}`,
    `Keep the answer grounded in ${topic.name} and ${track.label}.`,
  ].join('\n');

  return {
    grounding,
    systemPrompt,
    userPrompt,
  };
}
