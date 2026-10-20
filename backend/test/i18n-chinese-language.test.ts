import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts = require('typescript');

const frontendSource = (...parts: string[]) => readFileSync(
  join(__dirname, '../../frontend/src', ...parts),
  'utf8',
);

function readStringRecord(fileParts: string[], variableName: string): Map<string, string> {
  const source = frontendSource(...fileParts);
  const sourceFile = ts.createSourceFile(fileParts.join('/'), source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let record: ts.ObjectLiteralExpression | undefined;

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === variableName && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
        record = declaration.initializer;
      }
    }
  }

  assert.ok(record, `could not find ${variableName} in ${fileParts.join('/')}`);
  const values = new Map<string, string>();
  for (const property of record.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ? property.name.text
      : undefined;
    if (name) values.set(name, property.initializer.text);
  }
  return values;
}

function readEnglishCatalog(): Map<string, string> {
  const source = frontendSource('i18n', 'translations.ts');
  const sourceFile = ts.createSourceFile('translations.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === 'translations');
    if (!declaration?.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
    const english = declaration.initializer.properties.find(property => {
      if (!ts.isPropertyAssignment(property)) return false;
      return (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === 'en';
    });
    assert.ok(english && ts.isPropertyAssignment(english) && ts.isObjectLiteralExpression(english.initializer), 'English catalog must be an object');
    const values = new Map<string, string>();
    for (const property of english.initializer.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) continue;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
      if (name) values.set(name, property.initializer.text);
    }
    return values;
  }
  assert.fail('could not find the English translation catalog');
}

function readChineseCatalog(): Map<string, string> {
  const files: Array<[string, string]> = [
    ['core.ts', 'zhCNCore'],
    ['catalog.ts', 'zhCNCatalog'],
    ['tasks.ts', 'zhCNTasks'],
    ['operations.ts', 'zhCNOperations'],
    ['index.ts', 'zhCN'],
  ];
  const combined = new Map<string, string>();
  for (const [file, variable] of files) {
    for (const [key, value] of readStringRecord(['i18n', 'zh-CN', file], variable)) {
      assert.equal(combined.has(key), false, `duplicate zh-CN key: ${key}`);
      combined.set(key, value);
    }
  }
  return combined;
}

test('Simplified Chinese exposes a real core catalog and keeps English fallback semantics', () => {
  const english = readEnglishCatalog();
  const chinese = readChineseCatalog();

  for (const key of [
    'common.save',
    'nav.dashboard',
    'nav.tasks',
    'nav.settings',
    'pages.login.title',
  ]) {
    const value = chinese.get(key);
    assert.equal(typeof value, 'string', `zh-CN is missing the core key ${key}`);
    assert.match(value!, /\p{Script=Han}/u, `${key} must be translated, not copied from English`);
  }

  const missingKeys = [...english.keys()].filter(key => !chinese.has(key));
  assert.deepEqual(missingKeys, [], 'zh-CN must cover every English catalog key');
  for (const [key, englishValue] of english) {
    const placeholders = (value: string) => [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(chinese.get(key)!), placeholders(englishValue), `placeholder mismatch for ${key}`);
  }

  const provider = frontendSource('i18n', 'index.tsx');
  const translationsSource = frontendSource('i18n', 'translations.ts');
  assert.match(translationsSource, /import\s*\{\s*zhCN\s*\}\s*from\s*['"]\.\/zh-CN['"]/, 'the Chinese catalog must be imported');
  assert.match(translationsSource, /['"]zh-CN['"]\s*:\s*zhCN/, 'the Chinese catalog must be registered');
  assert.match(
    provider,
    /translations(?:\[['"]en['"]\]|\.en)\[key\]/,
    'a missing zh-CN entry must continue falling back to the English catalog',
  );
  assert.match(
    provider,
    /\?\?\s*key/,
    'an unknown key in every catalog must remain visible instead of rendering blank',
  );
});

test('zh-CN is accepted, persisted, restored and exposed by the language selector', () => {
  const provider = frontendSource('i18n', 'index.tsx');
  const topbar = frontendSource('components', 'layout', 'Topbar.tsx');

  assert.match(provider, /['"]zh-CN['"]/, 'zh-CN must be part of the supported language type/list');
  assert.match(provider, /localStorage\.getItem\(['"]lang['"]\)/, 'the language must be restored on startup');
  assert.match(provider, /localStorage\.setItem\(['"]lang['"],\s*\w+\)/, 'language changes must be persisted');
  assert.match(provider, /document\.documentElement\.lang\s*=\s*lang/, 'the document language must follow the selection');

  assert.match(topbar, /['"]zh-CN['"]/, 'the top bar selector must offer Simplified Chinese');
  assert.match(topbar, /中文|简体/, 'the Chinese option must have a recognizable native-language label');
  assert.doesNotMatch(
    topbar,
    /lang\s*===\s*['"]en['"]\s*\?\s*['"]es['"]\s*:\s*['"]en['"]/,
    'the former binary EN/ES toggle cannot represent three languages',
  );
});
