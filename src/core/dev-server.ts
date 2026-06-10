import { spawn, type ChildProcess } from 'node:child_process';

const DEFAULT_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/;

interface StartOptions {
  timeout: number;
  readyPattern?: string | null;
}

export class DevServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private collected = '';

  async start(command: string, cwd: string, options: StartOptions): Promise<string> {
    if (this.child) throw new Error('DevServer already running');

    const readyRe = options.readyPattern ? new RegExp(options.readyPattern) : DEFAULT_URL_PATTERN;

    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, [], {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.child = child;

      const timer = setTimeout(() => {
        const match = this.collected.match(DEFAULT_URL_PATTERN);
        if (match) {
          this.url = match[0];
          resolve(this.url);
          return;
        }
        reject(
          new Error(
            `Dev server did not become ready within ${options.timeout}ms.\nCollected output:\n${this.collected.slice(-1000)}`,
          ),
        );
      }, options.timeout);

      const onData = (chunk: Buffer | string) => {
        const text = String(chunk);
        this.collected += text;
        const match = text.match(readyRe) || this.collected.match(readyRe);
        if (!match) return;
        clearTimeout(timer);
        const urlMatch = match[0].match(DEFAULT_URL_PATTERN) || match;
        this.url = urlMatch[0];
        resolve(this.url);
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (!this.url) {
          clearTimeout(timer);
          reject(
            new Error(`Dev server exited with code ${code} before becoming ready.\n${this.collected.slice(-1000)}`),
          );
        }
      });
    });
  }

  getUrl(): string | null {
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.url = null;
    this.collected = '';

    if (child.killed) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // ignore
        }
        resolve();
      }, 5000);

      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    });
  }
}
