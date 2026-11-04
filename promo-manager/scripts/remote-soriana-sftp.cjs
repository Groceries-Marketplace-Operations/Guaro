const { posix } = require('node:path');
const { createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const SftpClient = require('ssh2-sftp-client');
const { decrypt } = require('./dist/common/crypto.util');

const command = process.argv[2];
const encodedName = process.argv[3] || '';
const prisma = new PrismaClient();
const allowedName = /^promocionesdidi_(.+?)_(\d{14})(?:_[^.]+)?\.(csv|txt|tsv|xlsx|xls)$/i;
const maximumBytes = 12 * 1024 * 1024;

function normalizeRoot(value) {
  const root = posix.normalize(value?.trim() || '/upload');
  if (!root.startsWith('/')) throw new Error('Invalid SFTP root');
  return root;
}

function decodeFileName(value) {
  const name = Buffer.from(value, 'base64url').toString('utf8');
  if (!allowedName.test(name) || name !== posix.basename(name) || name.includes('\\') || name.includes('\0')) {
    throw new Error('Invalid promotion file name');
  }
  return name;
}

function genericFileName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 255 || name !== posix.basename(name) || name.includes('\\') || name.includes('\0')
    || !/\.(csv|txt|tsv|xlsx|xls)$/i.test(name)) throw new Error('Invalid promotion file name');
  return name;
}

function decodeAccountRequest(value, withFile = false) {
  const request = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  const accountId = typeof request?.accountId === 'string' ? request.accountId.trim() : '';
  if (!accountId || accountId.length > 160) throw new Error('Invalid promotion SFTP account');
  return { accountId, ...(withFile ? { fileName: genericFileName(request.fileName) } : {}) };
}

function decodeAccountBatchRequest(value) {
  const request = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  const accountId = typeof request?.accountId === 'string' ? request.accountId.trim() : '';
  if (!accountId || accountId.length > 160 || !Array.isArray(request.fileNames)
    || request.fileNames.length < 1 || request.fileNames.length > 20) {
    throw new Error('Invalid promotion SFTP batch request');
  }
  const fileNames = [...new Set(request.fileNames.map(genericFileName))];
  if (fileNames.length !== request.fileNames.length) throw new Error('Repeated promotion file name');
  return { accountId, fileNames };
}

function embeddedReplaceRequest() {
  const request = globalThis.__PROMO_MANAGER_EMBEDDED;
  const accountId = typeof request?.accountId === 'string' ? request.accountId.trim() : '';
  const fileName = genericFileName(request?.fileName);
  const expectedSha256 = typeof request?.expectedSha256 === 'string' ? request.expectedSha256.trim().toLowerCase() : '';
  const operationId = typeof request?.operationId === 'string' ? request.operationId.trim() : '';
  const contentBase64 = typeof request?.contentBase64 === 'string' ? request.contentBase64 : '';
  if (!accountId || accountId.length > 160 || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || !/^[A-Za-z0-9-]{8,80}$/.test(operationId) || !contentBase64) {
    throw new Error('Invalid promotion SFTP replace request');
  }
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length || buffer.length > maximumBytes) throw new Error('Edited promotion file size is invalid');
  return { accountId, fileName, expectedSha256, operationId, buffer };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function decodeAuthSelections(value) {
  const selections = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 2000) {
    throw new Error('Invalid store authentication selection');
  }
  return selections.map((selection) => {
    const accountId = typeof selection?.accountId === 'string' ? selection.accountId.trim() : '';
    const appShopId = typeof selection?.appShopId === 'string' ? selection.appShopId.trim() : '';
    if (!accountId || accountId.length > 160 || !/^[A-Za-z0-9]{1,64}$/.test(appShopId)) {
      throw new Error('Invalid store authentication selection');
    }
    return { accountId, appShopId };
  });
}

