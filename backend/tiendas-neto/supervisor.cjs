// Persistent, single-worker supervisor for the Tiendas Neto menu daemon.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { decrypt } = require('../dist/common/crypto.util');

const APP_ID = '5764607780881696497';
const ROOT = path.resolve(process.env.DIDI_NETO_DATA_ROOT || '/app/uploads/tiendas-neto');
const CONTROL = path.join(ROOT, 'supervisor-control.json');
const STATUS = path.join(ROOT, 'supervisor-status.json');
const RUNNER = path.join(__dirname, 'run.mjs');
const POLL_MS = 5_000;
const RETRY_MS = 60_000;

const prisma = new PrismaClient();
let child = null;
let childExited = null;
let stopping = false;
let signalSent = false;
let lastExit = null;
let nextStartAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = error => {
  let message = String(error?.message ?? error);
  for (const secret of [process.env.DATABASE_URL, process.env.APP_SECRET_ENCRYPTION_KEY]) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  return message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://[REDACTED]@').slice(0, 300);
};

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(temp, file);
}

async function getSecret() {
  const application = await prisma.application.findFirst({
    where: { appId: APP_ID, deletedAt: null },
    select: { appSecret: true },
  });
  if (!application) throw new Error('Tiendas Neto application was not found');
  const key = process.env.APP_SECRET_ENCRYPTION_KEY;
  if (!key) throw new Error('APP_SECRET_ENCRYPTION_KEY is missing');
  return decrypt(application.appSecret, key);
}

async function launch() {
  const secret = await getSecret();
  child = spawn(process.execPath, [RUNNER], {
    cwd: path.dirname(__dirname),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=256',
      DIDI_APP_ID: APP_ID,
      DIDI_APP_SECRET: secret,
      DIDI_NETO_DATA_ROOT: ROOT,
    },
    // Docker's capped json-file logging rotates these streams; no unbounded files on the volume.
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  signalSent = false;
  const startedAt = new Date().toISOString();
  childExited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      lastExit = { at: new Date().toISOString(), code, signal, startedAt };
      child = null;
      signalSent = false;
      nextStartAt = Date.now() + RETRY_MS;
      resolve(lastExit);
    });
    child.once('error', error => {
      lastExit = { at: new Date().toISOString(), error: safeError(error), startedAt };
      child = null;
      signalSent = false;
      nextStartAt = Date.now() + RETRY_MS;
      resolve(lastExit);
    });
  });
  console.log(`Tiendas Neto runner started pid=${child.pid}`);
}

function requestStop() {
  if (!child || signalSent) return;
  signalSent = true;
  child.kill('SIGTERM');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopping = true; requestStop(); });
}

async function main() {
  await fsp.mkdir(ROOT, { recursive: true, mode: 0o700 });
  for (;;) {
    const control = await readJson(CONTROL);
    const enabled = control?.enabled === true;
    if (stopping || !enabled) requestStop();
    if (!stopping && enabled && !child && Date.now() >= nextStartAt) {
      try { await launch(); }
      catch (error) {
        lastExit = { at: new Date().toISOString(), error: safeError(error) };
        nextStartAt = Date.now() + RETRY_MS;
        console.error(`Tiendas Neto start failed: ${lastExit.error}`);
      }
    }
    await writeJson(STATUS, {
      schemaVersion: 1,
      enabled,
      running: Boolean(child),
      stopping: stopping || (!enabled && signalSent),
      pid: child?.pid ?? null,
      lastExit,
      nextStartAt: !child && enabled ? new Date(nextStartAt).toISOString() : null,
      updatedAt: new Date().toISOString(),
    });
    if (stopping && !child) break;
    await sleep(POLL_MS);
  }
  await prisma.$disconnect();
}

async function authTest(appShopId) {
  if (!/^\d+$/.test(String(appShopId ?? ''))) throw new Error('Provide a numeric app_shop_id');
  const secret = await getSecret();
  const result = await new Promise((resolve, reject) => {
    const testChild = spawn(process.execPath, [RUNNER, '--auth-test'], {
      cwd: path.dirname(__dirname),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        DIDI_APP_ID: APP_ID,
        DIDI_APP_SECRET: secret,
        DIDI_NETO_AUTH_TEST_SHOP_ID: appShopId,
        DIDI_NETO_DATA_ROOT: ROOT,
      },
      stdio: 'inherit',
    });
    testChild.once('error', reject);
    testChild.once('exit', code => resolve(code ?? 1));
  });
  await prisma.$disconnect();
  process.exitCode = result;
}

const entry = process.argv[2] === '--auth-test' ? authTest(process.argv[3]) : main();
entry.catch(async error => {
  console.error(`Tiendas Neto supervisor fatal: ${safeError(error)}`);
  requestStop();
  if (childExited) await Promise.race([childExited, sleep(100_000)]);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
