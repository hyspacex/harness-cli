# AWS Learning Platform

## Sprint 2 tutor notes

### Grounding inspection surface

The canonical runtime grounding inspection surface is the visible `Grounding details` panel inside the embedded tutor card on each topic view. Submit a tutor prompt, then inspect that panel to confirm the current topic, the active certification track, and the retrieved AWS curriculum snippets used for the reply.

### Local demo mode

The tutor reads live AI credentials from environment variables. For deterministic local runs without a key, use the documented demo switch in `.env.example`:

- `AWS_TUTOR_MODE=mock`

If `OPENAI_API_KEY` is absent, the tutor also falls back to demo mode automatically and shows a visible `Demo mode` label in the study view.

### Forced post-first-chunk failure mode

To verify partial-text preservation and inline tutor error handling, enable:

- `AWS_TUTOR_FAIL_AFTER_CHUNK=1`

With that flag enabled, the tutor streams one assistant chunk first, then surfaces an inline error while preserving the partial reply in the transcript.

### Live AI configuration

The optional live tutor path reads:

- `OPENAI_API_KEY`
- `AWS_TUTOR_OPENAI_MODEL`

When a valid key is present and `AWS_TUTOR_MODE` is not `mock`, the dev server will attempt a live tutor completion. The embedded study-view transcript still streams chunk-by-chunk into the same assistant message node.

## Sprint 3 quiz notes

### Quiz grounding inspection surface

The canonical runtime grounding inspection surface for quizzes is the visible `Quiz context` panel inside the embedded quiz card on each topic view. Generate a quiz, then inspect that panel to confirm:

- the quiz scope (`topic` or `track`)
- the active topic
- the active certification track
- the AWS source topics and retrieved snippets used to build the quiz

### Quiz result storage contract

Quiz results are stored in browser `localStorage` under the exact key:

- `aws-learning-platform.quiz-results.v1`

The stored value is readable JSON with one latest topic-scoped record and one latest track-scoped record:

```json
{
  "version": 1,
  "topic": {
    "topicId": "s3",
    "trackId": "cloud-practitioner",
    "scope": "topic",
    "score": 4,
    "totalQuestions": 4,
    "completedAt": "2026-04-06T21:30:00.000Z",
    "mode": "mock",
    "modeLabel": "Demo mode",
    "quiz": {},
    "selectedAnswers": {}
  },
  "track": {
    "topicId": null,
    "trackId": "cloud-practitioner",
    "scope": "track",
    "score": 3,
    "totalQuestions": 4,
    "completedAt": "2026-04-06T21:35:00.000Z",
    "mode": "mock",
    "modeLabel": "Demo mode",
    "quiz": {},
    "selectedAnswers": {}
  }
}
```

Required fields for both stored result records are:

- `topicId`
- `trackId`
- `scope`
- `score`
- `totalQuestions`
- `completedAt`

The topic-scoped record stores the active topic id. The track-scoped record stores `topicId: null` and represents the latest completed quiz for the active certification track. The nested `quiz` object contains the grounded question set so the latest completed attempt can be restored after a refresh without regenerating it.

### Local demo mode

The quiz uses the same `OPENAI_API_KEY` as the tutor. For deterministic local runs without a key, use:

- `AWS_QUIZ_MODE=mock`

If `OPENAI_API_KEY` is absent, quiz generation automatically falls back to demo mode and the quiz card shows a visible `Demo mode` label after generation.

### Live AI configuration

The optional live quiz path reads:

- `OPENAI_API_KEY`
- `AWS_QUIZ_OPENAI_MODEL`

When a valid key is present and `AWS_QUIZ_MODE` is not `mock`, the dev server attempts a live grounded quiz generation first and falls back to demo mode in `auto` mode if the live response is invalid.

## Sprint 4 adaptive notes

### Adaptive inspection surface

The canonical adaptive inspection surface is the visible `Adaptive dashboard` section rendered in the main study shell between the hero panel and the topic study panel. It exposes:

