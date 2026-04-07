import path from 'node:path';
import fs from 'node:fs/promises';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Backlog,
  CanonicalContract,
  CanonicalEvaluation,
  ConfidenceLevel,
  EvidenceQuality,
  EvalCriteria,
  Feature,
  HarnessConfig,
  HarnessVerdict,
  NegotiationRound,
  ProviderRegistry,
  RepairDirective,
  RepairDirectiveCriterion,
  RoleProviderMap,
  RunState,
  TaskCapabilities,
} from './types.js';
import { DevServer } from './dev-server.js';
import {
  appendNdjson,
  copyTree,
  ensureDir,
  extractJsonObject,
  fileExists,
  getNextPendingFeature,
  hashFile,
  listFilesRecursive,
  newRunId,
  nowIso,
  readJson,
  readText,
  relativeTo,
  getFailingScores,
  getPassingScores,
  deriveContractPassBarOverrides,
  isPlainObject,
  resolvePass,
  truncate,
  validateBacklog,
  writeJson,
  writeText,
} from './utils.js';
import {
  buildEvaluatorPrompt,
  buildEvaluatorReviewContractPrompt,
  buildGeneratorDraftContractPrompt,
  buildGeneratorPrompt,
  buildPlannerPrompt,
  buildResearcherPrompt,
  createPromptContext,
  UNIVERSAL_RUBRICS,
} from './prompts.js';

const execAsync = promisify(execCallback);

interface Output {
  log(...args: unknown[]): void;
}

interface ShellCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DevSmokeResult {
  ok: boolean;
  logPath: string;
  url: string;
  statusCode: number | null;
  bodySnippet: string;
  error: string | null;
}

interface SprintProgress {
  passed: boolean;
  nextRound: number;
  latestEvalPath: string | null;
  latestEvalParsed: Record<string, unknown> | null;
  allEvalPaths: string[];
  allFrozenEvidenceDirs: string[];
}

export class HarnessRunner {
  private config: HarnessConfig;
  private providerRegistry: ProviderRegistry;
  private roleProviders: RoleProviderMap;
  private capabilities: Record<'researcher' | 'planner' | 'generator' | 'evaluator', TaskCapabilities>;
  private output: Output;

  constructor(config: HarnessConfig, providerRegistry: ProviderRegistry, output: Output = console) {
    this.config = config;
    this.providerRegistry = providerRegistry;
    this.roleProviders = providerRegistry.getRouting();
    this.capabilities = {
      researcher: providerRegistry.getTaskCapabilities('researcher'),
      planner: providerRegistry.getTaskCapabilities('planner'),
      generator: providerRegistry.getTaskCapabilities('generator'),
      evaluator: providerRegistry.getTaskCapabilities('evaluator'),
    };
    this.output = output;
  }

  async runNew(prompt: string): Promise<RunState> {
    const runState = await this.createRunState(prompt);
    await this.saveRunState(runState);
    return this.execute(runState);
  }

  async resume(runId: string): Promise<RunState> {
    const runDir = path.join(this.config.runRoot, 'runs', runId);
    const runStatePath = path.join(runDir, 'run.json');
    const runState = await readJson<RunState | null>(runStatePath, null);
    if (!runState) {
      throw new Error(`Run not found: ${runId}`);
    }
    runState.runDir = runDir;
    return this.execute(runState);
  }

  async status(runId?: string): Promise<RunState | null> {
    if (!runId) return null;
    const runStatePath = path.join(this.config.runRoot, 'runs', runId, 'run.json');
    return readJson<RunState | null>(runStatePath, null);
  }

  // ---------- Run state setup ----------

  private async createRunState(prompt: string): Promise<RunState> {
    const runId = newRunId(prompt);
    const runDir = path.join(this.config.runRoot, 'runs', runId);
    const state: RunState = {
      id: runId,
      prompt,
      provider: this.providerSummary(),
      roleProviders: { ...this.roleProviders },
      workspace: this.config.workspace,
      runDir,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'created',
      lastError: null,
      sprint: 0,
      repairRound: 0,
      currentFeatureId: null,
      currentContractPath: null,
      currentContractJsonPath: null,
      currentEvalPath: null,
      currentEvalJsonPath: null,
      currentVerdictPath: null,
      summary: null,
      metrics: this.createInitialMetrics(),
      generatorSessionIds: {},
      currentNegotiation: null,
      smokeInstalledAt: null,
    };

    await this.initializeRunFiles(state);
    return state;
  }

  private async initializeRunFiles(runState: RunState): Promise<void> {
    const paths = this.runPaths(runState);
    await Promise.all([
      ensureDir(runState.runDir),
      ensureDir(path.join(runState.runDir, 'plan')),
      ensureDir(path.join(runState.runDir, 'contracts')),
      ensureDir(path.join(runState.runDir, 'evals')),
      ensureDir(path.join(runState.runDir, 'evals', 'evidence')),
      ensureDir(path.join(runState.runDir, 'evals', 'evidence-frozen')),
      ensureDir(path.join(runState.runDir, 'verdicts')),
      ensureDir(path.join(runState.runDir, 'repair-directives')),
      ensureDir(path.join(runState.runDir, 'handoff')),
      ensureDir(path.join(runState.runDir, 'benchmarks', 'frozen')),
      ensureDir(path.join(runState.runDir, 'logs')),
      ensureDir(this.config.workspace),
      ensureDir(this.config.runRoot),
      ensureDir(path.join(this.config.runRoot, 'runs')),
    ]);

    await writeText(paths.prompt, `${runState.prompt}\n`);
    if (!(await fileExists(paths.progress))) {
      await writeText(
        paths.progress,
        '# Progress\n\nNo implementation work has happened yet.\n\nResume notes:\n- Start with planning artifacts.\n',
      );
    }
    if (!(await fileExists(paths.nextHandoff))) {
      await writeText(paths.nextHandoff, 'No handoff yet.\n');
    }
  }

  // ---------- Workspace prep ----------

  private async ensureSkills(): Promise<void> {
    for (const [name, sourcePath] of Object.entries(this.config.skills)) {
      if (!sourcePath) continue;

      const destinations = [
        path.join(this.config.workspace, '.claude', 'skills', name, 'SKILL.md'),
        path.join(this.config.workspace, '.agents', 'skills', name, 'SKILL.md'),
      ];

      for (const destPath of destinations) {
        if (await fileExists(destPath)) continue;
        try {
          await ensureDir(path.dirname(destPath));
          await fs.copyFile(sourcePath, destPath);
          this.output.log(`✦ Installed ${name} skill into ${relativeTo(this.config.workspace, destPath)}`);
        } catch (err) {
          this.output.log(`⚠ Could not copy ${name} skill to ${destPath}: ${err}`);
        }
      }
    }

    if (new Set(Object.values(this.roleProviders)).has('codex')) {
      await this.ensureCodexProjectInstructions();
    }
  }

  private async ensureCodexProjectInstructions(): Promise<void> {
    const claudeMd = path.join(this.config.workspace, 'CLAUDE.md');
    const agentsMd = path.join(this.config.workspace, 'AGENTS.md');
    if (!(await fileExists(claudeMd)) || (await fileExists(agentsMd))) {
      return;
    }

    try {
      await fs.copyFile(claudeMd, agentsMd);
      this.output.log('✦ Seeded AGENTS.md from CLAUDE.md for Codex compatibility');
    } catch (error) {
      this.output.log(`⚠ Could not seed AGENTS.md from CLAUDE.md: ${error}`);
    }
  }

  // ---------- Smoke / dev server lifecycle ----------

  private async ensureSmokeInstalled(runState: RunState): Promise<void> {
    if (!this.config.smoke.install || runState.smokeInstalledAt) {
      return;
    }

    this.output.log(`→ smoke-install`);
    const result = await this.runShellCommand(this.config.smoke.install, this.config.workspace);
    const logPath = path.join(runState.runDir, 'logs', 'smoke-install.log');
    await writeText(logPath, formatCommandResult(this.config.smoke.install, result));

    if (!result.ok) {
      throw new Error(
        `Smoke install failed. See ${relativeTo(runState.runDir, logPath)} for details.`,
      );
    }

    runState.smokeInstalledAt = nowIso();
    await this.saveRunState(runState);
    await this.log(runState, {
      type: 'smoke.install',
      command: this.config.smoke.install,
      logPath: relativeTo(runState.runDir, logPath),
    });
    this.output.log('✓ smoke-install');
  }

  private async startDevServer(runState: RunState): Promise<DevServer | null> {
    if (!this.config.smoke.start) return null;

    await this.ensureSmokeInstalled(runState);

    const server = new DevServer();
    const url = await server.start(this.config.smoke.start, this.config.workspace, {
      timeout: this.config.smoke.startTimeout,
      readyPattern: this.config.smoke.startReadyPattern,
    });
    this.output.log(`⚡ Dev server running at ${url}`);
    return server;
  }

