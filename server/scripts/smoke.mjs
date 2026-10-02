/**
 * Tries the package the way someone installing it would: packs it, installs
 * the tarball into an empty project, and runs the commands with a throwaway
 * home folder and a stand-in for the agentnauts service.
 *
 *   npm run smoke -w server
 */
import assert from 'node:assert/strict';
import { exec, execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'agentnauts-smoke-'));
const home = join(work, 'home');
const project = join(work, 'project');
mkdirSync(home);
mkdirSync(project);
const windows = process.platform === 'win32';
const step = (text) => console.log(`ok  ${text}`);

/** npm is a script on Windows, so it goes through the shell everywhere; quote what needs it. */
const quoted = (args) => args.map((arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : `"${arg}"`)).join(' ');
const npm = (args, cwd) => execSync(`npm ${quoted(args)}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

// A stand-in service: this computer is connected to nothing.
const calls = [];
const service = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const { action = 'login' } = JSON.parse(body || '{}');
    calls.push(`${req.url} ${action}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(action === 'disconnect' ? { disconnected: 0 } : { connections: [] }));
  });
});
await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));

/** A free port for the daemon. */
const port = await new Promise((resolve) => {
  const probe = http.createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: '',
  AGENTNAUTS_PORT: String(port),
  AGENTNAUTS_SUPABASE_URL: `http://127.0.0.1:${service.address().port}`,
  AGENTNAUTS_APP_URL: 'https://app.example',
};
const settingsFile = join(home, '.claude', 'settings.json');
const identityFile = join(home, '.agentnauts', 'identity.json');
/**
 * Run the installed command through its bin entry, like `npx agentnauts`.
 * Not the Sync variant: the stand-in service above has to keep answering.
 */
const run = async (...args) => (await promisify(exec)(`npm exec --no -- agentnauts ${quoted(args)}`, { cwd: project, env, encoding: 'utf8' })).stdout;

/** What Claude Code does with a hook: the command through a shell, the hook's JSON on stdin. */
const hookShell = windows ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((path) => existsSync(path)) : 'sh';
const runHook = (event, input) => {
  const command = JSON.parse(readFileSync(settingsFile, 'utf8')).hooks[event].at(-1).hooks[0].command;
  return execFileSync(hookShell, ['-c', command], { input: JSON.stringify(input), encoding: 'utf8' });
};
const files = (dir, prefix = '') =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (entry.name === 'node_modules' ? [] : files(join(dir, entry.name), `${prefix}${entry.name}/`)) : [`${prefix}${entry.name}`],
  );

let daemon;
try {
  // --- the package itself ---
  npm(['pack', '--pack-destination', work], packageDir);
  const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
  assert.equal(tarball, `agentnauts-${pkg.version}.tgz`);
  assert.ok(!existsSync(join(packageDir, 'LICENSE')), 'the copied LICENSE is cleaned up');

  writeFileSync(join(project, 'package.json'), '{ "private": true }\n');
  npm(['install', '--no-audit', '--no-fund', join(work, tarball)], project);
  const installed = join(project, 'node_modules', 'agentnauts');
  assert.deepEqual(files(installed).sort(), ['LICENSE', 'README.md', 'dist/cli.js', 'package.json']);
  // Everything else is bundled in: the one dependency is the WebSocket library.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).dependencies), ['ws']);
  step(`packed ${tarball}: ${files(installed).length} files, one dependency`);

  assert.equal((await run('--version')).trim(), pkg.version);
  assert.match(await run('--help'), /agentnauts hooks install/);
  step('installs and runs from its bin entry');

  // --- hooks: added next to someone's own settings, removed without a trace ---
  const theirs = JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 2) + '\n';
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, theirs);
  assert.match(await run('hooks', 'status'), /not installed/);
  assert.match(await run('hooks', 'install'), /added to/);
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.equal(Object.keys(settings.hooks).length, 10);
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes(`http://127.0.0.1:${port}/event`));
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo done');
  assert.match(await run('hooks', 'status'), /installed in/);
  assert.match(await run('hooks', 'uninstall'), /removed from/);
  assert.equal(readFileSync(settingsFile, 'utf8'), theirs);
  step('hooks install and uninstall leave the settings file as it was');

  // --- start: sets up the hooks, makes a key, serves the hooks' requests ---
  assert.match(await run('status'), /not running/);
  assert.ok(!existsSync(identityFile), 'status does not create a key');
  let output = '';
  daemon = spawn(process.execPath, [join(installed, 'dist', 'cli.js'), '--verbose'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', (chunk) => (output += chunk));
  daemon.stderr.on('data', (chunk) => (output += chunk));
  const said = async (pattern) => {
    for (let i = 0; i < 100 && !pattern.test(output); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(output, pattern);
  };
  await said(/Sign in, check that the page shows the ID [0-9a-f]{4}-[0-9a-f]{4}/);
  assert.match(output, /Claude Code hooks: added to/);
  // Not started from a terminal, so it prints the link instead of opening a browser.
  assert.match(output, /Open this link in a browser:\s+https:\/\/app\.example\/#connect=[\w-]{43}&device=/);
  assert.ok(existsSync(identityFile));
  step('start installs the hooks and asks to connect this computer');

  const hook = { session_id: 'smoke', cwd: project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } };
  if (hookShell) {
    // The command from the settings file, run the way Claude Code runs it.
    assert.equal(runHook('PreToolUse', hook), '');
    await said(/\[hooks\] smoke tool_start Bash/);
    step(`the hook command delivers an event (${windows ? 'Git Bash' : 'sh'})`);
  } else {
    console.log('--  no Git Bash here: the hook command itself was not run');
  }
  const posted = await fetch(`http://127.0.0.1:${port}/event`, { method: 'POST', body: JSON.stringify({ ...hook, session_id: 'smoke-2' }) });
  assert.equal(posted.status, 204);
  await said(/\[hooks\] smoke-2 tool_start Bash/);
  const status = await run('status');
  assert.match(status, new RegExp(`running on port ${port}`));
  assert.match(status, /not connected/);
  assert.match(status, /hooks\s+installed in/);
  assert.match(await run(), /already running/);
  step('the daemon takes events and answers status');

  // --- uninstall: refuses while running, then leaves nothing behind ---
  await assert.rejects(run('uninstall'), /Stop it first/);
  daemon.kill();
  await new Promise((resolve) => daemon.once('exit', resolve));
  daemon = null;
  if (hookShell) {
    // With the daemon stopped the hook still succeeds, quietly and quickly.
    const before = Date.now();
    assert.equal(runHook('Stop', {}), '');
    assert.ok(Date.now() - before < 2500, 'a stopped daemon must not slow Claude Code down');
    step(`the hook command stays quiet when the daemon is stopped (${Date.now() - before} ms)`);
  }
  assert.match(await run('uninstall'), /key: removed/);
  assert.equal(readFileSync(settingsFile, 'utf8'), theirs);
  assert.ok(!existsSync(join(home, '.agentnauts')));
  assert.ok(calls.some((call) => call.endsWith('disconnect')));
  step('uninstall disconnects, removes the hooks and the key');
  console.log('\nsmoke test passed');
} finally {
  daemon?.kill();
  service.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
