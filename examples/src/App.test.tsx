import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App.js';

afterEach(() => {
  window.localStorage.clear();
});

describe('AWS study shell', () => {
  it('renders the certification shell and switches topics from the curriculum map', async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(screen.getByRole('heading', { name: /AWS study shell for focused certification prep/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Cloud Practitioner/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Solutions Architect Associate/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /Compute/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Storage/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Database/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Networking & Edge/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Confidence, review timing, and learning momentum/i })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Amazon DynamoDB/i })[0]);

    expect(screen.getByRole('heading', { name: 'Amazon DynamoDB' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Use cases' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trade-offs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Operational notes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pricing notes' })).toBeInTheDocument();
  });
});
