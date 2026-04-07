import { describe, expect, it } from 'vitest';
import { generateMockTutorResponse } from './mock.js';
import { buildTutorTurn } from './shared.js';

describe('tutor grounding and response shaping', () => {
  it('assembles topic, track, and topic-specific retrieved snippets', () => {
    const s3Turn = buildTutorTurn({
      prompt: 'How should I reason about this service on the exam?',
      topicId: 's3',
      trackId: 'cloud-practitioner',
    });
    const lambdaTurn = buildTutorTurn({
      prompt: 'How should I reason about this service on the exam?',
      topicId: 'lambda',
      trackId: 'cloud-practitioner',
    });

    expect(s3Turn.grounding.topicName).toBe('Amazon S3');
    expect(s3Turn.grounding.trackLabel).toBe('Cloud Practitioner');
    expect(s3Turn.grounding.snippets.length).toBeGreaterThan(0);
    expect(s3Turn.grounding.snippets[0].title).toMatch(/Amazon S3/i);
    expect(lambdaTurn.grounding.snippets[0].title).toMatch(/AWS Lambda/i);
    expect(s3Turn.grounding.snippets.map((snippet) => snippet.excerpt)).not.toEqual(
      lambdaTurn.grounding.snippets.map((snippet) => snippet.excerpt),
    );
  });

  it('keeps the tutor pedagogical for AWS prompts and redirects off-domain prompts back to AWS study', () => {
    const comparisonResponse = generateMockTutorResponse(
      buildTutorTurn({
        prompt: 'When should I use Lambda instead of EC2?',
        topicId: 'lambda',
        trackId: 'solutions-architect-associate',
      }),
    );
    const offDomainResponse = generateMockTutorResponse(
      buildTutorTurn({
        prompt: 'Teach me Azure Functions for the AZ-204 exam.',
        topicId: 's3',
        trackId: 'cloud-practitioner',
      }),
    );

    expect(comparisonResponse).toContain('AWS Lambda');
    expect(comparisonResponse).toContain('Amazon EC2');
    expect(comparisonResponse).toMatch(/trade-off|operational ownership|runtime flexibility/i);
    expect(comparisonResponse).toMatch(/\?/);

    expect(offDomainResponse).toContain('AWS Lambda');
    expect(offDomainResponse).toContain('Amazon S3');
    expect(offDomainResponse).toContain('Cloud Practitioner');
    expect(offDomainResponse).not.toMatch(/AZ-204 study guide|Azure Functions lets you/i);
  });
});
