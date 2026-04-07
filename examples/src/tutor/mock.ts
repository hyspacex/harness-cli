import { buildTutorTurn, TutorTurnContext } from './shared.js';

function includesAny(prompt: string, values: string[]): boolean {
  const normalizedPrompt = prompt.toLowerCase();

  return values.some((value) => normalizedPrompt.includes(value));
}

function buildSnippetBridge(context: TutorTurnContext): string {
  const [firstSnippet, secondSnippet] = context.grounding.snippets;

  if (!firstSnippet) {
    return `${context.grounding.topicName} is the anchor topic for this question.`;
  }

  if (!secondSnippet) {
    return `${firstSnippet.title} reminds you that ${firstSnippet.excerpt}`;
  }

  return `${firstSnippet.title} and ${secondSnippet.title} are the two most relevant curriculum anchors here: ${firstSnippet.excerpt} ${secondSnippet.excerpt}`;
}

function buildLambdaVsEc2Response(context: TutorTurnContext): string {
  return [
    `For ${context.grounding.trackLabel}, choose AWS Lambda when the workload is event-driven, bursty, and benefits from not managing servers. Choose Amazon EC2 when you need operating-system control, long-running processes, or custom runtimes that do not fit Lambda's execution model.`,
    'The AWS-specific trade-off is operational ownership versus runtime flexibility: Lambda reduces patching and scaling work, but Amazon EC2 gives you deeper host control and avoids Lambda limits such as cold starts and execution duration ceilings.',
    `Because you are studying ${context.grounding.topicName}, connect that comparison back to the current topic: ask yourself which storage, identity, or networking assumptions would get simpler with Lambda and which ones would still require EC2-style control.`,
    'Check your reasoning with this follow-up question: if the traffic became steady and the application needed a long-lived background worker, would Lambda still be the best answer, or would Amazon EC2 be easier to justify on the exam?',
  ].join('\n\n');
}

function buildIamBeforeCognitoResponse(context: TutorTurnContext): string {
  return [
    'IAM matters before Amazon Cognito because IAM defines the AWS-side permission model that services and administrators use, while Cognito focuses on application end users who need sign-up, sign-in, and token issuance.',
    'On the exam, that means IAM answers the question "who can do what inside AWS?" and Cognito answers "how does my app authenticate customers?" Mixing them up leads to weak architecture decisions because end-user identity and AWS resource permissions are not the same control plane.',
    `Since you are on ${context.grounding.topicName} for the ${context.grounding.trackLabel} track, use this as a reasoning shortcut: identify the AWS actor first, then decide whether the problem is about service permissions, customer identity, or both.`,
    'Next study move: compare an IAM role assumed by a Lambda function with a Cognito user signing into an app. Which one is allowed to call downstream AWS APIs directly?',
  ].join('\n\n');
}

function buildS3VsEbsResponse(context: TutorTurnContext): string {
  return [
    'Compare Amazon S3 and Amazon EBS by storage model first. Amazon S3 is regional object storage built for durable object access and broad service integration, while Amazon EBS is attached block storage for EC2 workloads that need low-latency volume access.',
    'The AWS-specific trade-off is access pattern and operational coupling: S3 scales without instance attachment and fits backups, static assets, and data lakes, but EBS is the better fit for boot volumes, transactional filesystems, and EC2-hosted databases.',
    `${buildSnippetBridge(context)}`,
    'Reasoning prompt: if the scenario needs a file mounted to one running instance with predictable block performance, which answer survives closer reading, and why would S3 be the wrong mental model?',
  ].join('\n\n');
}

function buildOffDomainResponse(context: TutorTurnContext): string {
  return [
    'I cannot teach Azure Functions or the AZ-204 exam inside this AWS study coach.',
    `The closest AWS comparison is AWS Lambda, and that comparison is more useful for your current ${context.grounding.trackLabel} work because it keeps the trade-offs inside AWS service-selection logic instead of switching clouds.`,
    `Since you are currently on ${context.grounding.topicName}, a better next step is to ask how ${context.grounding.topicName} interacts with AWS Lambda or another AWS service in the same architecture.`,
    'If you want, ask this instead: "How would AWS Lambda compare with the current topic for this certification scenario?"',
  ].join('\n\n');
}

function buildGenericResponse(context: TutorTurnContext): string {
  return [
    `${context.grounding.topicName} matters on the ${context.grounding.trackLabel} track because the exam expects you to reason from service behavior, not just memorize the name.`,
    buildSnippetBridge(context),
    `Use that context to decide what the service is best at, where its trade-offs appear, and what adjacent AWS service you should compare it with next.`,
    `Follow-up question: if the scenario changed one constraint such as latency, durability, or operational ownership, would ${context.grounding.topicName} still be your first choice?`,
  ].join('\n\n');
}

export function generateMockTutorResponse(context: TutorTurnContext): string {
  const prompt = context.grounding.prompt.toLowerCase();

  if (includesAny(prompt, ['azure', 'az-204', 'google cloud', 'gcp'])) {
    return buildOffDomainResponse(context);
  }

  if (includesAny(prompt, ['lambda instead of ec2', 'lambda vs ec2', 'lambda or ec2'])) {
    return buildLambdaVsEc2Response(context);
  }

  if (includesAny(prompt, ['iam matter before cognito', 'iam before cognito'])) {
    return buildIamBeforeCognitoResponse(context);
  }

  if (includesAny(prompt, ['s3 and ebs', 's3 vs ebs', 's3 or ebs'])) {
    return buildS3VsEbsResponse(context);
  }

  return buildGenericResponse(context);
}

export function generateMockTutorResponseFromInput(input: Parameters<typeof buildTutorTurn>[0]): string {
  return generateMockTutorResponse(buildTutorTurn(input));
}
