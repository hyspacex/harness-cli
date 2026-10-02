import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerClient } from '../dist/core/providers/codex-client.js';
import { collectClaudeTaskResult } from '../dist/core/providers/claude-sdk.js';

const turn = { prompt: 'test', cwd: process.cwd(), sandboxMode: 'workspaceWrite', writableRoots: [], networkAccess: false, approvalMode: 'never' };
function client(mode, t) {
  const script = `
    const readline = require('node:readline');
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const mode = ${JSON.stringify(mode)};
    if (mode === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (!m.id) return;
      if (mode === 'initialize-exit') process.exit(0);
      if (m.method === 'thread/unsubscribe') return;
      let result = {};
      if (m.method === 'account/read') result = mode === 'login-exit' ? {requiresOpenaiAuth:true} : {account:{type:'chatgpt'}};
      if (m.method === 'account/login/start') result = {loginId:'login',authUrl:'https://example.invalid'};
      if (m.method === 'thread/start' || m.method === 'thread/resume') result = {thread:{id:'thread'}};
      if (m.method === 'turn/start') result = {turn:{id:'turn'}};
      send({id:m.id,result});
      if (m.method === 'account/login/start') setTimeout(()=>process.exit(3),20);
      if (m.method === 'turn/start') {
        if (mode === 'turn-exit') setTimeout(()=>process.exit(7),20);
        else if (mode === 'complete') {
          send({method:'item/completed',params:{threadId:'unrelated',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'wrong'}}});
          send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'correct'}}});
          send({method:'item/completed',params:{threadId:'thread',turnId:'other',item:{type:'agentMessage',phase:'final_answer',text:'wrong'}}});
          send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
        }
      }
    });`;
  const c = new CodexAppServerClient({command:process.execPath,args:['-e',script]});
  // Keep regressions from leaving fixture subprocesses alive after a test timeout.
  t.after(() => c.child?.kill('SIGKILL'));
  return c;
}
for (const [mode, code] of [['initialize-exit',0],['turn-exit',7],['login-exit',3]]) {
  test(`Codex rejects ${mode} without hanging`, {timeout:3000}, async (t) => {
    const c = client(mode, t);
    try { await assert.rejects(c.runTurn(turn), new RegExp(`exited with code ${code}`)); }
    finally { await c.close(); }
  });
}
test('Codex isolates turn notifications and bounds unresponsive unsubscribe', {timeout:3000}, async (t) => {
  const c = client('complete', t);
  try { assert.equal((await c.runTurn(turn)).text, 'correct'); }
  finally { await c.close(); }
  assert.equal(c.pending.size, 0);
});
test('Codex close interrupts an active turn and permits restarting the client', {timeout:3000}, async (t) => {
  const c = client('waiting', t);
  const running = c.runTurn(turn);
  const rejected = assert.rejects(running, /client closed/);
  while (!c.activeThreadId) await new Promise(resolve=>setTimeout(resolve,10));
  await c.close();
  await rejected;
  await c.start();
  await c.close();
});

test('Codex reports a missing executable and cleans up failed initialization', {timeout:3000}, async () => {
  const c = new CodexAppServerClient({command:'/definitely-missing-harness-codex'});
  try { await assert.rejects(c.start(), /ENOENT/); }
  finally { await c.close(); }
  assert.equal(c.pending.size, 0);
});
test('Codex forces cleanup when a child ignores SIGTERM', {timeout:4000}, async (t) => {
  const c = client('stubborn', t);
  await c.start();
  const child = c.child;
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code,signal})));
  await c.close();
  assert.deepEqual(await closed, {code:null,signal:'SIGKILL'});
});

async function* stream(messages, error) { yield* messages; if (error) throw error; }
const partial = {type:'assistant',message:{model:'claude-opus-5-5',content:[{type:'text',text:'{"summary":"partial","status":"done"}'}]}};
test('Claude rejects partial JSON after a transport failure or truncated stream', async () => {
  await assert.rejects(collectClaudeTaskResult(stream([partial],new Error('connection lost'))), /connection lost/);
  await assert.rejects(collectClaudeTaskResult(stream([partial])), /without a successful result/);
});
test('Claude preserves terminal failure over partial JSON and transport errors', async () => {
  await assert.rejects(collectClaudeTaskResult(stream([partial,{type:'result',subtype:'error_max_turns',errors:['turn limit']}],new Error('closed'))), /turn limit/);
});
test('Claude uses successful structured output and retains provider metadata', async () => {
  const parsed = {summary:'verified',status:'done'};
  const result = await collectClaudeTaskResult(stream([{type:'system',subtype:'init',session_id:'session',claude_code_version:'2.1.287'},partial,{type:'result',subtype:'success',result:'done',structured_output:parsed}]));
  assert.deepEqual(result.parsed,parsed);
  assert.deepEqual(result.meta,{sessionId:'session',structuredOutput:true,claudeCodeVersion:'2.1.287',responseModels:['claude-opus-5-5']});
});