  private async runDevServerSmoke(
    runState: RunState,
    sprintNumber: number,
    evaluationRound: number,
    url: string,
  ): Promise<DevSmokeResult> {
    const targetUrl = url;
    const logPath = path.join(
      runState.runDir,
      'logs',
      `dev-smoke-s${this.sprintPad(sprintNumber)}-r${this.roundPad(evaluationRound)}.log`,
    );

    this.output.log('→ dev-smoke');

    try {
      const response = await fetch(targetUrl, {
        signal: AbortSignal.timeout(Math.max(3000, Math.min(this.config.smoke.startTimeout, 15000))),
        redirect: 'follow',
      });
      const bodyText = await response.text();
      const ok = response.status >= 200 && response.status < 400;
      const bodySnippet = truncate(bodyText, 400);
      await writeText(
        logPath,
        [
          `$ GET ${targetUrl}`,
          '',
          `status: ${response.status}`,
          '',
          'body:',
          bodySnippet,
          '',
        ].join('\n'),
      );
      await this.log(runState, {
        type: 'smoke.dev',
        ok,
        statusCode: response.status,
        url: targetUrl,
        logPath: relativeTo(runState.runDir, logPath),
      });
      this.recordDevSmokeResult(ok, runState);
      if (ok) {
        this.output.log('✓ dev-smoke');
      } else {
        this.output.log(`⚠ dev-smoke failed — ${relativeTo(runState.runDir, logPath)}`);
      }
      return {
        ok,
        logPath,
        url: targetUrl,
        statusCode: response.status,
        bodySnippet,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeText(
        logPath,
        [
          `$ GET ${targetUrl}`,
          '',
          'status: request_failed',
          '',
          'error:',
          message,
          '',
        ].join('\n'),
      );
      await this.log(runState, {
        type: 'smoke.dev',
        ok: false,
        statusCode: null,
        url: targetUrl,
        logPath: relativeTo(runState.runDir, logPath),
        error: message,
      });
      this.recordDevSmokeResult(false, runState);
      this.output.log(`⚠ dev-smoke failed — ${relativeTo(runState.runDir, logPath)}`);
      return {
        ok: false,
        logPath,
        url: targetUrl,
        statusCode: null,
        bodySnippet: '',
        error: message,
      };
    }
  }

  private async runSmokeTest(
    runState: RunState,
    sprintNumber: number,
    evaluationRound: number,
  ): Promise<{ ok: boolean; logPath: string; stdout: string; stderr: string } | null> {
    if (!this.config.smoke.test) return null;

    this.output.log('→ smoke-test');
    const result = await this.runShellCommand(this.config.smoke.test, this.config.workspace);
    const logPath = path.join(
      runState.runDir,
      'logs',
      `smoke-test-s${this.sprintPad(sprintNumber)}-r${this.roundPad(evaluationRound)}.log`,
    );
    await writeText(logPath, formatCommandResult(this.config.smoke.test, result));
    await this.log(runState, {
      type: 'smoke.test',
      command: this.config.smoke.test,
      ok: result.ok,
      logPath: relativeTo(runState.runDir, logPath),
    });
    if (result.ok) {
      this.output.log('✓ smoke-test');
    } else {
      this.output.log(`⚠ smoke-test failed — ${relativeTo(runState.runDir, logPath)}`);
    }
    return { ok: result.ok, logPath, stdout: result.stdout, stderr: result.stderr };
  }

  private async stopDevServer(runState: RunState, server: DevServer | null): Promise<void> {
    if (server) {
      await server.stop();
      this.output.log('⏹ Dev server stopped');
    }

    if (!this.config.smoke.stop) return;

    const result = await this.runShellCommand(this.config.smoke.stop, this.config.workspace);
    const logPath = path.join(runState.runDir, 'logs', 'smoke-stop.log');
    await writeText(logPath, formatCommandResult(this.config.smoke.stop, result));
    await this.log(runState, {
      type: 'smoke.stop',
      command: this.config.smoke.stop,
      ok: result.ok,
      logPath: relativeTo(runState.runDir, logPath),
    });
    if (!result.ok) {
      this.output.log(`⚠ smoke-stop failed — ${relativeTo(runState.runDir, logPath)}`);
    }
  }

  // ---------- Main execution loop ----------

  private async execute(runState: RunState): Promise<RunState> {
    try {
      await this.ensureSkills();

      const evalCriteria = await this.ensureResearch(runState);
      const backlog = await this.ensurePlan(runState, evalCriteria);

      runState.status = 'running';
      await this.saveRunState(runState);

      while (runState.sprint < this.config.maxSprints) {
        const feature = await this.getCurrentOrNextFeature(runState, backlog);
        if (!feature) {
          const backlogComplete = backlog.features.every((candidate) => candidate.status === 'done');
          await this.finishRunFromBacklog(runState, backlog);
          if (backlogComplete) {
            await this.runFinalRegression(runState);
          }
          return runState;
        }

        const isResumedSprint = runState.currentFeatureId === feature.id && feature.status === 'pending';
        if (isResumedSprint) {
          await this.normalizeActiveSprintState(runState, feature);
        } else {
          this.beginSprint(runState, feature);
          await this.saveRunState(runState);
        }

        await this.negotiateContract(runState, feature, evalCriteria);

        let passed = false;
        const progress = await this.loadSprintProgress(runState, evalCriteria);
        let latestEvalPath = progress.latestEvalPath;
        let latestEvalParsed = progress.latestEvalParsed;
        let latestRepairDirectivePath: string | null = null;
        const allEvalPaths = [...progress.allEvalPaths];
        let latestFrozenEvidenceDir = progress.allFrozenEvidenceDirs.at(-1) || null;
        const allFrozenEvidenceDirs = [...progress.allFrozenEvidenceDirs];

        if (progress.passed) {
          passed = true;
        } else {
          for (let evaluationRound = progress.nextRound; evaluationRound <= this.config.maxRepairRounds; evaluationRound += 1) {
            runState.repairRound = evaluationRound;
            runState.currentEvalPath = this.evalPath(runState.sprint, evaluationRound, runState.runDir);
            runState.currentEvalJsonPath = this.evalJsonPath(runState.sprint, evaluationRound, runState.runDir);
            await this.saveRunState(runState);

            const genResult = await this.runGenerator(
              runState,
              feature,
              latestEvalPath,
              allEvalPaths,
              evalCriteria,
              latestFrozenEvidenceDir,
              allFrozenEvidenceDirs,
              latestRepairDirectivePath,
            );

            if (genResult.meta?.sessionId && !runState.generatorSessionIds[runState.sprint]) {
              runState.generatorSessionIds[runState.sprint] = genResult.meta.sessionId;
              await this.saveRunState(runState);
            }

            let devServer: DevServer | null = null;
            let evalResult: { parsed: Record<string, unknown> | null } | null = null;
            try {
              let devServerStarted = false;
              try {
                devServer = await this.startDevServer(runState);
                devServerStarted = true;
              } catch (error) {
                const logPath = path.join(
                  runState.runDir,
                  'logs',
                  `dev-smoke-s${this.sprintPad(runState.sprint)}-r${this.roundPad(evaluationRound)}.log`,
                );
                await writeText(logPath, String(error instanceof Error ? error.message : error));
                this.recordDevSmokeResult(false, runState);
                evalResult = await this.writeSyntheticSmokeFailureEval(
                  runState,
                  feature,
                  evaluationRound,
                  'dev-smoke',
                  logPath,
                  null,
                );
                await this.writeVerdict(runState, evaluationRound, evalResult.parsed, evalCriteria, true);
              }

              if (devServerStarted) {
                const devSmoke = devServer?.getUrl()
                  ? await this.runDevServerSmoke(runState, runState.sprint, evaluationRound, devServer.getUrl()!)
                  : null;

                if (devSmoke && !devSmoke.ok) {
                  evalResult = await this.writeSyntheticSmokeFailureEval(
                    runState,
                    feature,
                    evaluationRound,
                    'dev-smoke',
                    devSmoke.logPath,
                    devSmoke.url,
                  );
                  await this.writeVerdict(runState, evaluationRound, evalResult.parsed, evalCriteria, true);
                } else {
                  const smokeTest = await this.runSmokeTest(runState, runState.sprint, evaluationRound);
                  if (smokeTest && !smokeTest.ok) {
                    evalResult = await this.writeSyntheticSmokeFailureEval(
                      runState,
                      feature,
                      evaluationRound,
                      'smoke-test',
                      smokeTest.logPath,
                      devServer?.getUrl() || null,
                    );
                    await this.writeVerdict(runState, evaluationRound, evalResult.parsed, evalCriteria, true);
                  } else {
                    evalResult = await this.runEvaluator(
                      runState,
                      feature,
                      evaluationRound,
                      evalCriteria,
                      {
                        required: !!devServer?.getUrl(),
                        ok: devSmoke ? devSmoke.ok : !this.config.smoke.start,
                        logPath: devSmoke?.logPath || null,
                        url: devSmoke?.url || devServer?.getUrl() || null,
                      },
                      devServer?.getUrl(),
                      evaluationRound === 0 ? null : runState.currentVerdictPath,
                    );
                  }
                }
              }
            } finally {
              await this.stopDevServer(runState, devServer);
            }

            if (!evalResult) {
              throw new Error(`Evaluation round ${evaluationRound} did not produce a result.`);
            }

            latestFrozenEvidenceDir = await this.freezeEvaluatorEvidence(runState, evaluationRound);
            latestEvalPath = runState.currentEvalPath;
            latestEvalParsed = evalResult.parsed;
            allEvalPaths.push(runState.currentEvalPath);
            if (latestFrozenEvidenceDir) {
              allFrozenEvidenceDirs.push(latestFrozenEvidenceDir);
            }

            await this.freezeBenchmarkArtifacts(
              runState,
              `eval-s${this.sprintPad(runState.sprint)}-r${this.roundPad(evaluationRound)}`,
              [
                runState.currentEvalPath!,
                runState.currentEvalJsonPath!,
                ...(latestFrozenEvidenceDir ? [latestFrozenEvidenceDir] : []),
              ],
            );

            // Smoke failure paths already wrote a verdict — only write one for evaluator results
            const smokeVerdictAlreadyWritten = runState.currentVerdictPath !== null
              && runState.currentVerdictPath === this.verdictPath(runState.sprint, evaluationRound, runState.runDir);
            const verdict = smokeVerdictAlreadyWritten
              ? await readJson<HarnessVerdict>(runState.currentVerdictPath!, null as unknown as HarnessVerdict)
              : await this.writeVerdict(runState, evaluationRound, evalResult.parsed, evalCriteria, false);

            if (verdict.passed) {
              this.recordRepairRoundsToPass('generator', evaluationRound, runState);
              passed = true;
              break;
            }

            latestRepairDirectivePath = await this.writeRepairDirective(
              runState, evaluationRound, verdict, evalCriteria, latestFrozenEvidenceDir,
            );
          }
        }

        if (passed) {
          this.markFeatureDone(runState, feature);
          await writeJson(this.runPaths(runState).backlog, backlog);
          await this.saveRunState(runState);
          continue;
        }

        this.markFeatureBlocked(runState, feature, latestEvalParsed);
        await writeJson(this.runPaths(runState).backlog, backlog);
        await this.saveRunState(runState);

        if (this.config.failFast) {
          throw new Error(`Sprint ${runState.sprint} failed evaluation for ${feature.id}.`);
        }
      }

      runState.status = 'failed';
      runState.summary = `Reached maxSprints (${this.config.maxSprints}) before backlog completed.`;
      await this.saveRunState(runState);
      return runState;
    } catch (error) {
      runState.status = 'failed';
      runState.lastError = String(error instanceof Error ? error.message : error);
      runState.updatedAt = nowIso();
      await this.log(runState, { type: 'run.error', error: runState.lastError });
      await this.saveRunState(runState);
      throw error;
    }
  }

  private async getCurrentOrNextFeature(runState: RunState, backlog: Backlog): Promise<Feature | null> {
    const activeFeature = this.getActiveFeature(backlog, runState);
    if (activeFeature) {
      return activeFeature;
    }

    if (
      runState.currentFeatureId ||
      runState.currentContractPath ||
      runState.currentEvalPath ||
      runState.currentNegotiation
    ) {
      this.clearActiveSprintState(runState);
      await this.saveRunState(runState);
    }

    return getNextPendingFeature(backlog);
  }

  private getActiveFeature(backlog: Backlog, runState: RunState): Feature | null {
    if (!runState.currentFeatureId) return null;
    const feature = backlog.features.find((candidate) => candidate.id === runState.currentFeatureId) || null;
    if (!feature || feature.status !== 'pending') {
      return null;
    }
    return feature;
  }

  private beginSprint(runState: RunState, feature: Feature): void {
    runState.sprint += 1;
    runState.currentFeatureId = feature.id;
    runState.repairRound = 0;
    runState.currentContractPath = this.contractPath(runState.sprint, runState.runDir);
    runState.currentContractJsonPath = this.contractJsonPath(runState.sprint, runState.runDir);
    runState.currentEvalPath = null;
    runState.currentEvalJsonPath = null;
    runState.currentNegotiation = null;
  }

  private async normalizeActiveSprintState(runState: RunState, feature: Feature): Promise<void> {
    let changed = false;

    if (runState.sprint < 1) {
      runState.sprint = 1;
      changed = true;
    }

    const expectedContractPath = this.contractPath(runState.sprint, runState.runDir);
    const preferredContractPath = runState.currentNegotiation?.finalContractPath || runState.currentContractPath || expectedContractPath;
    if (runState.currentContractPath !== preferredContractPath) {
      runState.currentContractPath = preferredContractPath;
      changed = true;
    }

    const expectedContractJsonPath = this.contractJsonPath(runState.sprint, runState.runDir);
    if (runState.currentContractJsonPath !== expectedContractJsonPath) {
      runState.currentContractJsonPath = expectedContractJsonPath;
      changed = true;
    }

    if (runState.currentNegotiation && runState.currentNegotiation.featureId !== feature.id) {
      runState.currentNegotiation = null;
      changed = true;
    }

    if (runState.currentEvalPath && !(await fileExists(runState.currentEvalPath))) {
      const expectedEvalPath = this.evalPath(runState.sprint, runState.repairRound, runState.runDir);
      if (runState.currentEvalPath !== expectedEvalPath) {
        runState.currentEvalPath = expectedEvalPath;
        changed = true;
      }
    }

    const expectedEvalJsonPath = this.evalJsonPath(runState.sprint, runState.repairRound, runState.runDir);
    if (runState.currentEvalJsonPath !== expectedEvalJsonPath) {
      runState.currentEvalJsonPath = expectedEvalJsonPath;
      changed = true;
    }

    if (changed) {
      await this.saveRunState(runState);
    }
  }

  private clearActiveSprintState(runState: RunState): void {
    runState.currentFeatureId = null;
    runState.currentContractPath = null;
    runState.currentContractJsonPath = null;
    runState.currentEvalPath = null;
    runState.currentEvalJsonPath = null;
    runState.currentVerdictPath = null;
    runState.currentNegotiation = null;
    runState.repairRound = 0;
  }

  private markFeatureDone(runState: RunState, feature: Feature): void {
    if (feature.status !== 'done') {
      feature.status = 'done';
      feature.completedAt = nowIso();
      runState.metrics.completedFeatures += 1;
    }
    this.clearActiveSprintState(runState);
    runState.summary = `Completed ${feature.id}: ${feature.title}`;
  }

  private markFeatureBlocked(
    runState: RunState,
    feature: Feature,
    latestEvalParsed: Record<string, unknown> | null,
  ): void {
    if (feature.status !== 'blocked') {
      feature.status = 'blocked';
      feature.blockedAt = nowIso();
      runState.metrics.blockedFeatures += 1;
    }
    this.clearActiveSprintState(runState);
    runState.status = this.config.failFast ? 'failed' : 'running';
    runState.summary = (latestEvalParsed?.summary as string) || `Sprint ${runState.sprint} failed.`;
  }

  private async finishRunFromBacklog(runState: RunState, backlog: Backlog): Promise<void> {
    const pending = backlog.features.filter((feature) => feature.status === 'pending');
    const blocked = backlog.features.filter((feature) => feature.status === 'blocked');
    const done = backlog.features.filter((feature) => feature.status === 'done');

    if (pending.length > 0) {
      runState.status = 'failed';
      runState.summary =
        `${done.length}/${backlog.features.length} features done. ` +
        `${blocked.length} blocked, ${pending.length} skipped (unmet dependencies: ` +
        `${pending.map((feature) => feature.id).join(', ')}).`;
    } else {
      runState.status = 'completed';
      runState.summary =
        blocked.length > 0
          ? `${done.length}/${backlog.features.length} features done, ${blocked.length} blocked (${blocked.map((feature) => feature.id).join(', ')}).`
          : 'All features complete.';
    }

    this.clearActiveSprintState(runState);
    await this.saveRunState(runState);
  }

  private async loadSprintProgress(
    runState: RunState,
    evalCriteria: EvalCriteria | null,
  ): Promise<SprintProgress> {
    const allEvalPaths: string[] = [];
    const allFrozenEvidenceDirs: string[] = [];
    let latestEvalPath: string | null = null;
    let latestEvalParsed: Record<string, unknown> | null = null;

    for (let round = 0; round <= this.config.maxRepairRounds; round += 1) {
      const evalPath = this.evalPath(runState.sprint, round, runState.runDir);
      if (!(await fileExists(evalPath))) continue;

      allEvalPaths.push(evalPath);
      latestEvalPath = evalPath;
      latestEvalParsed = await this.readParsedTaskLog(this.evaluatorLogName(runState.sprint, round), runState);

      const frozenEvidenceDir = this.frozenEvidenceDir(runState.sprint, round, runState.runDir);
      if (await fileExists(frozenEvidenceDir)) {
        allFrozenEvidenceDirs.push(frozenEvidenceDir);
      }
    }

    return {
      passed: resolvePass(latestEvalParsed, evalCriteria, runState.currentNegotiation?.passBarOverrides ?? {}),
      nextRound: allEvalPaths.length,
      latestEvalPath,
      latestEvalParsed,
      allEvalPaths,
      allFrozenEvidenceDirs,
    };
  }

  // ---------- Research / plan ----------

  private async ensureResearch(runState: RunState): Promise<EvalCriteria | null> {
    const paths = this.runPaths(runState);
    const criteriaExists = await fileExists(paths.evalCriteria);
    const briefExists = await fileExists(paths.researchBrief);

    if (!criteriaExists || !briefExists) {
      runState.status = 'planning';
      await this.saveRunState(runState);
      const context = createPromptContext(this.config, runState, this.capabilities);
      const prompt = buildResearcherPrompt(context);
      await this.runTask(
        runState,
        {
          kind: 'researcher',
          label: 'researcher',
          cwd: this.config.workspace,
          prompt,
          userPrompt: runState.prompt,
          artifacts: {
            researchBrief: paths.researchBrief,
            evalCriteria: paths.evalCriteria,
          },
        },
        'researcher',
      );

      await this.freezeBenchmarkArtifacts(runState, 'research', [
        paths.researchBrief,
        paths.evalCriteria,
      ]);
    }

    return readJson<EvalCriteria | null>(paths.evalCriteria, null);
  }

  private async ensurePlan(runState: RunState, evalCriteria: EvalCriteria | null): Promise<Backlog> {
    const paths = this.runPaths(runState);
    const backlogExists = await fileExists(paths.backlog);
    const specExists = await fileExists(paths.spec);
    const principlesExist = await fileExists(paths.projectPrinciples);

    if (!backlogExists || !specExists || !principlesExist) {
      runState.status = 'planning';
      await this.saveRunState(runState);
      const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
      const prompt = buildPlannerPrompt(context);
      await this.runTask(
        runState,
        {
          kind: 'planner',
          label: 'planner',
          cwd: this.config.workspace,
          prompt,
          userPrompt: runState.prompt,
          artifacts: {
            spec: paths.spec,
            backlog: paths.backlog,
            projectPrinciples: paths.projectPrinciples,
          },
        },
        'planner',
      );

      await this.freezeBenchmarkArtifacts(runState, 'plan', [
        paths.spec,
        paths.backlog,
        paths.projectPrinciples,
      ]);
    }

    const backlogRaw = await readJson<Backlog | null>(paths.backlog, null);
    const backlog = validateBacklog(backlogRaw);
    await writeJson(paths.backlog, backlog);
    return backlog;
  }

  // ---------- Contract negotiation ----------

  private async extractPassBarOverrides(
    runState: RunState,
    evalCriteria: EvalCriteria | null,
  ): Promise<Record<string, number>> {
    if (!runState.currentContractJsonPath) return {};
    try {
      const contract = await this.readCanonicalContract(runState.currentContractJsonPath);
      return deriveContractPassBarOverrides(contract, evalCriteria);
    } catch {
      return {};
    }
  }

  private async negotiateContract(
    runState: RunState,
    feature: Feature,
    evalCriteria: EvalCriteria | null,
  ): Promise<void> {
    const maxRounds = Math.max(1, this.config.maxNegotiationRounds);
    const sprintPad = this.sprintPad(runState.sprint);

    if (!runState.currentNegotiation || runState.currentNegotiation.featureId !== feature.id) {
      runState.currentNegotiation = {
        featureId: feature.id,
        sprint: runState.sprint,
        rounds: [],
        finalContractPath: null,
        status: 'drafting',
        passBarOverrides: {},
      };
      await this.saveRunState(runState);
    }

    const negotiation = runState.currentNegotiation;

    if (negotiation.status === 'approved' && negotiation.finalContractPath) {
      runState.currentContractPath = negotiation.finalContractPath;
      await this.saveRunState(runState);
      return;
    }

    for (let round = 0; round < maxRounds; round += 1) {
      let roundState: NegotiationRound | undefined = negotiation.rounds[round];

      if (!roundState) {
        const previousReviewPath = round > 0 ? negotiation.rounds[round - 1].reviewPath : null;
        negotiation.status = 'drafting';
        await this.saveRunState(runState);

        const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
        const draftPrompt = buildGeneratorDraftContractPrompt(
          context,
          feature,
          runState.sprint,
          round,
          previousReviewPath,
        );
        const roundPad = this.roundPad(round);
        await this.runTask(
          runState,
          {
            kind: 'generator',
            label: `contract-draft-s${runState.sprint}-n${round}`,
            cwd: this.config.workspace,
            prompt: draftPrompt,
            sprintNumber: runState.sprint,
            feature,
            artifacts: {
              contract: runState.currentContractPath!,
              contractJson: runState.currentContractJsonPath!,
            },
          },
          `contract-draft-s${sprintPad}-n${roundPad}`,
        );
        this.recordContractApprovalAttempt('generator', runState);

        roundState = {
          round,
          draftPath: runState.currentContractPath!,
          reviewPath: null,
          approved: false,
        };
        negotiation.rounds.push(roundState);
        await this.saveRunState(runState);
      }

      if (roundState.reviewPath && roundState.approved) {
        negotiation.finalContractPath = runState.currentContractPath!;
        negotiation.status = 'approved';
        await this.saveRunState(runState);
        return;
      }

      if (!roundState.reviewPath) {
        const reviewPath = path.join(
          runState.runDir,
          'contracts',
          `contract-${sprintPad}-review-${this.roundPad(round)}.md`,
        );

        negotiation.status = 'reviewing';
        await this.saveRunState(runState);

        const reviewContext = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
        const reviewPrompt = buildEvaluatorReviewContractPrompt(
          reviewContext,
          feature,
          runState.sprint,
          round,
          runState.currentContractPath!,
          reviewPath,
        );
        const roundPad = this.roundPad(round);
        const reviewResult = await this.runTask(
          runState,
          {
            kind: 'evaluator',
            label: `contract-review-s${runState.sprint}-n${round}`,
            cwd: this.config.workspace,
            prompt: reviewPrompt,
            sprintNumber: runState.sprint,
            feature,
            artifacts: { review: reviewPath },
          },
          `contract-review-s${sprintPad}-n${roundPad}`,
        );

        roundState.reviewPath = reviewPath;
        this.recordContractApprovalAttempt('evaluator', runState);
        roundState.approved = reviewResult.parsed?.status === 'approved';
        await this.saveRunState(runState);

        if (roundState.approved) {
          this.recordContractApprovalPass('generator', runState);
          this.recordContractApprovalPass('evaluator', runState);
          negotiation.finalContractPath = runState.currentContractPath!;
          negotiation.status = 'approved';
          await this.saveRunState(runState);
          await this.freezeBenchmarkArtifacts(runState, `contract-s${sprintPad}`, [
            runState.currentContractPath!,
            runState.currentContractJsonPath!,
            reviewPath,
          ]);
          this.output.log(`✓ Contract approved after ${round + 1} negotiation round(s)`);
          negotiation.passBarOverrides = await this.extractPassBarOverrides(runState, evalCriteria);
          await this.saveRunState(runState);
          return;
        }
      }
    }

    negotiation.status = 'exhausted';
    negotiation.finalContractPath = runState.currentContractPath!;
    await this.saveRunState(runState);
    await this.freezeBenchmarkArtifacts(runState, `contract-s${sprintPad}-exhausted`, [
      runState.currentContractPath!,
      runState.currentContractJsonPath!,
      ...negotiation.rounds.map((roundState) => roundState.reviewPath).filter(Boolean) as string[],
    ]);
    this.output.log(`⚠ Contract negotiation exhausted after ${maxRounds} round(s) — using last draft`);
    negotiation.passBarOverrides = await this.extractPassBarOverrides(runState, evalCriteria);
    await this.saveRunState(runState);
  }

  // ---------- Generator / evaluator ----------

  private async runGenerator(
    runState: RunState,
    feature: Feature,
    previousEvalPath: string | null,
    allPriorEvalPaths: string[] = [],
    evalCriteria: EvalCriteria | null = null,
    latestFrozenEvidenceDir: string | null = null,
    allPriorFrozenEvidenceDirs: string[] = [],
    repairDirectivePath: string | null = null,
  ): Promise<{ parsed: Record<string, unknown> | null; meta: { sessionId?: string } }> {
    await this.assertFrozenEvidenceIntact(runState, latestFrozenEvidenceDir);

    const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
    const prompt = buildGeneratorPrompt(
      context,
      feature,
      runState.sprint,
      runState.repairRound,
      previousEvalPath,
      allPriorEvalPaths,
      latestFrozenEvidenceDir,
      allPriorFrozenEvidenceDirs,
      repairDirectivePath,
    );

    const resumeSessionId = runState.repairRound > 0
      ? runState.generatorSessionIds[runState.sprint]
      : undefined;

    const result = await this.runTask(
      runState,
      {
        kind: 'generator',
        label: `generator-s${runState.sprint}-r${runState.repairRound}`,
        cwd: this.config.workspace,
        prompt,
        sprintNumber: runState.sprint,
        repairRound: runState.repairRound,
        feature,
        resumeSessionId,
        artifacts: {
          progress: context.paths.progress,
          nextHandoff: context.paths.nextHandoff,
        },
      },
      this.generatorLogName(runState.sprint, runState.repairRound),
    );

    await this.assertFrozenEvidenceIntact(runState, latestFrozenEvidenceDir);
    return result;
  }

  private async runEvaluator(
    runState: RunState,
    feature: Feature,
    evaluationRound: number,
    evalCriteria: EvalCriteria | null,
    devSmoke: {
      required: boolean;
      ok: boolean;
      logPath: string | null;
      url: string | null;
    },
    devServerUrl?: string | null,
    previousVerdictPath?: string | null,
  ): Promise<{ parsed: Record<string, unknown> | null }> {
    await ensureDir(this.evidenceDir(runState.sprint, evaluationRound, runState.runDir));
    const context = createPromptContext(this.config, runState, this.capabilities, evalCriteria);
    const prompt = buildEvaluatorPrompt(
      context,
      feature,
      runState.sprint,
      evaluationRound,
      this.capabilities.evaluator,
      devSmoke,
      devServerUrl,
      previousVerdictPath,
    );
    return this.runTask(
      runState,
      {
        kind: 'evaluator',
        label: `evaluator-s${runState.sprint}-r${evaluationRound}`,
        cwd: this.config.workspace,
        prompt,
        sprintNumber: runState.sprint,
        evaluationRound,
        feature,
        devServerUrl: devServerUrl ?? undefined,
        artifacts: {
          eval: runState.currentEvalPath!,
          evalJson: runState.currentEvalJsonPath!,
        },
      },
      this.evaluatorLogName(runState.sprint, evaluationRound),
    );
  }

  private async writeSyntheticSmokeFailureEval(
    runState: RunState,
    feature: Feature,
    evaluationRound: number,
    failureKind: 'dev-smoke' | 'smoke-test',
    smokeLogPath: string,
    url: string | null,
  ): Promise<{ parsed: Record<string, unknown> | null }> {
    const relativeLogPath = relativeTo(runState.runDir, smokeLogPath);
    const report = [
      `# Sprint ${runState.sprint} Evaluation Round ${evaluationRound}`,
      '',
      '## Scorecard',
      `- ${failureKind} failed before evaluator execution.`,
      '',
      '## Contract Criteria Check',
      `- Not fully evaluated because ${failureKind} failed.`,
      '',
      '## Project Principles Check',
      `- Not fully evaluated because ${failureKind} failed.`,
      '',
      '## Bugs',
      `- severity: high`,
      `- title: ${failureKind} failed`,
      `- repro: inspect ${relativeLogPath}`,
      `- expected: ${failureKind} succeeds before evaluator execution`,
      `- actual: ${failureKind} failed; see ${relativeLogPath}`,
      '',
      '## Suggested Repair Plan',
      `- Fix the failing ${failureKind} before the next evaluation round.`,
      '',
      '## Notes',
      `- Feature: ${feature.id} ${feature.title}`,
      `- Evidence: ${relativeLogPath}`,
      '',
    ].join('\n');
    await writeText(runState.currentEvalPath!, report);

    const parsed = {
      confidence: 'high',
      evidenceQuality: 'adequate',
      summary: `${failureKind} failed before evaluator execution.`,
      bugs: [
        {
          severity: 'high',
          title: `${failureKind} failed`,
          evidence: [relativeLogPath],
        },
      ],
      filesWritten: [runState.currentEvalPath!, runState.currentEvalJsonPath!, smokeLogPath],
    };

    const canonicalEval: CanonicalEvaluation = {
      version: 1,
      sprint: runState.sprint,
      evaluationRound,
      feature: {
        id: feature.id,
        title: feature.title,
      },
      confidence: 'high',
      evidenceQuality: 'adequate',
      summary: `${failureKind} failed before evaluator execution.`,
      scores: {},
      contractCriteria: [],
      projectPrinciples: [],
      bugs: [
        {
          severity: 'high',
          title: `${failureKind} failed`,
          repro: `Inspect ${relativeLogPath}`,
          expected: `${failureKind} succeeds before evaluator execution`,
          actual: `${failureKind} failed. See ${relativeLogPath}`,
          evidence: [relativeLogPath],
          rootCause: `Harness-side ${failureKind} check failed before evaluator execution.`,
          previousFixFailure: null,
        },
      ],
      suggestedRepairPlan: [`Fix the failing ${failureKind} before the next evaluation round.`],
      notes: [`Evidence: ${relativeLogPath}`],
      sourceMarkdownPath: runState.currentEvalPath!,
      devSmoke: {
        required: failureKind === 'dev-smoke',
        ok: false,
        logPath: relativeLogPath,
        url,
      },
    };
    await writeJson(runState.currentEvalJsonPath!, canonicalEval);
    this.recordEvaluatorConfidence('high', runState);
    this.recordEvidenceQuality('adequate', runState);

    await this.persistSyntheticTaskResult(
      runState,
      this.evaluatorLogName(runState.sprint, evaluationRound),
      'evaluator',
      `evaluator-s${runState.sprint}-r${evaluationRound}`,
      parsed,
    );

    return { parsed };
  }

  // ---------- Verdict & repair directive ----------

  private getEffectivePassBarOverrides(runState: RunState): Record<string, number> {
    return runState.currentNegotiation?.passBarOverrides ?? {};
  }

  private verdictPath(sprint: number, evaluationRound: number, runDir: string): string {
    return path.join(
      runDir,
      'verdicts',
      `verdict-${String(sprint).padStart(2, '0')}-r${String(evaluationRound).padStart(2, '0')}.json`,
    );
  }

  private repairDirectivePath(sprint: number, evaluationRound: number, runDir: string): string {
    return path.join(
      runDir,
      'repair-directives',
      `repair-s${String(sprint).padStart(2, '0')}-r${String(evaluationRound).padStart(2, '0')}.json`,
    );
  }

  private async writeVerdict(
    runState: RunState,
    evaluationRound: number,
    evalParsed: Record<string, unknown> | null,
    evalCriteria: EvalCriteria | null,
    isSmokeFailure: boolean,
  ): Promise<HarnessVerdict> {
    const overrides = this.getEffectivePassBarOverrides(runState);
    const passed = resolvePass(evalParsed, evalCriteria, overrides);
    const failing = getFailingScores(evalParsed, evalCriteria, overrides);
    const passing = getPassingScores(evalParsed, evalCriteria, overrides);

    let reason: HarnessVerdict['reason'];
    if (isSmokeFailure) {
      reason = 'smoke_failure';
    } else if (passed) {
      reason = 'all_scores_met';
    } else if (!evalParsed || !isPlainObject(evalParsed.scores)) {
      reason = 'missing_scores';
    } else {
      reason = 'score_below_threshold';
    }

    const verdict: HarnessVerdict = {
      version: 1,
      sprint: runState.sprint,
      evaluationRound,
      featureId: runState.currentFeatureId!,
      passed,
      reason,
      failingScores: failing,
      passingScores: passing,
      evaluationJsonPath: runState.currentEvalJsonPath!,
    };

    const verdictFilePath = this.verdictPath(runState.sprint, evaluationRound, runState.runDir);
    await writeJson(verdictFilePath, verdict);
    runState.currentVerdictPath = verdictFilePath;
    await this.saveRunState(runState);
    return verdict;
  }

  private lookupRubricDescription(
    criterion: string,
    scoreLevel: number,
    evalCriteria: EvalCriteria | null,
  ): string {
    if (!evalCriteria) return '';
    const pc = evalCriteria.projectCriteria.find((c) => c.id === criterion);
    if (pc) {
      return pc.rubric[String(scoreLevel)] || '';
    }
    const universal = UNIVERSAL_RUBRICS[criterion];
    if (universal) {
      return universal.anchors[String(scoreLevel)] || '';
    }
    return '';
  }

  private async writeRepairDirective(
    runState: RunState,
    evaluationRound: number,
    verdict: HarnessVerdict,
    evalCriteria: EvalCriteria | null,
    evidenceDir: string | null,
  ): Promise<string> {
    const canonicalEval = await this.readCanonicalEvaluation(runState.currentEvalJsonPath!);

    const failingCriteria: RepairDirectiveCriterion[] = verdict.failingScores.map((f) => ({
      criterion: f.criterion,
      currentScore: f.score,
      effectivePassBar: f.passBar,
      targetLevelDescription: this.lookupRubricDescription(f.criterion, f.passBar, evalCriteria),
      currentLevelDescription: this.lookupRubricDescription(f.criterion, f.score, evalCriteria),
    }));
    failingCriteria.sort((a, b) => (b.effectivePassBar - b.currentScore) - (a.effectivePassBar - a.currentScore));

    const mustFixBugs = canonicalEval.bugs
      .filter((b) => b.severity === 'high' || b.severity === 'critical')
      .map((b) => ({
        severity: b.severity,
        title: b.title,
        rootCause: b.rootCause,
        evidence: b.evidence,
      }));

    const directive: RepairDirective = {
      version: 1,
      sprint: runState.sprint,
      evaluationRound,
      featureId: runState.currentFeatureId!,
      verdictPath: runState.currentVerdictPath!,
      failingCriteria,
      passingCriteria: verdict.passingScores.map((p) => ({
        criterion: p.criterion,
        currentScore: p.score,
        effectivePassBar: p.passBar,
      })),
      mustFixBugs,
      evaluationPath: runState.currentEvalPath!,
      evaluationJsonPath: runState.currentEvalJsonPath!,
      evidenceDir,
      remainingRounds: this.config.maxRepairRounds - evaluationRound,
    };

    const directivePath = this.repairDirectivePath(runState.sprint, evaluationRound, runState.runDir);
    await writeJson(directivePath, directive);
    return directivePath;
  }

  // ---------- Task execution ----------

  private async runTask(
    runState: RunState,
    task: Parameters<typeof this.providerRegistry.runTask>[0],
    logName: string,
  ): Promise<{ parsed: Record<string, unknown> | null; meta: { sessionId?: string } }> {
    const capabilities = task.capabilities || this.capabilities[task.kind];
    const startedAt = nowIso();
    this.recordTaskStart(task.kind, capabilities.provider, runState);
    await this.log(runState, {
      type: 'task.start',
      task: task.kind,
      label: task.label,
      provider: capabilities.provider,
      startedAt,
      sprint: runState.sprint,
      repairRound: runState.repairRound,
      currentFeatureId: runState.currentFeatureId,
    });

    this.output.log(`→ ${task.label} [${capabilities.provider}]`);
    const result = await this.providerRegistry.runTask({
      ...task,
      capabilities,
    });

    const rawPath = path.join(runState.runDir, 'logs', `${logName}.raw.txt`);
    await writeText(rawPath, `${result.rawText || ''}\n`);

    const parsedPath = path.join(runState.runDir, 'logs', `${logName}.parsed.json`);
    if (result.parsed) {
      await writeJson(parsedPath, result.parsed);
    }
    this.recordTaskFinish(task.kind, capabilities.provider, runState);

    await this.assertTaskArtifactsExist(task);

    const parseSucceeded = !!result.parsed;
    if (parseSucceeded) {
      this.recordParseSuccess(task.kind, capabilities.provider, runState);
    } else {
      this.recordParseFailure(task.kind, capabilities.provider, runState);
    }

    await this.log(runState, {
      type: 'task.finish',
      task: task.kind,
      label: task.label,
      provider: capabilities.provider,
      finishedAt: nowIso(),
      rawLog: relativeTo(runState.runDir, rawPath),
      parsedLog: result.parsed ? relativeTo(runState.runDir, parsedPath) : null,
      parsed: result.parsed || null,
      scores: result.parsed?.scores || null,
      meta: result.meta || {},
    });

    if (!result.parsed) {
      const recovered = await this.recoverTaskResultFromArtifacts(runState, task, parsedPath);
      if (recovered) {
        result.parsed = recovered;
        await writeJson(parsedPath, result.parsed);
        this.output.log(`⚠ ${task.label} did not return JSON — recovered from canonical artifacts.`);
      } else if (task.kind === 'generator') {
        // Generators sometimes produce prose-only output (especially during repair rounds).
        // Synthesize a minimal result so the evaluator can judge the actual workspace state.
        result.parsed = {
          status: 'ok',
          summary: truncate(result.rawText || 'Generator completed without JSON output.', 500),
          filesTouched: [],
          commandsRun: [],
          selfCheck: null,
          commit: null,
          risks: ['Generator did not return structured JSON — result synthesized by harness.'],
        };
        await writeJson(parsedPath, result.parsed);
        this.output.log(`⚠ ${task.label} did not return JSON — synthesized result, proceeding to evaluation.`);
      } else {
        throw new Error(
          `${task.label} did not return parseable JSON. See ${relativeTo(runState.runDir, rawPath)} for the raw output.`,
        );
      }
    }

    if (task.label.startsWith('contract-draft')) {
      await this.readCanonicalContract(runState.currentContractJsonPath!);
    }

    if (task.kind === 'evaluator' && !task.label.startsWith('contract-review')) {
      const canonicalEval = await this.readCanonicalEvaluation(runState.currentEvalJsonPath!);
      result.parsed = {
        ...(result.parsed || {}),
        ...canonicalEval,
      };
      this.recordEvaluatorConfidence(canonicalEval.confidence, runState);
      this.recordEvidenceQuality(canonicalEval.evidenceQuality, runState);
      await writeJson(parsedPath, result.parsed);
    }

    this.output.log(`✓ ${task.label} — ${truncate((result.parsed.summary as string) || result.rawText, 120)}`);
    await this.saveRunState(runState);
    return { parsed: result.parsed, meta: result.meta };
  }

  private async persistSyntheticTaskResult(
    runState: RunState,
    logName: string,
    taskKind: string,
    label: string,
    parsed: Record<string, unknown>,
  ): Promise<void> {
    const rawPath = path.join(runState.runDir, 'logs', `${logName}.raw.txt`);
    const parsedPath = path.join(runState.runDir, 'logs', `${logName}.parsed.json`);
    await writeText(rawPath, `${JSON.stringify(parsed, null, 2)}\n`);
    await writeJson(parsedPath, parsed);
    await this.log(runState, {
      type: 'task.synthetic_finish',
      task: taskKind,
      label,
      finishedAt: nowIso(),
      rawLog: relativeTo(runState.runDir, rawPath),
      parsedLog: relativeTo(runState.runDir, parsedPath),
      parsed,
      scores: parsed.scores || null,
      meta: { synthetic: true },
    });
  }

  private async readParsedTaskLog(
    logName: string,
    runState: RunState,
  ): Promise<Record<string, unknown> | null> {
    const parsedPath = path.join(runState.runDir, 'logs', `${logName}.parsed.json`);
    if (await fileExists(parsedPath)) {
      return readJson<Record<string, unknown> | null>(parsedPath, null);
    }

    const rawPath = path.join(runState.runDir, 'logs', `${logName}.raw.txt`);
    if (!(await fileExists(rawPath))) {
      return null;
    }

    return extractJsonObject(await readText(rawPath, ''));
  }

  private async assertTaskArtifactsExist(task: Parameters<typeof this.providerRegistry.runTask>[0]): Promise<void> {
    const missing: string[] = [];
    for (const artifactPath of Object.values(task.artifacts || {})) {
      if (!(await fileExists(artifactPath))) {
        missing.push(artifactPath);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${task.label} did not write expected artifacts:\n${missing.map((artifactPath) => `- ${artifactPath}`).join('\n')}`,
      );
    }
  }

  private async recoverTaskResultFromArtifacts(
    runState: RunState,
    task: Parameters<typeof this.providerRegistry.runTask>[0],
    parsedPath: string,
  ): Promise<Record<string, unknown> | null> {
    if (task.kind === 'evaluator' && runState.currentEvalJsonPath && (await fileExists(runState.currentEvalJsonPath))) {
      return this.readCanonicalEvaluation(runState.currentEvalJsonPath) as unknown as Record<string, unknown>;
    }

    if (
      task.label.startsWith('contract-draft') &&
      runState.currentContractJsonPath &&
      (await fileExists(runState.currentContractJsonPath))
    ) {
      await this.readCanonicalContract(runState.currentContractJsonPath);
      return {
        status: 'ok',
        summary: 'Recovered from canonical contract artifact.',
        filesWritten: [runState.currentContractPath, runState.currentContractJsonPath].filter(Boolean),
      };
    }

    if (task.kind === 'researcher' || task.kind === 'planner') {
      return {
        status: 'ok',
        summary: 'Recovered from written planning artifacts.',
        filesWritten: Object.values(task.artifacts),
        parsedLog: parsedPath,
      };
    }

    return null;
  }

  private async readCanonicalContract(filePath: string): Promise<CanonicalContract> {
    const value = await readJson<CanonicalContract | null>(filePath, null);
    if (
      !value ||
      value.version !== 1 ||
      !value.feature?.id ||
      !Array.isArray(value.doneMeans) ||
      !Array.isArray(value.verificationSteps) ||
      !Array.isArray(value.hardThresholds) ||
      typeof value.sourceMarkdownPath !== 'string'
    ) {
      throw new Error(`Invalid canonical contract JSON: ${filePath}`);
    }
    return value;
  }

  private async readCanonicalEvaluation(filePath: string): Promise<CanonicalEvaluation> {
    const value = await readJson<CanonicalEvaluation | null>(filePath, null);
    if (
      !value ||
      value.version !== 1 ||
      !isConfidenceLevel(value.confidence) ||
      !isEvidenceQuality(value.evidenceQuality) ||
      typeof value.summary !== 'string' ||
      !value.feature?.id ||
      !isPlainRecord(value.scores) ||
      !Array.isArray(value.contractCriteria) ||
      !Array.isArray(value.projectPrinciples) ||
      !Array.isArray(value.bugs) ||
      !Array.isArray(value.suggestedRepairPlan) ||
      !Array.isArray(value.notes) ||
      !value.devSmoke
    ) {
      throw new Error(`Invalid canonical evaluation JSON: ${filePath}`);
    }
    return value;
  }

  private async freezeEvaluatorEvidence(
    runState: RunState,
    evaluationRound: number,
  ): Promise<string | null> {
    const liveEvidenceDir = this.evidenceDir(runState.sprint, evaluationRound, runState.runDir);
    if (!(await fileExists(liveEvidenceDir))) {
      return null;
    }

    const frozenDir = this.frozenEvidenceDir(runState.sprint, evaluationRound, runState.runDir);
    await fs.rm(frozenDir, { recursive: true, force: true });
    await copyTree(liveEvidenceDir, frozenDir);

    const frozenFiles = await listFilesRecursive(frozenDir);
    const manifest = {
      version: 1,
      sourceDir: relativeTo(runState.runDir, liveEvidenceDir),
      frozenDir: relativeTo(runState.runDir, frozenDir),
      files: await Promise.all(
        frozenFiles.map(async (filePath) => ({
          path: relativeTo(frozenDir, filePath),
          sha256: await hashFile(filePath),
        })),
      ),
    };
    await writeJson(this.frozenEvidenceManifestPath(frozenDir), manifest);
    await this.log(runState, {
      type: 'evidence.freeze',
      sourceDir: manifest.sourceDir,
      frozenDir: manifest.frozenDir,
      files: manifest.files.length,
    });
    return frozenDir;
  }

  private async assertFrozenEvidenceIntact(runState: RunState, frozenEvidenceDir: string | null): Promise<void> {
    if (!frozenEvidenceDir) return;

    const manifestPath = this.frozenEvidenceManifestPath(frozenEvidenceDir);
    if (!(await fileExists(manifestPath))) {
      throw new Error(`Missing frozen evidence manifest: ${manifestPath}`);
    }

    const manifest = await readJson<{
      files: Array<{ path: string; sha256: string }>;
    } | null>(manifestPath, null);

    if (!manifest) {
      throw new Error(`Invalid frozen evidence manifest: ${manifestPath}`);
    }

    const changedFiles: string[] = [];
    for (const entry of manifest.files) {
      const absolutePath = path.join(frozenEvidenceDir, entry.path);
      if (!(await fileExists(absolutePath))) {
        changedFiles.push(entry.path);
        continue;
      }
      const sha256 = await hashFile(absolutePath);
      if (sha256 !== entry.sha256) {
        changedFiles.push(entry.path);
      }
    }

    if (changedFiles.length > 0) {
      await this.log(runState, {
        type: 'evidence.tamper',
        frozenDir: relativeTo(runState.runDir, frozenEvidenceDir),
        changedFiles,
      });
      throw new Error(
        `Frozen evaluator evidence was modified and can no longer be trusted:\n${changedFiles.map((entry) => `- ${entry}`).join('\n')}`,
      );
    }
  }

  private async freezeBenchmarkArtifacts(
    runState: RunState,
    label: string,
    artifactPaths: string[],
  ): Promise<void> {
    if (!this.shouldFreezeBenchmarkArtifacts()) {
      return;
    }

    const existingArtifacts = Array.from(new Set(artifactPaths)).filter(Boolean);
    const manifestPath = this.benchmarkManifestPath(runState.runDir);
    const currentManifest = await readJson<{
      version: number;
      roleProviders: RoleProviderMap;
      snapshots: Array<Record<string, unknown>>;
    } | null>(manifestPath, null);

    const snapshot = {
      label,
      frozenAt: nowIso(),
      artifacts: [] as Array<Record<string, unknown>>,
    };

    for (const artifactPath of existingArtifacts) {
      if (!(await fileExists(artifactPath))) continue;

      const relativeArtifactPath = relativeTo(runState.runDir, artifactPath);
      const destinationPath = path.join(runState.runDir, 'benchmarks', 'frozen', label, relativeArtifactPath);
      await fs.rm(destinationPath, { recursive: true, force: true });
      await copyTree(artifactPath, destinationPath);

      const stats = await fs.stat(destinationPath);
      const fileEntries = stats.isDirectory()
        ? await listFilesRecursive(destinationPath)
        : [destinationPath];

      snapshot.artifacts.push({
        sourcePath: relativeArtifactPath,
        frozenPath: relativeTo(runState.runDir, destinationPath),
        kind: stats.isDirectory() ? 'directory' : 'file',
        files: await Promise.all(
          fileEntries.map(async (filePath) => ({
            path: relativeTo(destinationPath, filePath),
            sha256: await hashFile(filePath),
          })),
        ),
      });
    }

    const nextManifest = currentManifest || {
      version: 1,
      roleProviders: { ...this.roleProviders },
      snapshots: [],
    };
    nextManifest.snapshots.push(snapshot);
    await writeJson(manifestPath, nextManifest);
  }

  private async runFinalRegression(runState: RunState): Promise<void> {
    if (!this.config.smoke.start && !this.config.smoke.test) {
      return;
    }

    let devServer: DevServer | null = null;

    try {
      devServer = await this.startDevServer(runState);

      if (devServer?.getUrl()) {
        const devSmoke = await this.runDevServerSmoke(runState, runState.sprint, this.config.maxRepairRounds + 1, devServer.getUrl()!);
        if (!devSmoke.ok) {
          this.recordFinalRegressionFailure(runState);
          runState.status = 'failed';
          runState.summary = 'Backlog completed, but final regression failed the dev-server smoke.';
          await this.saveRunState(runState);
          return;
        }
      }

      if (this.config.smoke.test) {
        const result = await this.runShellCommand(this.config.smoke.test, this.config.workspace);
        const logPath = path.join(runState.runDir, 'logs', 'final-regression-smoke-test.log');
        await writeText(logPath, formatCommandResult(this.config.smoke.test, result));
        await this.log(runState, {
          type: 'run.final_regression',
          ok: result.ok,
          logPath: relativeTo(runState.runDir, logPath),
        });
        if (!result.ok) {
          this.recordFinalRegressionFailure(runState);
          runState.status = 'failed';
          runState.summary = 'Backlog completed, but final regression smoke failed.';
          await this.saveRunState(runState);
          return;
        }
      }

      await this.log(runState, { type: 'run.final_regression', ok: true });
    } catch (error) {
      this.recordFinalRegressionFailure(runState);
      runState.status = 'failed';
      runState.summary = `Backlog completed, but final regression failed: ${String(error instanceof Error ? error.message : error)}`;
      await this.log(runState, {
        type: 'run.final_regression',
        ok: false,
        error: runState.summary,
      });
      await this.saveRunState(runState);
    } finally {
      await this.stopDevServer(runState, devServer);
    }
  }

  // ---------- Command helpers ----------

  private async runShellCommand(command: string, cwd: string): Promise<ShellCommandResult> {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, maxBuffer: 10 * 1024 * 1024 });
      return { ok: true, stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string; code?: number };
      return {
        ok: false,
        stdout: execError.stdout || '',
        stderr: execError.stderr || execError.message || '',
        exitCode: typeof execError.code === 'number' ? execError.code : 1,
      };
    }
  }

  // ---------- Metrics / routing helpers ----------

  private createInitialMetrics(): RunState['metrics'] {
    return {
      completedFeatures: 0,
      blockedFeatures: 0,
      finalRegressionFailures: 0,
      rolePerformance: {},
    };
  }

  private providerSummary(): string {
    const uniqueProviders = Array.from(new Set(Object.values(this.roleProviders)));
    if (uniqueProviders.length === 1) {
      return uniqueProviders[0];
    }
    return (Object.entries(this.roleProviders) as Array<[keyof RoleProviderMap, string]>)
      .map(([role, provider]) => `${role}:${provider}`)
      .join(', ');
  }

  private shouldFreezeBenchmarkArtifacts(): boolean {
    return new Set(Object.values(this.roleProviders)).size > 1;
  }

  private roleMetricKey(role: keyof RoleProviderMap, provider: TaskCapabilities['provider']): string {
    return `${role}@${provider}`;
  }

  private ensureRoleMetric(
    role: keyof RoleProviderMap,
    provider: TaskCapabilities['provider'],
    runState: RunState,
  ): RunState['metrics']['rolePerformance'][string] {
    const key = this.roleMetricKey(role, provider);
    if (!runState.metrics.rolePerformance[key]) {
      runState.metrics.rolePerformance[key] = {
        role,
        provider,
        tasksStarted: 0,
        tasksFinished: 0,
        parseSuccesses: 0,
        parseFailures: 0,
        contractApprovalAttempts: 0,
        contractApprovalPasses: 0,
        repairRoundsToPass: [],
        finalRegressionFailures: 0,
        devSmokePassed: 0,
        devSmokeFailed: 0,
        evaluatorConfidence: { low: 0, medium: 0, high: 0, unknown: 0 },
        evidenceQuality: { weak: 0, adequate: 0, strong: 0, unknown: 0 },
      };
    }
    return runState.metrics.rolePerformance[key];
  }

  private recordTaskStart(role: keyof RoleProviderMap, provider: TaskCapabilities['provider'], runState: RunState): void {
    this.ensureRoleMetric(role, provider, runState).tasksStarted += 1;
  }

  private recordTaskFinish(role: keyof RoleProviderMap, provider: TaskCapabilities['provider'], runState: RunState): void {
    this.ensureRoleMetric(role, provider, runState).tasksFinished += 1;
  }

  private recordParseSuccess(role: keyof RoleProviderMap, provider: TaskCapabilities['provider'], runState: RunState): void {
    this.ensureRoleMetric(role, provider, runState).parseSuccesses += 1;
  }

  private recordParseFailure(role: keyof RoleProviderMap, provider: TaskCapabilities['provider'], runState: RunState): void {
    this.ensureRoleMetric(role, provider, runState).parseFailures += 1;
  }

  private recordContractApprovalAttempt(role: keyof RoleProviderMap, runState: RunState): void {
    const provider = this.providerRegistry.getProviderName(role);
    this.ensureRoleMetric(role, provider, runState).contractApprovalAttempts += 1;
  }

  private recordContractApprovalPass(role: keyof RoleProviderMap, runState: RunState): void {
    const provider = this.providerRegistry.getProviderName(role);
    this.ensureRoleMetric(role, provider, runState).contractApprovalPasses += 1;
  }

  private recordRepairRoundsToPass(role: keyof RoleProviderMap, repairRounds: number, runState: RunState): void {
    const provider = this.providerRegistry.getProviderName(role);
    this.ensureRoleMetric(role, provider, runState).repairRoundsToPass.push(repairRounds);
  }

  private recordDevSmokeResult(ok: boolean, runState: RunState): void {
    const provider = this.providerRegistry.getProviderName('evaluator');
    const metric = this.ensureRoleMetric('evaluator', provider, runState);
    if (ok) {
      metric.devSmokePassed += 1;
    } else {
      metric.devSmokeFailed += 1;
    }
  }

  private recordEvaluatorConfidence(confidence: ConfidenceLevel, runState: RunState): void {
    const provider = this.providerRegistry.getProviderName('evaluator');
    const metric = this.ensureRoleMetric('evaluator', provider, runState);
    metric.evaluatorConfidence[confidence] += 1;
  }

  private recordEvidenceQuality(quality: EvidenceQuality, runState: RunState): void {
    const provider = this.providerRegistry.getProviderName('evaluator');
    const metric = this.ensureRoleMetric('evaluator', provider, runState);
    metric.evidenceQuality[quality] += 1;
  }

  private recordFinalRegressionFailure(runState: RunState): void {
    runState.metrics.finalRegressionFailures += 1;
    const provider = this.providerRegistry.getProviderName('generator');
    this.ensureRoleMetric('generator', provider, runState).finalRegressionFailures += 1;
  }

  // ---------- Persistence ----------

  private async saveRunState(runState: RunState): Promise<void> {
    runState.updatedAt = nowIso();
    await Promise.all([
      writeJson(path.join(runState.runDir, 'run.json'), runState),
      writeJson(path.join(runState.runDir, 'metrics.json'), runState.metrics),
    ]);
  }

  private async log(runState: RunState, entry: Record<string, unknown>): Promise<void> {
    await appendNdjson(path.join(runState.runDir, 'events.ndjson'), { ts: nowIso(), ...entry });
  }

  private runPaths(runState: RunState) {
    return {
      prompt: path.join(runState.runDir, 'prompt.md'),
      researchBrief: path.join(runState.runDir, 'plan', 'research-brief.md'),
      evalCriteria: path.join(runState.runDir, 'plan', 'eval-criteria.json'),
      spec: path.join(runState.runDir, 'plan', 'spec.md'),
      backlog: path.join(runState.runDir, 'plan', 'backlog.json'),
      projectPrinciples: path.join(runState.runDir, 'plan', 'project-principles.md'),
      progress: path.join(runState.runDir, 'progress.md'),
      nextHandoff: path.join(runState.runDir, 'handoff', 'next.md'),
      benchmarkManifest: this.benchmarkManifestPath(runState.runDir),
    };
  }

  private sprintPad(sprintNumber: number): string {
    return String(sprintNumber).padStart(2, '0');
  }

  private roundPad(round: number): string {
    return String(round).padStart(2, '0');
  }

  private contractPath(sprintNumber: number, runDir: string): string {
    return path.join(runDir, 'contracts', `contract-${this.sprintPad(sprintNumber)}.md`);
  }

  private contractJsonPath(sprintNumber: number, runDir: string): string {
    return path.join(runDir, 'contracts', `contract-${this.sprintPad(sprintNumber)}.json`);
  }

  private evalPath(sprintNumber: number, round: number, runDir: string): string {
    return path.join(runDir, 'evals', `eval-${this.sprintPad(sprintNumber)}-r${this.roundPad(round)}.md`);
  }

  private evalJsonPath(sprintNumber: number, round: number, runDir: string): string {
    return path.join(runDir, 'evals', `eval-${this.sprintPad(sprintNumber)}-r${this.roundPad(round)}.json`);
  }

  private evidenceDir(sprintNumber: number, round: number, runDir: string): string {
    return path.join(runDir, 'evals', 'evidence', `s${this.sprintPad(sprintNumber)}-r${this.roundPad(round)}`);
  }

  private frozenEvidenceDir(sprintNumber: number, round: number, runDir: string): string {
    return path.join(runDir, 'evals', 'evidence-frozen', `s${this.sprintPad(sprintNumber)}-r${this.roundPad(round)}`);
  }

  private frozenEvidenceManifestPath(frozenEvidenceDir: string): string {
    return path.join(frozenEvidenceDir, 'manifest.json');
  }

  private benchmarkManifestPath(runDir: string): string {
    return path.join(runDir, 'benchmarks', 'frozen', 'manifest.json');
  }

  private generatorLogName(sprintNumber: number, round: number): string {
    return `generator-s${this.sprintPad(sprintNumber)}-r${this.roundPad(round)}`;
  }

  private evaluatorLogName(sprintNumber: number, round: number): string {
    return `evaluator-s${this.sprintPad(sprintNumber)}-r${this.roundPad(round)}`;
  }
}

function formatCommandResult(command: string, result: ShellCommandResult): string {
  return [
    `$ ${command}`,
    '',
    `exitCode: ${result.exitCode}`,
    '',
    result.stdout ? `stdout:\n${result.stdout}` : 'stdout:\n',
    '',
    result.stderr ? `stderr:\n${result.stderr}` : 'stderr:\n',
    '',
  ].join('\n');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isEvidenceQuality(value: unknown): value is EvidenceQuality {
  return value === 'weak' || value === 'adequate' || value === 'strong';
}
