import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { AccountRole } from '@prisma/client';
import type { Response } from 'express';
import type { JwtUser } from '../src/auth/types/jwt-user.interface';
import type { TaskValidationService } from '../src/tasks/task-validation.service';
import { TasksController } from '../src/tasks/tasks.controller';
import type { TasksService } from '../src/tasks/tasks.service';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class CapturingResponse extends Writable {
  readonly headers = new Map<string, string>();
  readonly chunks: Buffer[] = [];
  headersSent = false;

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }

  _write(
    chunk: Buffer | Uint8Array | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function requester(): JwtUser {
  return {
    id: 'account-1',
    email: 'admin@example.com',
    roles: [AccountRole.super_admin],
    sectionId: null,
    adminModules: [],
    bpoPermissions: [],
  };
}

test('task export streams the XLSX as an authenticated binary download without Base64', async () => {
  const exportsDir = join(process.cwd(), 'uploads', 'exports');
  await mkdir(exportsDir, { recursive: true });
  const fileKey = `brand-promotions-${randomUUID()}.xlsx`;
  const filePath = join(exportsDir, fileKey);
  const content = Buffer.concat([
    Buffer.from('PK\u0003\u0004'),
    Buffer.alloc(2 * 1024 * 1024, 0x5a),
  ]);
  await writeFile(filePath, content);

  const calls: unknown[][] = [];
  const tasksService = {
    getStepExport: async (...args: unknown[]) => {
      calls.push(args);
      return { fileKey, mimeType: XLSX_MIME };
    },
  } as unknown as TasksService;
  const controller = new TasksController(
    tasksService,
    {} as TaskValidationService,
  );
  const response = new CapturingResponse();

  try {
    const returned = await controller.downloadExport(
      'task-1',
      'step-1',
      'xlsx',
      requester(),
      response as unknown as Response,
    );

    assert.equal(returned, undefined);
    assert.deepEqual(calls, [[
      'task-1',
      'step-1',
      {
        roles: [AccountRole.super_admin],
        accountId: 'account-1',
        sectionId: null,
      },
      'xlsx',
    ]]);
    assert.equal(response.headers.get('content-type'), XLSX_MIME);
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="${fileKey}"`);
    assert.equal(response.headers.get('content-length'), String(content.length));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(
      response.headers.get('access-control-expose-headers'),
      'Content-Disposition, Content-Length',
    );
    assert.ok(response.chunks.length > 1, 'the file should be streamed in bounded chunks');
    assert.ok(
      Math.max(...response.chunks.map(chunk => chunk.length)) < content.length,
      'the endpoint must not buffer the complete export before writing it',
    );
    assert.deepEqual(Buffer.concat(response.chunks), content);
    assert.equal((await stat(filePath)).size, content.length, 'downloads must remain repeatable');
  } finally {
    await unlink(filePath).catch(() => undefined);
  }
});