- category confidence rollups
- the visible `Recommended next` queue with plain-language reasons
- topic-level confidence rows for the active certification track

### Adaptive storage contract

Adaptive learner state is stored in browser `localStorage` under the exact key:

- `aws-learning-platform.adaptive-state.v1`

Use these exact ids when inspecting the stored JSON during manual evaluation:

- `Amazon S3` topic id: `s3`
- `AWS Identity and Access Management (IAM)` topic id: `iam`
- `Storage` category id: `storage`
- `Security & Identity` category id: `security`

The stored value is readable JSON. The evaluator-critical top-level fields are `trackId`, `topics`, `categories`, and `recommendations`:

```json
{
  "version": 1,
  "trackId": "cloud-practitioner",
  "topics": {
    "s3": {
      "label": "Amazon S3",
      "categoryId": "storage",
      "confidenceState": "Confident",
      "score": 3,
      "totalQuestions": 4,
      "completedAt": "2026-04-06T22:15:00.000Z",
      "prerequisites": ["iam"],
      "blockedBy": [],
      "reviewTargets": [
        "S3 bucket policies and public access settings"
      ]
    },
    "iam": {
      "label": "AWS Identity and Access Management (IAM)",
      "categoryId": "security",
      "confidenceState": "Needs review",
      "score": 2,
      "totalQuestions": 4,
      "completedAt": "2026-04-06T22:20:00.000Z",
      "prerequisites": [],
      "blockedBy": [],
      "reviewTargets": [
        "Least-privilege IAM policies"
      ]
    }
  },
  "categories": {
    "storage": {
      "label": "Storage",
      "dominantState": "Confident",
      "topicCount": 1,
      "confidentCount": 1,
      "needsReviewCount": 0,
      "unattemptedCount": 0
    },
    "security": {
      "label": "Security & Identity",
      "dominantState": "Needs review",
      "topicCount": 1,
      "confidentCount": 0,
      "needsReviewCount": 1,
      "unattemptedCount": 0
    }
  },
  "recommendations": [
    {
      "topicId": "iam",
      "kind": "retry",
      "reason": "AWS Identity and Access Management (IAM) needs review because your last topic quiz landed at 50%."
    }
  ]
}
```

Extra fields such as `trackStates`, `blockedBy`, and `reviewTargets` are stored to keep the active-track snapshot refresh-safe and to support recommendation and remediation rendering without re-deriving state from scratch.

### Manual evaluation path

1. Start the app with `AWS_TUTOR_MODE=mock AWS_QUIZ_MODE=mock npm run dev -- --host 127.0.0.1 --port 3000`.
2. Clear `aws-learning-platform.quiz-results.v1` and `aws-learning-platform.adaptive-state.v1` from browser `localStorage`, then refresh.
3. Inspect the `Adaptive dashboard` and confirm clean-state `Cloud Practitioner` shows visible `Unattempted` topic/category states plus at least three `Recommended next` items.
4. Complete a strong `Amazon S3` topic quiz and a weak `IAM` topic quiz, then inspect the dashboard and the stored adaptive JSON with the ids above.
5. Complete a recovered `IAM` topic quiz and confirm the `Recommended next` queue reorders away from the weak-`IAM` retry item.
6. Complete a weak `Amazon S3` topic quiz and confirm the visible remediation card names `Amazon S3`, lists concrete review targets, and exposes `Retry topic quiz` in the same study flow.

## Sprint 5 review notes

### Review inspection surface

The canonical Sprint 5 inspection surface is still the visible `Adaptive dashboard`, but the evaluator-critical review path now lives in two embedded areas inside that section:

- the `Review loop` panel, which surfaces due-now items and later scheduled reviews for the active certification track
- the momentum summary cards, which expose visible `XP total`, `Streak days`, and `Completed reviews`

When a due review exists, the first actionable CTA inside the adaptive surface is the `Start review` button rendered on the due review item, and the first `Recommended next` card also promotes that due review ahead of untouched study topics.

### Review storage contract

Sprint 5 extends the same browser `localStorage` key:

- `aws-learning-platform.adaptive-state.v1`

