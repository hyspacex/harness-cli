import { useEffect, useRef, useState } from 'react';
import { CertificationTrack, Topic } from '../types.js';
import { requestTutorResponse, TutorMode } from './client.js';
import { buildTutorTurn, TutorGrounding } from './shared.js';

interface TutorMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

interface TutorPanelProps {
  topic: Topic;
  track: CertificationTrack;
}

const starterPrompts = [
  'How should I reason about this service on the exam?',
  'When should I use Lambda instead of EC2?',
  'Why does IAM matter before Cognito?',
];

export function TutorPanel({ topic, track }: TutorPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [grounding, setGrounding] = useState<TutorGrounding | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [mode, setMode] = useState<TutorMode | null>(null);
  const [modeLabel, setModeLabel] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const nextMessageId = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const draftPrompt = prompt.trim();
  const previewGrounding = draftPrompt
    ? buildTutorTurn({
        prompt: draftPrompt,
        topicId: topic.id,
        trackId: track.id,
      }).grounding
    : null;
  const visibleGrounding = grounding ?? previewGrounding;

  useEffect(() => {
    activeController.current?.abort();
    activeController.current = null;
    setPrompt('');
    setMessages([]);
    setGrounding(null);
    setInlineError(null);
    setMode(null);
    setModeLabel(null);
    setStatus('idle');
  }, [topic.id, track.id]);

  useEffect(() => {
    return () => {
      activeController.current?.abort();
    };
  }, []);

  function createMessage(role: TutorMessage['role'], content: string): TutorMessage {
    const message = {
      id: nextMessageId.current,
      role,
      content,
    };

    nextMessageId.current += 1;

    return message;
  }

  function updateAssistantMessage(messageId: number, updater: (message: TutorMessage) => TutorMessage) {
    setMessages((currentMessages) =>
      currentMessages.map((message) => (message.id === messageId ? updater(message) : message)),
    );
  }

  async function handleSubmit(nextPrompt?: string) {
    const question = (nextPrompt ?? prompt).trim();

    if (!question || status === 'streaming') {
      return;
    }

    activeController.current?.abort();

    const controller = new AbortController();
    const requestInput = {
      prompt: question,
      topicId: topic.id,
      trackId: track.id,
    };
    const predictedGrounding = buildTutorTurn(requestInput).grounding;
    const userMessage = createMessage('user', question);
    const assistantMessage = createMessage('assistant', '');
    let streamFailed = false;

    activeController.current = controller;
    setPrompt('');
    setGrounding(predictedGrounding);
    setInlineError(null);
    setStatus('streaming');
    setMessages((currentMessages) => [...currentMessages, userMessage, assistantMessage]);

    try {
      await requestTutorResponse(
        requestInput,
        (event) => {
          if (event.type === 'meta') {
            setGrounding(event.grounding);
            setMode(event.mode);
            setModeLabel(event.modeLabel);
            return;
          }

          if (event.type === 'delta') {
            updateAssistantMessage(assistantMessage.id, (message) => ({
              ...message,
              content: `${message.content}${event.delta}`,
            }));
            return;
          }

          if (event.type === 'error') {
            streamFailed = true;
            setInlineError(event.message);
            setStatus('error');
            return;
          }

          if (event.type === 'done') {
            setStatus('idle');
          }
        },
        controller.signal,
      );

      if (!streamFailed) {
        setStatus('idle');
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      setInlineError(error instanceof Error ? error.message : 'The tutor could not start a response.');
      setStatus('error');
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
      }
    }
  }

  return (
    <section className="tutor-card" aria-label="AWS AI tutor">
      <div className="section-heading">
        <div>
          <p className="eyebrow">AI tutor</p>
          <h3>Ask about this topic in context</h3>
        </div>
        <div className="tutor-badges">
          {modeLabel ? <span className={`mode-badge ${mode === 'mock' ? 'mock' : 'live'}`}>{modeLabel}</span> : null}
          <span className="topic-badge">{track.label}</span>
        </div>
      </div>

      <p className="tutor-intro">
        The tutor stays inside AWS study mode and uses the current topic plus retrieved curriculum snippets before it
        answers.
      </p>

      <div className="prompt-chip-list">
        {starterPrompts.map((starterPrompt) => (
          <button
            key={starterPrompt}
            type="button"
            className="prompt-chip"
            onClick={() => setPrompt(starterPrompt)}
            disabled={status === 'streaming'}
          >
            {starterPrompt}
          </button>
        ))}
      </div>

      <form
        className="tutor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <label className="tutor-label" htmlFor="tutor-prompt">
          Ask the AWS tutor
        </label>
        <textarea
          id="tutor-prompt"
          className="tutor-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={`Ask how ${topic.shortLabel} fits the ${track.label} exam...`}
          rows={4}
          disabled={status === 'streaming'}
        />
        <div className="tutor-actions">
          <button type="submit" className="submit-button" disabled={!draftPrompt || status === 'streaming'}>
            {status === 'streaming' ? 'Streaming reply...' : 'Ask tutor'}
          </button>
          {status === 'streaming' ? <p className="streaming-note">Streaming reply into the study view now.</p> : null}
        </div>
      </form>

      <div className="transcript-panel" aria-live="polite">
        <div className="transcript-heading">
          <h4>Tutor transcript</h4>
          <span>{messages.length === 0 ? 'No replies yet' : `${messages.filter((message) => message.role === 'assistant').length} replies`}</span>
        </div>

        {messages.length === 0 ? (
          <p className="transcript-empty">
            Submit a question from this topic view to keep the explanation and the study notes visible together.
          </p>
        ) : (
          <div className="message-stack">
            {messages.map((message) => (
              <article
                key={message.id}
                className={`message-bubble ${message.role}`}
                data-testid={message.role === 'assistant' ? 'assistant-message' : 'user-message'}
              >
                <p className="message-role">{message.role === 'assistant' ? 'Tutor' : 'You'}</p>
                <p>{message.content || (message.role === 'assistant' && status === 'streaming' ? '...' : '')}</p>
              </article>
            ))}
          </div>
        )}

        {inlineError ? <p className="tutor-error">{inlineError}</p> : null}
      </div>

      <details className="grounding-panel" open={Boolean(visibleGrounding)}>
        <summary>Grounding details</summary>
        {visibleGrounding ? (
          <div className="grounding-details">
            <div className="grounding-metadata">
              <div>
                <span>Topic</span>
                <strong>{visibleGrounding.topicName}</strong>
              </div>
              <div>
                <span>Certification track</span>
                <strong>{visibleGrounding.trackLabel}</strong>
              </div>
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
        ) : (
          <p className="grounding-empty">
            Start typing or submit a question to inspect the topic, track, and retrieved AWS snippets that ground the
            tutor request.
          </p>
        )}
      </details>
    </section>
  );
}
