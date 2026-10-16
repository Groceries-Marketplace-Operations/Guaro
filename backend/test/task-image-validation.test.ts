import { strict as assert } from 'node:assert';
import { access, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { test } from 'node:test';
import { deflateSync } from 'zlib';
import { FormFieldTipo } from '@prisma/client';
import { TaskValidationService } from '../src/tasks/task-validation.service';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==',
  'base64',
);

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function validPng(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = 1 + (width * 4);
  const pixels = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) pixels[row * rowBytes] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function validationService(label: 'Shop Logo' | 'Shop Head Image') {
  const prisma = {
    taskType: {
      findUnique: async () => ({
        id: 'task-type-id',
        name: 'Image task',
        sectionId: 'section-id',
        active: true,
        deletedAt: null,
        section: { id: 'section-id', name: 'Integration' },
        formFields: [{ id: 'image-field-id', label, tipo: FormFieldTipo.image }],
        templates: [],
        stepDefinitions: [],
      }),
    },
  };
  return new TaskValidationService(
    prisma as never,
    { canAccess: async () => true } as never,
    { can: async () => true } as never,
  );
}

const user = { id: 'user-id', email: 'operator@example.test', roles: [] } as never;

test('a small logo is accepted without applying cover dimensions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guaro-logo-validation-'));
  const path = join(directory, 'logo.png');
  const image = validPng(128, 128);
  await writeFile(path, image);

  try {
    const result = await validationService('Shop Logo').validateImageUpload(
      'task-type-id',
      'image-field-id',
      {
        path,
        filename: '123e4567-e89b-42d3-a456-426614174000.png',
        originalname: 'logo.png',
        size: image.length,
      } as Express.Multer.File,
      user,
    );

    assert.equal(result.canProceed, true);
    assert.match(result.summary, /Original logo validated/);
    assert.equal(result.checks.some(check => check.id === 'image-framing'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the same small image is rejected for a store head image and removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guaro-cover-validation-'));
  const path = join(directory, 'cover.png');
  const image = validPng(128, 128);
  await writeFile(path, image);

  try {
    await assert.rejects(
      () => validationService('Shop Head Image').validateImageUpload(
        'task-type-id',
        'image-field-id',
        {
          path,
          filename: '123e4567-e89b-42d3-a456-426614174000.png',
          originalname: 'cover.png',
          size: image.length,
        } as Express.Multer.File,
        user,
      ),
      /cover must be at least 1200 x 900 px/,
    );
    await assert.rejects(() => access(path), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a truncated PNG header is rejected and removed instead of being treated as an image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guaro-truncated-logo-'));
  const path = join(directory, 'logo.png');
  const forgedHeader = Buffer.alloc(24);
  forgedHeader[0] = 0x89;
  forgedHeader.write('PNG', 1, 'ascii');
  forgedHeader.writeUInt32BE(128, 16);
  forgedHeader.writeUInt32BE(128, 20);
  await writeFile(path, forgedHeader);

  try {
    await assert.rejects(
      () => validationService('Shop Logo').validateImageUpload(
        'task-type-id',
        'image-field-id',
        {
          path,
          filename: '123e4567-e89b-42d3-a456-426614174000.png',
          originalname: 'logo.png',
          size: forgedHeader.length,
        } as Express.Multer.File,
        user,
      ),
      /not a valid JPG, JPEG or PNG image/,
    );
    await assert.rejects(() => access(path), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a PNG with a truncated final chunk is rejected and removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guaro-truncated-png-'));
  const path = join(directory, 'logo.png');
  const valid = validPng(64, 64);
  const truncated = valid.subarray(0, valid.length - 3);
  await writeFile(path, truncated);

  try {
    await assert.rejects(
      () => validationService('Shop Logo').validateImageUpload(
        'task-type-id',
        'image-field-id',
        {
          path,
          filename: '123e4567-e89b-42d3-a456-426614174000.png',
          originalname: 'logo.png',
          size: truncated.length,
        } as Express.Multer.File,
        user,
      ),
      /not a valid JPG, JPEG or PNG image/,
    );
    await assert.rejects(() => access(path), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a complete JPEG is accepted but the same file without EOI is rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guaro-jpeg-validation-'));
  const validPath = join(directory, 'valid.jpg');
  const truncatedPath = join(directory, 'truncated.jpg');
  await writeFile(validPath, VALID_JPEG);
  await writeFile(truncatedPath, VALID_JPEG.subarray(0, VALID_JPEG.length - 2));

  try {
    const result = await validationService('Shop Logo').validateImageUpload(
      'task-type-id',
      'image-field-id',
      {
        path: validPath,
        filename: '123e4567-e89b-42d3-a456-426614174000.jpg',
        originalname: 'logo.jpg',
        size: VALID_JPEG.length,
      } as Express.Multer.File,
      user,
    );
    assert.equal(result.canProceed, true);

    await assert.rejects(
      () => validationService('Shop Logo').validateImageUpload(
        'task-type-id',
        'image-field-id',
        {
          path: truncatedPath,
          filename: '223e4567-e89b-42d3-a456-426614174000.jpg',
          originalname: 'truncated.jpg',
          size: VALID_JPEG.length - 2,
        } as Express.Multer.File,
        user,
      ),
      /not a valid JPG, JPEG or PNG image/,
    );
    await assert.rejects(() => access(truncatedPath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
