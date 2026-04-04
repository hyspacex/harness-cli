import path from 'node:path';
import fs from 'node:fs/promises';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Backlog,
  EvalCriteria,
  Feature,
  HarnessConfig,
  NegotiationRound,
  Provider,
  RunState,
} from './types.js';
import { DevServer } from './dev-server.js';
import {
  appendNdjson,
  ensureDir,
  extractJsonObject,
  fileExists,
  getNextPendingFeature,
  newRunId,
  nowIso,
  readJson,
  readText,
  relativeTo,
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

interface SprintProgress {
  passed: boolean;
  nextRound: number;
  latestEvalPath: string | null;
  latestEvalParsed: Record<string, unknown> | null;
  allEvalPaths: string[];
}

export class HarnessRunner {
  private config: HarnessConfig;
  private provider: Provider;
  private output: Output;

  constructor(config: HarnessConfig, provider: Provider, output: Output = console) {
    this.config = config;
    this.provider = provider;
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
      provider: this.config.provider,
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
      currentEvalPath: null,
      summary: null,
      metrics: { completedFeatures: 0, blockedFeatures: 0 },
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
      ensureDir(path.join(runState.runDir, 'handoff')),
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

    if (this.config.provider === 'codex') {
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
          await this.finishRunFromBacklog(runState, backlog);
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
        const allEvalPaths = [...progress.allEvalPaths];

        if (progress.passed) {
          passed = true;
        } else {
          for (let evaluationRound = progress.nextRound; evaluationRound <= this.config.maxRepairRounds; evaluationRound += 1) {
            runState.repairRound = evaluationRound;
            runState.currentEvalPath = this.evalPath(runState.sprint, evaluationRound, runState.runDir);
            await this.saveRunState(runState);

            const genResult = await this.runGenerator(
              runState,
              feature,
              latestEvalPath,
              allEvalPaths,
              evalCriteria,
            );

            if (genResult.meta?.sessionId && !runState.generatorSessionIds[runState.sprint]) {
              runState.generatorSessionIds[runState.sprint] = genResult.meta.sessionId;
              await this.saveRunState(runState);
            }

            let devServer: DevServer | null = null;
            let evalResult: { parsed: Record<string, unknown> | null };
            try {
              devServer = await this.startDevServer(runState);
              const smokeTest = await this.runSmokeTest(runState, runState.sprint, evaluationRound);
              if (smokeTest && !smokeTest.ok) {
                evalResult = await this.writeSyntheticSmokeFailureEval(
                  runState,
                  feature,
                  evaluationRound,
                  smokeTest.logPath,
                );
              } else {
                evalResult = await this.runEvaluator(
                  runState,
                  feature,
                  evaluationRound,
                  evalCriteria,
                  devServer?.getUrl(),
                );
              }
            } finally {
              await this.stopDevServer(runState, devServer);
            }

            latestEvalPath = runState.currentEvalPath;
            latestEvalParsed = evalResult.parsed;
            allEvalPaths.push(runState.currentEvalPath);

            if (resolvePass(evalResult.parsed, evalCriteria)) {
              passed = true;
              break;
            }
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
    runState.currentEvalPath = null;
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

    if (changed) {
      await this.saveRunState(runState);
    }
  }

  private clearActiveSprintState(runState: RunState): void {
    runState.currentFeatureId = null;
    runState.currentContractPath = null;
    runState.currentEvalPath = null;
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
    let latestEvalPath: string | null = null;
    let latestEvalParsed: Record<string, unknown> | null = null;

    for (let round = 0; round <= this.config.maxRepairRounds; round += 1) {
      const evalPath = this.evalPath(runState.sprint, round, runState.runDir);
      if (!(await fileExists(evalPath))) continue;

      allEvalPaths.push(evalPath);
      latestEvalPath = evalPath;
      latestEvalParsed = await this.readParsedTaskLog(this.evaluatorLogName(runState.sprint, round), runState);
    }

    return {
      passed: resolvePass(latestEvalParsed, evalCriteria),
      nextRound: allEvalPaths.length,
      latestEvalPath,
      latestEvalParsed,
      allEvalPaths,
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
      const context = createPromptContext(this.config, runState);
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
      const context = createPromptContext(this.config, runState, evalCriteria);
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
    }

    const backlogRaw = await readJson<Backlog | null>(paths.backlog, null);
    const backlog = validateBacklog(backlogRaw);
    await writeJson(paths.backlog, backlog);
    return backlog;
  }

  // ---------- Contract negotiation ----------

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

        const context = createPromptContext(this.config, runState, evalCriteria);
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
            artifacts: { contract: runState.currentContractPath! },
          },
          `contract-draft-s${sprintPad}-n${roundPad}`,
        );

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

        const reviewContext = createPromptContext(this.config, runState, evalCriteria);
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
        roundState.approved = reviewResult.parsed?.status === 'approved';
        await this.saveRunState(runState);

        if (roundState.approved) {
          negotiation.finalContractPath = runState.currentContractPath!;
          negotiation.status = 'approved';
          await this.saveRunState(runState);
          this.output.log(`✓ Contract approved after ${round + 1} negotiation round(s)`);
          return;
        }
      }
    }

    negotiation.status = 'exhausted';
    negotiation.finalContractPath = runState.currentContractPath!;
    await this.saveRunState(runState);
    this.output.log(`⚠ Contract negotiation exhausted after ${maxRounds} round(s) — using last draft`);
  }

  // ---------- Generator / evaluator ----------

  private async runGenerator(
    runState: RunState,
    feature: Feature,
    previousEvalPath: string | null,
    allPriorEvalPaths: string[] = [],
    evalCriteria: EvalCriteria | null = null,
  ): Promise<{ parsed: Record<string, unknown> | null; meta: { sessionId?: string } }> {
    const context = createPromptContext(this.config, runState, evalCriteria);
    const prompt = buildGeneratorPrompt(
      context,
      feature,
      runState.sprint,
      runState.repairRound,
      previousEvalPath,
      allPriorEvalPaths,
    );

    const resumeSessionId = runState.repairRound > 0
      ? runState.generatorSessionIds[runState.sprint]
      : undefined;

    return this.runTask(
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
  }

  private async runEvaluator(
    runState: RunState,
    feature: Feature,
    evaluationRound: number,
    evalCriteria: EvalCriteria | null,
    devServerUrl?: string | null,
  ): Promise<{ parsed: Record<string, unknown> | null }> {
    const context = createPromptContext(this.config, runState, evalCriteria);
    const prompt = buildEvaluatorPrompt(context, feature, runState.sprint, evaluationRound, devServerUrl);
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
        artifacts: { eval: runState.currentEvalPath! },
      },
      this.evaluatorLogName(runState.sprint, evaluationRound),
    );
  }

  private async writeSyntheticSmokeFailureEval(
    runState: RunState,
    feature: Feature,
    evaluationRound: number,
    smokeLogPath: string,
  ): Promise<{ parsed: Record<string, unknown> | null }> {
    const relativeLogPath = relativeTo(runState.runDir, smokeLogPath);
    const report = [
      `# Sprint ${runState.sprint} Evaluation Round ${evaluationRound}`,
      '',
      '## Verdict',
      'fail',
      '',
      '## Scorecard',
      '- Smoke test failed before evaluator execution.',
      '',
      '## Contract Criteria Check',
      '- Not fully evaluated because smoke test failed.',
      '',
      '## Project Principles Check',
      '- Not fully evaluated because smoke test failed.',
      '',
      '## Bugs',
      `- severity: high`,
      `- title: smoke test failed`,
      `- repro: run ${this.config.smoke.test}`,
      `- expected: smoke test exits 0`,
      `- actual: smoke test failed; see ${relativeLogPath}`,
      '',
      '## Suggested Repair Plan',
      '- Fix the failing smoke test before the next evaluation round.',
      '',
      '## Notes',
      `- Feature: ${feature.id} ${feature.title}`,
      `- Evidence: ${relativeLogPath}`,
      '',
    ].join('\n');
    await writeText(runState.currentEvalPath!, report);

    const parsed = {
      status: 'fail',
      summary: 'Smoke test failed before evaluator execution.',
      bugs: [
        {
          severity: 'high',
          title: 'smoke test failed',
          evidence: [relativeLogPath],
        },
      ],
      filesWritten: [runState.currentEvalPath!, smokeLogPath],
    };

    await this.persistSyntheticTaskResult(
      runState,
      this.evaluatorLogName(runState.sprint, evaluationRound),
      'evaluator',
      `evaluator-s${runState.sprint}-r${evaluationRound}`,
      parsed,
    );

    return { parsed };
  }

  // ---------- Task execution ----------

  private async runTask(
    runState: RunState,
    task: Parameters<typeof this.provider.runTask>[0],
    logName: string,
  ): Promise<{ parsed: Record<string, unknown> | null; meta: { sessionId?: string } }> {
    const startedAt = nowIso();
    await this.log(runState, {
      type: 'task.start',
      task: task.kind,
      label: task.label,
      startedAt,
      sprint: runState.sprint,
      repairRound: runState.repairRound,
      currentFeatureId: runState.currentFeatureId,
    });

    this.output.log(`→ ${task.label}`);
    const result = await this.provider.runTask(task);

    const rawPath = path.join(runState.runDir, 'logs', `${logName}.raw.txt`);
    await writeText(rawPath, `${result.rawText || ''}\n`);

    const parsedPath = path.join(runState.runDir, 'logs', `${logName}.parsed.json`);
    if (result.parsed) {
      await writeJson(parsedPath, result.parsed);
    }

    await this.log(runState, {
      type: 'task.finish',
      task: task.kind,
      label: task.label,
      finishedAt: nowIso(),
      rawLog: relativeTo(runState.runDir, rawPath),
      parsedLog: result.parsed ? relativeTo(runState.runDir, parsedPath) : null,
      parsed: result.parsed || null,
      scores: result.parsed?.scores || null,
      meta: result.meta || {},
    });

    if (!result.parsed) {
      if (task.kind === 'generator') {
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

    this.output.log(`✓ ${task.label} — ${truncate((result.parsed.summary as string) || result.rawText, 120)}`);
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

  // ---------- Persistence ----------

  private async saveRunState(runState: RunState): Promise<void> {
    runState.updatedAt = nowIso();
    await writeJson(path.join(runState.runDir, 'run.json'), runState);
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

  private evalPath(sprintNumber: number, round: number, runDir: string): string {
    return path.join(runDir, 'evals', `eval-${this.sprintPad(sprintNumber)}-r${this.roundPad(round)}.md`);
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
