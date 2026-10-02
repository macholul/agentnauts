import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsageError, parseInvocation } from './args';
import { browserCommand } from './browser';
import { CLOUD } from '@agentnauts/shared';
import { SettingsError, readSettings } from './config';

describe('command line', () => {
  it('starts when nothing is said', () => {
    assert.deepEqual(parseInvocation([]), { command: 'start', hooks: true, open: true, verbose: false });
    assert.deepEqual(parseInvocation(['start', '--no-hooks', '--no-open', '--verbose']), { command: 'start', hooks: false, open: false, verbose: true });
  });

  it('understands every command', () => {
    for (const command of ['connect', 'disconnect', 'status', 'uninstall'] as const) {
      assert.equal(parseInvocation([command]).command, command);
    }
    assert.equal(parseInvocation(['hooks', 'install']).command, 'hooks install');
    assert.equal(parseInvocation(['hooks', 'uninstall']).command, 'hooks uninstall');
    assert.equal(parseInvocation(['hooks', 'status']).command, 'hooks status');
    assert.equal(parseInvocation(['-h']).command, 'help');
    assert.equal(parseInvocation(['connect', '--help']).command, 'help');
    assert.equal(parseInvocation(['--version']).command, 'version');
    assert.equal(parseInvocation(['-v']).command, 'version');
  });

  it('says what it did not understand', () => {
    assert.throws(() => parseInvocation(['launch']), (error: Error) => error instanceof UsageError && /Unknown command "launch"/.test(error.message));
    assert.throws(() => parseInvocation(['hooks']), /hooks install/);
    assert.throws(() => parseInvocation(['--port', '1']), UsageError);
  });
});

describe('settings', () => {
  it('only listens to variables with the product name', () => {
    // Launchers and other projects set these; they are not ours.
    const settings = readSettings({ PORT: '3000', HOST: '0.0.0.0', SUPABASE_URL: 'https://someone-elses.example' });
    assert.equal(settings.port, 4747);
    assert.equal(settings.host, '127.0.0.1');
    assert.notEqual(settings.cloud?.url, 'https://someone-elses.example');

    const custom = readSettings({
      AGENTNAUTS_PORT: '5005',
      AGENTNAUTS_APP_URL: 'https://app.example/',
      AGENTNAUTS_SUPABASE_URL: 'https://own.example',
      AGENTNAUTS_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    });
    assert.equal(custom.port, 5005);
    assert.equal(custom.appUrl, 'https://app.example');
    assert.equal(custom.cloud?.url, 'https://own.example');
    assert.deepEqual(custom.extraOrigins, ['https://a.example', 'https://b.example']);
  });

  it('links to the hosted app, or to the local one when run from source', () => {
    assert.equal(readSettings({}).appUrl, CLOUD.appUrl);
    assert.equal(readSettings({}, true).appUrl, 'http://localhost:5173');
    assert.equal(readSettings({ AGENTNAUTS_APP_URL: 'https://app.example' }, true).appUrl, 'https://app.example');
  });

  it('refuses a port that is not one', () => {
    assert.throws(() => readSettings({ AGENTNAUTS_PORT: 'abc' }), SettingsError);
    assert.throws(() => readSettings({ AGENTNAUTS_PORT: '70000' }), SettingsError);
  });
});

describe('opening the browser', () => {
  const link = 'https://app.example/#connect=KEY&device=My%20Mac';

  it('hands the whole link to the system, "&" included', () => {
    assert.deepEqual(browserCommand(link, 'darwin', {}), ['open', [link]]);
    assert.deepEqual(browserCommand(link, 'win32', {}), ['rundll32', ['url.dll,FileProtocolHandler', link]]);
    assert.deepEqual(browserCommand(link, 'linux', { DISPLAY: ':0' }), ['xdg-open', [link]]);
  });

  it('does not try where nobody would see it', () => {
    assert.equal(browserCommand(link, 'linux', {}), null);
    assert.equal(browserCommand(link, 'darwin', { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }), null);
  });
});
