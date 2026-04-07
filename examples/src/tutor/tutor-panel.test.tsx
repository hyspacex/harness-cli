import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App.js';
import { TutorStreamEvent } from './client.js';

function createStreamingResponse(events: TutorStreamEvent[], delayMs = 120): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      events.forEach((event, index) => {
        setTimeout(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

          if (index === events.length - 1) {
            controller.close();
          }
        }, delayMs * (index + 1));
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tutor panel', () => {
  it('stays embedded in the topic view and streams one assistant message incrementally', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      createStreamingResponse([
        {
          type: 'meta',
          mode: 'mock',
          modeLabel: 'Demo mode',
          grounding: {
            prompt: 'When should I use Lambda instead of EC2?',
            topicId: 'lambda',
            topicName: 'AWS Lambda',
            trackId: 'cloud-practitioner',
            trackLabel: 'Cloud Practitioner',
            snippets: [
              {
                id: 'lambda-overview',
                topicId: 'lambda',
                topicName: 'AWS Lambda',
                title: 'AWS Lambda overview',
                excerpt: 'AWS Lambda runs code in response to events without managing servers.',
                source: 'overview',
              },
            ],
          },
        },
        { type: 'delta', delta: 'Choose AWS Lambda for event-driven' },
        { type: 'delta', delta: ' workloads and Amazon EC2 for host-level control.' },
        { type: 'done' },
      ]),
    );

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(screen.getByRole('heading', { name: 'Amazon S3' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ask about this topic in context/i })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /AWS Lambda/i })[0]);

    expect(screen.getByRole('heading', { name: 'AWS Lambda' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ask about this topic in context/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Ask the AWS tutor/i), 'When should I use Lambda instead of EC2?');
    await user.click(screen.getByRole('button', { name: /Ask tutor/i }));

    expect(await screen.findByText(/Demo mode/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByTestId('assistant-message')[0]).toHaveTextContent(/Choose AWS Lambda for event-driven/i);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('assistant-message')[0]).toHaveTextContent(
        /Choose AWS Lambda for event-driven workloads and Amazon EC2 for host-level control\./i,
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/Streaming reply into the study view now/i)).not.toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { name: 'AWS Lambda' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Tutor transcript/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tutor',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('preserves partial streamed text on failure and keeps the study surface usable', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        createStreamingResponse([
          {
            type: 'meta',
            mode: 'mock',
            modeLabel: 'Demo mode',
            grounding: {
              prompt: 'Compare S3 and EBS for durability and access patterns.',
              topicId: 's3',
              topicName: 'Amazon S3',
              trackId: 'cloud-practitioner',
              trackLabel: 'Cloud Practitioner',
              snippets: [
                {
                  id: 's3-overview',
                  topicId: 's3',
                  topicName: 'Amazon S3',
                  title: 'Amazon S3 overview',
                  excerpt: 'Amazon S3 is AWS object storage for durable object access.',
                  source: 'overview',
                },
              ],
            },
          },
          { type: 'delta', delta: 'Amazon S3 is regional object storage' },
          {
            type: 'error',
            message:
              'The tutor lost its connection after the first streamed chunk. Partial guidance is preserved below, and you can retry from this topic.',
          },
        ]),
      ),
    );

    render(<App />);

    await user.type(
      screen.getByLabelText(/Ask the AWS tutor/i),
      'Compare S3 and EBS for durability and access patterns.',
    );
    await user.click(screen.getByRole('button', { name: /Ask tutor/i }));

    await waitFor(() => {
      expect(screen.getAllByTestId('assistant-message')[0]).toHaveTextContent(/Amazon S3 is regional object storage/i);
    });

    expect(
      await screen.findByText(
        /The tutor lost its connection after the first streamed chunk. Partial guidance is preserved below, and you can retry from this topic./i,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /AWS Lambda/i })[0]);

    expect(screen.getByRole('heading', { name: 'AWS Lambda' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ask about this topic in context/i })).toBeInTheDocument();
  });
});