Use these exact ids when inspecting the stored JSON during manual evaluation:

- `Amazon S3` topic id: `s3`
- `AWS Identity and Access Management (IAM)` topic id: `iam`
- `Storage` category id: `storage`
- `Security & Identity` category id: `security`

The evaluator-critical top-level fields are now `trackId`, `topics`, `categories`, `recommendations`, `reviewQueue`, and `momentum`:

```json
{
  "version": 1,
  "trackId": "cloud-practitioner",
  "topics": {
    "s3": {
      "label": "Amazon S3",
      "categoryId": "storage",
      "confidenceState": "Confident",
      "score": 4,
      "totalQuestions": 4,
      "completedAt": "2026-04-06T22:00:00.000Z",
      "lastReviewedAt": "2026-04-06T22:00:00.000Z",
      "nextDueAt": "2026-04-09T22:00:00.000Z",
      "intervalDays": 3,
      "reviewCount": 1,
      "reviewState": "Scheduled"
    },
    "iam": {
      "label": "AWS Identity and Access Management (IAM)",
      "categoryId": "security",
      "confidenceState": "Confident",
      "score": 3,
      "totalQuestions": 4,
      "completedAt": "2026-04-06T22:10:00.000Z",
      "lastReviewedAt": "2026-04-06T22:10:00.000Z",
      "nextDueAt": "2026-04-08T22:10:00.000Z",
      "intervalDays": 2,
      "reviewCount": 2,
      "reviewState": "Scheduled"
    }
  },
  "reviewQueue": [
    {
      "topicId": "iam",
      "label": "AWS Identity and Access Management (IAM)",
      "reviewState": "Scheduled",
      "timingLabel": "Next review in 2 days"
    },
    {
      "topicId": "s3",
      "label": "Amazon S3",
      "reviewState": "Scheduled",
      "timingLabel": "Next review in 3 days"
    }
  ],
  "momentum": {
    "xp": 30,
    "streakDays": 1,
    "completedReviews": 1,
    "lastReviewCompletedAt": "2026-04-06T22:10:00.000Z"
  },
  "recommendations": [
    {
      "topicId": "vpc",
      "kind": "study",
      "label": "Start VPC"
    }
  ]
}
```

For reviewed topics such as `s3` and `iam`, inspect these readable topic fields:

- `lastReviewedAt`
- `nextDueAt`
- `intervalDays`
- `reviewCount`
- `reviewState`

For learner momentum, inspect:

- `xp`
- `streakDays`
- `completedReviews`
- `lastReviewCompletedAt`

The stored JSON also keeps `trackStates`, `blockedBy`, and `reviewTargets` so the current track can rehydrate without rebuilding the visible review queue, recommendations, or weak-topic remediation from scratch.

### Manual evaluation path

1. Start the app with `AWS_TUTOR_MODE=mock AWS_QUIZ_MODE=mock npm run dev -- --host 127.0.0.1 --port 3000`.
2. Clear `aws-learning-platform.quiz-results.v1` and `aws-learning-platform.adaptive-state.v1` from browser `localStorage`, then refresh.
3. Complete a strong `Amazon S3` topic quiz at `3/4` or better and a weak `IAM` topic quiz at `2/4` or worse.
4. Inspect the `Review loop` panel and confirm `IAM` is `Due now`, `Amazon S3` is in a later scheduled state, and the first CTA inside the adaptive surface is the due-review `Start review` action.
5. Start the due `IAM` review from the adaptive surface, complete it at `3/4` or better, and return to the dashboard.
6. Confirm `IAM` is no longer due now, the queue shows a later `nextDueAt`, `XP total` and `Completed reviews` increased, and the first `Recommended next` card no longer points to the cleared weak-`IAM` due review.
7. Inspect `aws-learning-platform.adaptive-state.v1` and confirm the top-level `reviewQueue` and `momentum` objects plus the topic-level review fields for `s3` and `iam`.
8. Refresh the page and confirm the same review obligations, momentum values, and first next-step recommendation are restored.
