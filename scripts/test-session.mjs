// Full regression for the changes in this session. Browser tests use a private
// context and mock model responses; they never operate an installed app/profile.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const results = [];
async function run(label, command, args, env = process.env) {
  console.log(`\nTEST ${label}`);
  const child = spawn(command, args, { stdio: 'inherit', env });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  results.push({ label, passed: code === 0 });
}
await run('build', npm, ['run', 'build']);
await run('lint', npm, ['run', 'lint']);
for (const name of ['test:capabilities', 'test:architecture', 'test:design', 'test:layout']) await run(name, npm, ['run', name]);
await run('CLI package and deep links', npm, ['test', '--prefix', 'cli']);
await run('CLI connection selection', process.execPath, ['scripts/test-cli-connection.mjs']);
await run('desktop packaged startup', process.execPath, ['scripts/test-desktop-startup.mjs']);
const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
try {
  await vite.listen();
  const env = { ...process.env, APP_URL: `http://127.0.0.1:${vite.httpServer.address().port}` };
  await run('browser boundaries and tags', npm, ['run', 'test:browser'], env);
  await run('browser smoke and persistence', npm, ['run', 'smoke'], env);
} finally { await vite.close(); }
console.log('\nSESSION REGRESSION RESULTS');
for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.label}`);
process.exitCode = results.every(result => result.passed) ? 0 : 1;
