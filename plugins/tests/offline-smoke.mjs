import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pluginsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function loadEntry(plugin, file) {
  const source = await readFile(path.join(pluginsDir, plugin, file), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const otaCalls = [];
const ota = await loadEntry('v881-ab-ota', 'main.js');
const otaResult = await ota.upgrade({ inputs: { slot_image: '/tmp/test.img', target_partition: 'boot', auto_reboot: false } }, {
  progress() {}, log() {},
  async call(name, args) {
    otaCalls.push([name, args]);
    if (name === 'adb.partition.inspect') return { current_slot: '_a', target_slot: '_b' };
    if (name === 'adb.partition.write') return { verified: true, reboot_requested: false };
    throw new Error(`unexpected RPC ${name}`);
  }
});
assert.deepEqual(otaResult, { result: { verified: true, reboot_requested: false } });
const otaManifest = JSON.parse(await readFile(path.join(pluginsDir, 'v881-ab-ota', 'manifest.json'), 'utf8'));
assert.deepEqual(otaManifest.actions[0].output.map(field => field.id), ['result']);
assert.deepEqual(otaCalls.map(([name]) => name), ['adb.partition.inspect', 'adb.partition.write']);
assert.equal(otaCalls[1][1].expected_slot, '_b');
assert.equal(otaCalls[1][1].reboot, false);

const deployCalls = [];
const app = await loadEntry('v881-app-push', 'main.js');
const deployResult = await app.deploy({ inputs: { local_file: '/tmp/app', remote_dir: '/usr/bin', remote_name: 'app', need_root: true } }, {
  progress() {}, log() {},
  async call(name, args) {
    deployCalls.push([name, args]);
    return { executable: '/usr/bin/app', destination: '/usr/bin/app', reboot_requested: false };
  }
});
assert.deepEqual(deployResult, { result: { executable: '/usr/bin/app', destination: '/usr/bin/app', reboot_requested: false } });
const appManifest = JSON.parse(await readFile(path.join(pluginsDir, 'v881-app-push', 'manifest.json'), 'utf8'));
assert.deepEqual(appManifest.actions[0].output.map(field => field.id), ['result']);
assert.equal(deployCalls[0][0], 'adb.deploy');
assert.equal(deployCalls[0][1].remote_name, 'app');

const diagnostic = await loadEntry('v881-log-diagnostic', 'main.js');
const diagnosticManifest = JSON.parse(await readFile(path.join(pluginsDir, 'v881-log-diagnostic', 'manifest.json'), 'utf8'));
assert.deepEqual(diagnosticManifest.actions[0].output.map(field => field.id), ['line_count', 'findings', 'matched_text']);
const report = await diagnostic.analyze({ inputs: { max_matches: 5 }, context: { incident: { log_tail: 'boot\nKernel panic: sample\nEXT4-fs error', matched_text: 'Kernel panic' } } }, {
  progress() {}, log() {}
});
assert.equal(report.line_count, 3);
assert.deepEqual(report.findings.map(item => item.category), ['panic', '存储错误']);
assert.equal(report.matched_text, 'Kernel panic');
await assert.rejects(
  () => diagnostic.analyze({ inputs: {}, context: {} }, { progress() {}, log() {} }),
  /请粘贴日志文本/
);

const provider = await loadEntry('log-session-provider', 'main.js');
const emitted = [];
let recentArgs;
const providerHost = {
  log(line) { emitted.push(line); },
  async call(name, args) {
    if (name === 'logs.recent') { recentArgs = args; return ['line one', 'line two']; }
    if (name === 'logs.sessions') return [{ id: 'source-1' }];
    throw new Error(`unexpected RPC ${name}`);
  }
};
const connected = await provider.connect({ inputs: { source_session_id: 'source-1' }, context: { provider: { session_id: 'provider-1' } } }, providerHost);
assert.deepEqual(recentArgs, { session_id: 'source-1', lines: 20 });
assert.equal(connected.emitted, 2);
assert.deepEqual(emitted.slice(0, 2), ['line one', 'line two']);
const sampleArgs = { inputs: { sample_text: 'PANIC no-hardware trigger sample' }, context: { provider: { session_id: 'provider-1' } } };
const sampleFirst = await provider.connect(sampleArgs, providerHost);
const firstSampleIndex = emitted.indexOf('PANIC no-hardware trigger sample');
const sampleSecond = await provider.connect(sampleArgs, providerHost);
assert.equal(sampleFirst.emitted, 1);
assert.equal(sampleSecond.emitted, 1);
assert.ok(firstSampleIndex >= 0);
assert.equal(emitted.lastIndexOf('PANIC no-hardware trigger sample') > firstSampleIndex, true);
const status = await provider.status({ context: { provider: { session_id: 'provider-1' } } }, providerHost);
assert.equal(status.status.available_sessions, 1);
assert.equal(status.status.provider_session_id, 'provider-1');

const request = {
  type: 'start', inputs: { max_matches: 4 }, settings: {},
  context: { incident: { log_tail: ['boot', 'watchdog bite'], matched_text: 'watchdog bite' } }
};
const processRun = spawnSync('python3', [path.join(pluginsDir, 'v881-log-diagnostic', 'diagnose.py')], {
  input: `${JSON.stringify(request)}\n`, encoding: 'utf8'
});
assert.equal(processRun.status, 0, processRun.stderr);
const messages = processRun.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
assert.deepEqual(messages.map(message => message.type), ['progress', 'log', 'result']);
assert.equal(messages.at(-1).value.findings[0].category, 'watchdog');
assert.equal(messages.at(-1).value.matched_text, 'watchdog bite');

console.log('Offline plugin smoke checks passed (mock host RPCs; no desktop app or hardware).');
