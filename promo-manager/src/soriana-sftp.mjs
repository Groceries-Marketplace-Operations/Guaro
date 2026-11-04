import fs from 'node:fs/promises';
import path from 'node:path';
import { posix } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import SftpClient from 'ssh2-sftp-client';

const PROMOTION_FILE = /^promocionesdidi_(.+?)_(\d{14})(?:_[^.]+)?\.(csv|txt|tsv|xlsx|xls)$/i;
const PROMOTION_EXTENSION = /\.(csv|txt|tsv|xlsx|xls)$/i;
const MAX_FILE_SIZE = 12 * 1024 * 1024;

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Falta ${label} en la configuración SFTP de Soriana.`);
  return value.trim();
}

function normalizeRoot(value) {
  const root = posix.normalize(typeof value === 'string' && value.trim() ? value.trim() : '/upload');
  if (!root.startsWith('/')) throw new Error('La raíz SFTP de Soriana debe ser absoluta.');
  return root;
}

function safeFileName(value) {
  const name = String(value ?? '').trim();
  if (!name || name !== posix.basename(name) || name.includes('\\') || name.includes('\0') || !PROMOTION_FILE.test(name)) {
    throw new Error('Selecciona un archivo válido de promociones Soriana.');
  }
  return name;
}

function safeAccountFileName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 255 || name !== posix.basename(name) || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) || !PROMOTION_EXTENSION.test(name)) {
    throw new Error('Selecciona un archivo válido de la cuenta SFTP de promociones.');
  }
  return name;
}

function fileTimestamp(value) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
}

function modifiedIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function normalizedFiles(entries, { generic = false, accountId = '' } = {}) {
  return entries.flatMap(entry => {
    const name = String(entry.name ?? '');
    const match = PROMOTION_FILE.exec(name);
    if ((!generic && !match) || (generic && !PROMOTION_EXTENSION.test(name)) || (entry.type && entry.type !== '-')) return [];
    const timestampMatch = match ?? /^(?:[^_]+)_(.*?)_(\d{14})(?:_[^.]+)?\.(csv|txt|tsv|xlsx|xls)$/i.exec(name);
    const size = Number(entry.size ?? 0);
    return [{
      name,
      accountId,
      sourceShopId: timestampMatch?.[1] ?? '',
      fileTimestamp: timestampMatch?.[2] ? fileTimestamp(timestampMatch[2]) : null,
      size,
      modifiedAt: modifiedIso(entry.modifyTime),
      loadable: Number.isFinite(size) && size > 0 && size <= MAX_FILE_SIZE,
    }];
  }).sort((a, b) =>
    String(b.modifiedAt ?? b.fileTimestamp).localeCompare(String(a.modifiedAt ?? a.fileTimestamp))
    || b.name.localeCompare(a.name)
  );
}

async function credentialsFromFile(filePath) {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const candidate = (raw.sftpApplications ?? []).find(application =>
    typeof application?.name === 'string' && application.name.trim().toLocaleLowerCase('es') === 'soriana'
  );
  if (!candidate || candidate.active === false) throw new Error('No existe una aplicación SFTP Soriana activa en el archivo de credenciales.');
  return {
    host: nonEmpty(candidate.host, 'host'),
    port: Number(candidate.port ?? 22),
    username: nonEmpty(candidate.username, 'username'),
    password: nonEmpty(candidate.password, 'password'),
    rootPath: normalizeRoot(candidate.rootPath),
  };
}

export function createSorianaSftp(options = {}) {
  const credentialsFile = options.credentialsFile ?? process.env.SORIANA_CREDENTIALS_FILE?.trim() ?? '';
  const sshHost = options.sshHost ?? process.env.SORIANA_SFTP_SSH_HOST?.trim() ?? '';
  const sshIdentity = options.sshIdentity ?? process.env.SORIANA_SFTP_SSH_IDENTITY?.trim() ?? '';
  const sshContainer = options.sshContainer ?? process.env.SORIANA_SFTP_SSH_CONTAINER?.trim() ?? 'guaro-backend-1';
  const localRunner = options.localRunner ?? process.env.PROMO_SFTP_LOCAL_RUNNER === '1';
  const localRunnerCwd = options.localRunnerCwd ?? process.env.PROMO_BACKEND_CWD ?? '/app';
  const remoteConfigured = localRunner || Boolean(sshHost && sshIdentity);
  const cacheMs = options.cacheMs ?? 60_000;
  let cache = { loadedAt: 0, files: [] };
  let storeDirectoryCache = { loadedAt: 0, value: null };
  let promotionAccountsCache = { loadedAt: 0, value: null };
  const accountFilesCache = new Map();

  async function runRemote(command, fileName = '', embeddedPayload = null) {
    if (!localRunner && (!/^[A-Za-z0-9_.@:-]+$/.test(sshHost) || !/^[A-Za-z0-9_.-]+$/.test(sshContainer))) {
      throw new Error('La configuración del puente SSH de Soriana no es válida.');
    }
    const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'remote-soriana-sftp.cjs');
    const script = await fs.readFile(scriptPath);
    const encoded = fileName ? Buffer.from(fileName).toString('base64url') : '';
    const remoteCommand = `docker exec -i ${sshContainer} node - ${command}${encoded ? ` ${encoded}` : ''}`;
    const embeddedPrefix = embeddedPayload === null
      ? null
      : Buffer.from(`globalThis.__PROMO_MANAGER_EMBEDDED = JSON.parse(Buffer.from('${Buffer.from(JSON.stringify(embeddedPayload)).toString('base64')}', 'base64').toString('utf8'));\n`);
    const inputScript = embeddedPrefix ? Buffer.concat([embeddedPrefix, script]) : script;
    const execute = () => new Promise((resolve, reject) => {
      const child = localRunner
        ? spawn(process.execPath, ['-', command, ...(encoded ? [encoded] : [])], {
          cwd: localRunnerCwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        })
        : spawn('ssh', [
          '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', sshIdentity,
          sshHost, remoteCommand,
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      const timeoutMs = command === 'bound-stores-account'
        ? 390_000
        : ['download-account-batch', 'replace-account'].includes(command) ? 180_000 : 60_000;
      const outputLimit = command === 'download-account-batch' ? 64 * 1024 * 1024 : 20 * 1024 * 1024;
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > outputLimit) child.kill();
        else stdout.push(chunk);
      });
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`La consulta SFTP falló: ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 1000) || `código ${code}`}`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
        catch { reject(new Error('La consulta SFTP devolvió una respuesta inválida.')); }
      });
      child.stdin.end(inputScript);
    });
    try {
      return await execute();
    } catch (error) {
      if (localRunner || !/(?:connection lost before handshake|connection reset|connection timed out|timed out while waiting for handshake|econnreset)/i.test(String(error?.message ?? error))) throw error;
      await new Promise(resolve => setTimeout(resolve, 750));
      return execute();
    }
  }

  async function withClient(action) {
    if (!credentialsFile) throw new Error('Configura SORIANA_CREDENTIALS_FILE para consultar el SFTP.');
    const credentials = await credentialsFromFile(path.resolve(credentialsFile));
    const client = new SftpClient('didi-promo-manager-soriana');
    try {
      await client.connect({
        host: credentials.host,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        readyTimeout: 30_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        retries: 2,
        retry_minTimeout: 1500,
      });
      return await action(client, credentials.rootPath);
    } finally {
      await client.end().catch(() => false);
    }
  }

  async function requirePromotionAccount(accountId) {
    const id = String(accountId ?? '').trim();
    const account = (await listPromotionAccounts()).find(candidate => candidate.id === id);
    if (!account) throw new Error('Selecciona una cuenta SFTP de promociones configurada.');
    return account;
  }

  async function listFiles({ force = false, accountId = '' } = {}) {
    if (accountId) {
      const account = await requirePromotionAccount(accountId);
      const cached = accountFilesCache.get(account.id);
      if (!force && cached?.files.length && Date.now() - cached.loadedAt < cacheMs) return cached.files;
      if (!remoteConfigured && account.id !== 'soriana') throw new Error('El puente seguro de Tequila es necesario para consultar esta cuenta SFTP.');
      const entries = remoteConfigured
        ? await runRemote('list-account', JSON.stringify({ accountId: account.id }))
        : await withClient((client, rootPath) => client.list(rootPath));
      const files = normalizedFiles(entries, { generic: remoteConfigured, accountId: account.id });
      accountFilesCache.set(account.id, { loadedAt: Date.now(), files });
      return files;
    }
    if (!force && cache.files.length && Date.now() - cache.loadedAt < cacheMs) return cache.files;
    const entries = remoteConfigured
      ? await runRemote('list')
      : await withClient((client, rootPath) => client.list(rootPath));
    const files = normalizedFiles(entries);
    cache = { loadedAt: Date.now(), files };
    return files;
  }

  async function download(fileName, { accountId = '' } = {}) {
    const account = accountId ? await requirePromotionAccount(accountId) : null;
    const name = account ? safeAccountFileName(fileName) : safeFileName(fileName);
    const listed = (await listFiles({ accountId: account?.id ?? '' })).find(file => file.name === name);
    if (!listed) throw new Error('El archivo SFTP ya no aparece en el listado. Actualiza y vuelve a elegirlo.');
    if (!listed.loadable) throw new Error('El archivo SFTP está vacío o supera el máximo de 12 MB.');
    const buffer = remoteConfigured
      ? Buffer.from((await runRemote(account ? 'download-account' : 'download', account ? JSON.stringify({ accountId: account.id, fileName: name }) : name)).contentBase64, 'base64')
      : await withClient(async (client, rootPath) => client.get(posix.join(rootPath, name)));
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_SIZE) {
      throw new Error('El archivo SFTP descargado está vacío o supera el máximo de 12 MB.');
    }
    return { fileName: name, buffer };
  }

  async function downloadMany(fileNames, { accountId = '' } = {}) {
    const account = await requirePromotionAccount(accountId);
    if (!Array.isArray(fileNames) || !fileNames.length || fileNames.length > 1000) {
      throw new Error('Selecciona entre 1 y 1000 archivos SFTP para procesar.');
    }
    const names = [...new Set(fileNames.map(safeAccountFileName))];
    const listedFiles = await listFiles({ accountId: account.id });
    const listedByName = new Map(listedFiles.map(file => [file.name, file]));
    for (const name of names) {
      const listed = listedByName.get(name);
      if (!listed) throw new Error(`El archivo ${name} ya no aparece en el SFTP.`);
      if (!listed.loadable) throw new Error(`El archivo ${name} está vacío o supera 12 MB.`);
    }
    if (!remoteConfigured) {
      return withClient(async (client, rootPath) => {
        const result = [];
        for (const name of names) {
          const buffer = await client.get(posix.join(rootPath, name));
          if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_SIZE) throw new Error(`El archivo ${name} tiene un tamaño inválido.`);
          result.push({ fileName: name, buffer });
        }
        return result;
      });
    }
    const result = [];
    for (let index = 0; index < names.length; index += 20) {
      const chunk = names.slice(index, index + 20);
      const response = await runRemote('download-account-batch', JSON.stringify({ accountId: account.id, fileNames: chunk }));
      const files = Array.isArray(response.files) ? response.files : [];
      if (files.length !== chunk.length) throw new Error('El SFTP no devolvió todos los archivos solicitados.');
      for (const file of files) {
        const name = safeAccountFileName(file.fileName);
        const buffer = Buffer.from(String(file.contentBase64 ?? ''), 'base64');
        if (!buffer.length || buffer.length > MAX_FILE_SIZE) throw new Error(`El archivo ${name} tiene un tamaño inválido.`);
        result.push({ fileName: name, buffer });
      }
    }
    return result;
  }

  async function replacePromotionFile(accountId, fileName, buffer, options = {}) {
    if (!remoteConfigured) throw new Error('El puente seguro de Tequila es necesario para editar archivos SFTP.');
    const account = await requirePromotionAccount(accountId);
    const name = safeAccountFileName(fileName);
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_SIZE) {
      throw new Error('El archivo editado está vacío o supera 12 MB.');
    }
    const expectedSha256 = String(options.expectedSha256 ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Falta la huella SHA-256 del archivo original.');
    const operationId = String(options.operationId ?? '').trim();
    if (!/^[A-Za-z0-9-]{8,80}$/.test(operationId)) throw new Error('El identificador de la operación SFTP no es válido.');
    const response = await runRemote('replace-account', '', {
      accountId: account.id,
      fileName: name,
      expectedSha256,
      operationId,
      contentBase64: buffer.toString('base64'),
    });
    accountFilesCache.delete(account.id);
    return response;
  }

  async function getAuthTokens(stores) {
    if (!remoteConfigured) throw new Error('El puente seguro de Tequila es necesario para autenticar múltiples tiendas.');
    if (!Array.isArray(stores) || !stores.length) throw new Error('Selecciona al menos una tienda destino.');
    const selections = stores.map(store => ({
      accountId: String(store.sftpAccountId ?? '').trim(),
      appShopId: String(store.appShopId ?? '').trim(),
    }));
    if (selections.some(selection => !/^[A-Za-z0-9]{1,64}$/.test(selection.appShopId))) {
      throw new Error('Una tienda destino no tiene un App Shop ID válido.');
    }
    const hasAccountScope = selections.every(selection => selection.accountId);
    if (selections.some(selection => Boolean(selection.accountId) !== hasAccountScope)) {
      throw new Error('La selección mezcla tiendas con y sin una cuenta SFTP asociada.');
    }
    const response = hasAccountScope
      ? await runRemote('auth-tokens-accounts', JSON.stringify(selections))
      : await runRemote('auth-tokens', JSON.stringify([...new Set(selections.map(selection => selection.appShopId))]));
    const tokens = new Map();
    const scopedTokens = new Map((Array.isArray(response.tokens) ? response.tokens : []).map(item => [
      `${String(item?.accountId ?? '')}\0${String(item?.appShopId ?? '')}`,
      item?.token,
    ]));
    for (const store of stores) {
      const token = hasAccountScope
        ? scopedTokens.get(`${store.sftpAccountId}\0${store.appShopId}`)
        : response.tokens?.[store.appShopId];
      if (typeof token !== 'string' || !token.trim()) throw new Error(`No se obtuvo autenticación para ${store.name}.`);
      tokens.set(store.id, token.trim());
    }
    return tokens;
  }

  async function getStoreDirectory({ force = false } = {}) {
    if (!remoteConfigured) return { brandName: 'Soriana', stores: [] };
    if (!force && storeDirectoryCache.value && Date.now() - storeDirectoryCache.loadedAt < 5 * 60_000) {
      return storeDirectoryCache.value;
    }
    const response = await runRemote('stores');
    const stores = Array.isArray(response.stores) ? response.stores.map(store => ({
      shopId: String(store.shopId ?? ''),
      appShopId: String(store.appShopId ?? ''),
      name: String(store.name ?? '').trim(),
      city: String(store.city ?? '').trim(),
    })).filter(store => /^[A-Za-z0-9]{1,64}$/.test(store.appShopId)) : [];
    const value = { brandName: String(response.brandName ?? 'Soriana'), stores };
    storeDirectoryCache = { loadedAt: Date.now(), value };
    return value;
  }

  async function listPromotionAccounts({ force = false } = {}) {
    if (!remoteConfigured) return [{ id: 'soriana', name: 'Soriana', filePattern: 'promocionesdidi_*.csv' }];
    if (!force && promotionAccountsCache.value && Date.now() - promotionAccountsCache.loadedAt < 5 * 60_000) {
      return promotionAccountsCache.value;
    }
    const response = await runRemote('configuration');
    const seen = new Set();
    const accounts = (Array.isArray(response.rules) ? response.rules : []).flatMap(rule => {
      const name = String(rule?.sftpApplication?.name ?? '').trim();
      if (rule?.active !== true || !name || seen.has(name)) return [];
      seen.add(name);
      const brand = rule?.sftpApplication?.brand;
      const stores = Array.isArray(brand?.shops) ? brand.shops.map(store => ({
        shopId: String(store?.shopId ?? '').trim(),
        appShopId: String(store?.appShopId ?? '').trim(),
        name: String(store?.name ?? '').trim(),
        city: String(store?.city ?? '').trim(),
      })).filter(store => /^[A-Za-z0-9]{1,64}$/.test(store.appShopId)) : [];
      return [{
        id: name,
        name,
        ruleName: String(rule.name ?? '').trim(),
        filePattern: String(rule.filePattern ?? '').trim(),
        brandId: String(brand?.brandId ?? '').trim(),
        brandName: String(brand?.brandName ?? '').trim(),
        stores,
      }];
    }).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    promotionAccountsCache = { loadedAt: Date.now(), value: accounts };
    return accounts;
  }

  async function fetchPromotionAccountStores(accountId) {
    if (!remoteConfigured) throw new Error('El puente seguro de Tequila es necesario para actualizar las tiendas de la aplicación.');
    const id = String(accountId ?? '').trim();
    if (!id || id.length > 160) throw new Error('Selecciona una cuenta SFTP de promociones válida.');
    const response = await runRemote('bound-stores-account', JSON.stringify({ accountId: id }));
    const stores = Array.isArray(response.stores) ? response.stores.map(store => ({
      shopId: String(store?.shopId ?? '').trim(),
      appShopId: String(store?.appShopId ?? '').trim(),
      name: String(store?.name ?? '').trim(),
      city: String(store?.city ?? '').trim(),
    })).filter(store => /^\d{1,64}$/.test(store.shopId) && /^[A-Za-z0-9]{1,64}$/.test(store.appShopId)) : [];
    if (!stores.length) throw new Error('DiDi no devolvió tiendas vinculadas para la cuenta seleccionada.');
    return {
      id: String(response.accountId ?? id),
      name: String(response.accountId ?? id),
      brandId: String(response.brandId ?? '').trim(),
      brandName: String(response.brandName ?? '').trim(),
      stores,
    };
  }

  return {
    configured: remoteConfigured || Boolean(credentialsFile),
    authConfigured: remoteConfigured,
    listFiles,
    download,
    downloadMany,
    replacePromotionFile,
    getAuthTokens,
    getStoreDirectory,
    listPromotionAccounts,
    fetchPromotionAccountStores,
  };
}