function globMatcher(pattern) {
  const value = String(pattern || '').trim();
  if (!value || value.length > 255) throw new Error('Invalid promotion file pattern');
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

(async () => {
  if (command === 'stores') {
    const brand = await prisma.brand.findFirst({
      where: { brandName: { contains: 'Soriana', mode: 'insensitive' }, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: {
        brandName: true,
        shops: {
          where: { deletedAt: null },
          orderBy: [{ city: 'asc' }, { name: 'asc' }, { appShopId: 'asc' }],
          select: { shopId: true, appShopId: true, name: true, city: true },
        },
      },
    });
    if (!brand?.shops.length) throw new Error('Soriana stores are not available');
    process.stdout.write(JSON.stringify({ brandName: brand.brandName, stores: brand.shops }));
    return;
  }
  if (command === 'auth-tokens') {
    const appShopIds = JSON.parse(Buffer.from(encodedName, 'base64url').toString('utf8'));
    if (!Array.isArray(appShopIds) || appShopIds.length < 1 || appShopIds.length > 2000
      || appShopIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(value))) {
      throw new Error('Invalid App Shop ID selection');
    }
    const brand = await prisma.brand.findFirst({
      where: { brandName: { contains: 'Soriana', mode: 'insensitive' }, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { application: true },
    });
    if (!brand?.application || brand.application.deletedAt) throw new Error('Soriana application is not available');
    const appSecret = decrypt(brand.application.appSecret, process.env.APP_SECRET_ENCRYPTION_KEY);
    const { getAuthToken } = require('./dist/queue/handlers/didi-food.util');
    const tokens = {};
    let cursor = 0;
    const workers = Array.from({ length: Math.min(5, appShopIds.length) }, async () => {
      while (cursor < appShopIds.length) {
        const index = cursor++;
        const appShopId = appShopIds[index];
        tokens[appShopId] = await getAuthToken(brand.application.appId, appSecret, appShopId);
      }
    });
    await Promise.all(workers);
    process.stdout.write(JSON.stringify({ tokens }));
    return;
  }
  if (command === 'auth-tokens-accounts') {
    const selections = decodeAuthSelections(encodedName);
    const accountIds = [...new Set(selections.map(selection => selection.accountId))];
    const applications = await prisma.sftpApplication.findMany({
      where: {
        active: true,
        deletedAt: null,
        OR: accountIds.map(name => ({ name: { equals: name, mode: 'insensitive' } })),
      },
      select: {
        name: true,
        brand: {
          select: {
            deletedAt: true,
            application: true,
          },
        },
      },
    });
    const applicationByAccount = new Map(applications.map(application => [application.name.toLocaleLowerCase('en'), application]));
    const resolved = selections.map(selection => {
      const application = applicationByAccount.get(selection.accountId.toLocaleLowerCase('en'));
      if (!application?.brand || application.brand.deletedAt || !application.brand.application || application.brand.application.deletedAt) {
        throw new Error(`Brand application is not available for ${selection.accountId}`);
      }
      return { selection, application: application.brand.application };
    });
    const { getAuthToken } = require('./dist/queue/handlers/didi-food.util');
    const secretByApplication = new Map();
    const tokens = new Array(resolved.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(5, resolved.length) }, async () => {
      while (cursor < resolved.length) {
        const index = cursor++;
        const { selection, application } = resolved[index];
        let appSecret = secretByApplication.get(application.id);
        if (!appSecret) {
          appSecret = decrypt(application.appSecret, process.env.APP_SECRET_ENCRYPTION_KEY);
          secretByApplication.set(application.id, appSecret);
        }
        tokens[index] = {
          accountId: selection.accountId,
          appShopId: selection.appShopId,
          token: await getAuthToken(application.appId, appSecret, selection.appShopId),
        };
      }
    });
    await Promise.all(workers);
    process.stdout.write(JSON.stringify({ tokens }));
    return;
  }
  if (command === 'bound-stores-account') {
    const { accountId } = decodeAccountRequest(encodedName);
    const sftpApplication = await prisma.sftpApplication.findFirst({
      where: {
        name: { equals: accountId, mode: 'insensitive' },
        active: true,
        deletedAt: null,
      },
      select: {
        name: true,
        brand: {
          select: {
            id: true,
            brandId: true,
            brandName: true,
            deletedAt: true,
            application: true,
          },
        },
      },
    });
    const brand = sftpApplication?.brand;
    const application = brand?.application;
    if (!brand || brand.deletedAt || !application || application.deletedAt) {
      throw new Error(`Brand application is not available for ${accountId}`);
    }
    const appSecret = decrypt(application.appSecret, process.env.APP_SECRET_ENCRYPTION_KEY);
    const { fetchShopIdMap } = require('./dist/queue/handlers/didi-food.util');
    const bindings = await fetchShopIdMap(application.appId, appSecret, undefined, {
      signal: AbortSignal.timeout(360_000),
      maxPages: 1_000,
      maxRateLimitRetries: 3,
      cooldownMs: 20_000,
    });
    const localShops = await prisma.shop.findMany({
      where: { brandId: brand.id, deletedAt: null, shopId: { in: [...bindings.keys()] } },
      select: { shopId: true, appShopId: true, name: true, city: true },
    });
    const localByShopId = new Map(localShops.map(shop => [String(shop.shopId), shop]));
    const stores = [...bindings].map(([shopId, appShopId]) => {
      const local = localByShopId.get(String(shopId));
      return {
        shopId: String(shopId),
        appShopId: String(appShopId),
        name: String(local?.name ?? '').trim(),
        city: String(local?.city ?? '').trim(),
      };
    }).sort((left, right) => left.appShopId.localeCompare(right.appShopId, 'en', { numeric: true }));
    process.stdout.write(JSON.stringify({
      accountId: sftpApplication.name,
      brandId: brand.brandId,
      brandName: brand.brandName,
      stores,
    }));
    return;
  }
  const accountRequest = command === 'list-account'
    ? decodeAccountRequest(encodedName)
    : command === 'download-account'
      ? decodeAccountRequest(encodedName, true)
      : command === 'download-account-batch'
        ? decodeAccountBatchRequest(encodedName)
        : command === 'replace-account' ? embeddedReplaceRequest() : null;
  const promotionRule = accountRequest
    ? await prisma.fileIntegrationRule.findFirst({
        where: {
          kind: 'complex_promotion_reader', active: true, deletedAt: null,
          sftpApplication: {
            name: { equals: accountRequest.accountId, mode: 'insensitive' },
            active: true, deletedAt: null,
          },
        },
        orderBy: { updatedAt: 'desc' },
        include: { sftpApplication: true },
      })
    : await prisma.fileIntegrationRule.findFirst({
        where: {
          kind: 'complex_promotion_reader', active: true, deletedAt: null,
          name: { contains: 'Soriana', mode: 'insensitive' },
          sftpApplication: { active: true, deletedAt: null },
        },
        orderBy: { updatedAt: 'desc' },
        include: { sftpApplication: true },
      });
  if (accountRequest && !promotionRule?.sftpApplication) throw new Error('Promotion SFTP account is not available');
  const application = promotionRule?.sftpApplication ?? await prisma.sftpApplication.findFirst({
    where: { name: { equals: 'Soriana', mode: 'insensitive' }, active: true, deletedAt: null },
  });
  if (!application) throw new Error('Active Soriana SFTP application not found');
  if (command === 'configuration') {
    const rules = await prisma.fileIntegrationRule.findMany({
      where: { kind: 'complex_promotion_reader', deletedAt: null },
      select: {
        name: true,
        active: true,
        filePattern: true,
        sftpApplication: {
          select: {
            name: true,
            rootPath: true,
            brand: {
              select: {
                brandId: true,
                brandName: true,
                shops: {
                  where: { deletedAt: null },
                  orderBy: [{ city: 'asc' }, { name: 'asc' }, { appShopId: 'asc' }],
                  select: { shopId: true, appShopId: true, name: true, city: true },
                },
              },
            },
          },
        },
      },
    });
    process.stdout.write(JSON.stringify({ application: { name: application.name, rootPath: application.rootPath }, rules }));
    return;
  }
  const client = new SftpClient('promo-manager-remote');
  try {
    await client.connect({
      host: application.host,
      port: application.port,
      username: application.username,
      password: decrypt(application.password, process.env.APP_SECRET_ENCRYPTION_KEY),
      readyTimeout: 30_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      retries: 2,
      retry_minTimeout: 1500,
    });
    const root = normalizeRoot(application.rootPath);
    if (command === 'inventory') {
      const entries = await client.list(root);
      process.stdout.write(JSON.stringify({
        root,
        count: entries.length,
        entries: entries.slice(0, 30).map(entry => ({ name: entry.name, type: entry.type, size: Number(entry.size || 0) })),
        promotionEntries: entries.filter(entry => /promo/i.test(entry.name)).slice(0, 30).map(entry => ({ name: entry.name, type: entry.type, size: Number(entry.size || 0) })),
      }));
      return;
    }
    if (command === 'list' || command === 'list-account') {
      const matcher = accountRequest ? globMatcher(promotionRule.filePattern) : allowedName;
      const files = (await client.list(root)).filter(entry => matcher.test(entry.name) && (!entry.type || entry.type === '-'));
      process.stdout.write(JSON.stringify(files.map(entry => ({
        name: entry.name,
        size: Number(entry.size || 0),
        modifyTime: Number(entry.modifyTime || 0),
      }))));
      return;
    }
    if (command === 'download' || command === 'download-account') {
      const name = accountRequest ? accountRequest.fileName : decodeFileName(encodedName);
      if (accountRequest && !globMatcher(promotionRule.filePattern).test(name)) throw new Error('Promotion file does not match account pattern');
      const buffer = await client.get(posix.join(root, name));
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maximumBytes) throw new Error('Promotion file size is invalid');
      process.stdout.write(JSON.stringify({ fileName: name, contentBase64: buffer.toString('base64') }));
      return;
    }
    if (command === 'download-account-batch') {
      const matcher = globMatcher(promotionRule.filePattern);
      const files = [];
      let totalBytes = 0;
      for (const name of accountRequest.fileNames) {
        if (!matcher.test(name)) throw new Error('Promotion file does not match account pattern');
        const buffer = await client.get(posix.join(root, name));
        if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maximumBytes) throw new Error(`Promotion file size is invalid: ${name}`);
        totalBytes += buffer.length;
        if (totalBytes > 32 * 1024 * 1024) throw new Error('Promotion batch exceeds 32 MB');
        files.push({ fileName: name, contentBase64: buffer.toString('base64') });
      }
      process.stdout.write(JSON.stringify({ files }));
      return;
    }
    if (command === 'replace-account') {
      const matcher = globMatcher(promotionRule.filePattern);
      const name = accountRequest.fileName;
      if (!matcher.test(name)) throw new Error('Promotion file does not match account pattern');
      const originalPath = posix.join(root, name);
      const original = await client.get(originalPath);
      if (!Buffer.isBuffer(original) || !original.length || original.length > maximumBytes) throw new Error('Current promotion file size is invalid');
      const currentSha256 = sha256(original);
      if (currentSha256 !== accountRequest.expectedSha256) {
        throw new Error(`Promotion file changed after preview; expected ${accountRequest.expectedSha256}, found ${currentSha256}`);
      }
      const editedSha256 = sha256(accountRequest.buffer);
      if (editedSha256 === currentSha256) {
        process.stdout.write(JSON.stringify({ fileName: name, unchanged: true, originalSha256: currentSha256, editedSha256 }));
        return;
      }
      const backupRoot = posix.join(root, '.promo-manager-backups');
      await client.mkdir(backupRoot, true);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `${name}.${stamp}.${accountRequest.operationId}.bak`;
      const backupPath = posix.join(backupRoot, backupName);
      const temporaryPath = posix.join(root, `.${name}.${accountRequest.operationId}.part`);
      await client.put(original, backupPath);
      await client.put(accountRequest.buffer, temporaryPath);
      const staged = await client.get(temporaryPath);
      if (!Buffer.isBuffer(staged) || sha256(staged) !== editedSha256) {
        await client.delete(temporaryPath).catch(() => false);
        throw new Error('Edited promotion file failed staging verification');
      }
      let replaced = false;
      if (typeof client.posixRename === 'function') {
        try {
          await client.posixRename(temporaryPath, originalPath);
          replaced = true;
        } catch { /* Some SFTP servers do not expose the POSIX rename extension. */ }
      }
      if (!replaced) {
        await client.delete(originalPath);
        try {
          await client.rename(temporaryPath, originalPath);
        } catch (error) {
          await client.put(original, originalPath).catch(() => false);
          throw error;
        }
      }
      const saved = await client.get(originalPath);
      if (!Buffer.isBuffer(saved) || sha256(saved) !== editedSha256) {
        await client.put(original, originalPath).catch(() => false);
        throw new Error('Edited promotion file failed final verification; original was restored');
      }
      process.stdout.write(JSON.stringify({
        fileName: name,
        unchanged: false,
        backupPath,
        originalSha256: currentSha256,
        editedSha256,
      }));
      return;
    }
    throw new Error('Unsupported command');
  } finally {
    await client.end().catch(() => false);
  }
})().catch(error => {
  process.stderr.write(String(error?.message || error).slice(0, 1000));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
