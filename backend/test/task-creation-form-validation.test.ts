import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FormFieldTipo } from '@prisma/client';
import { TasksService } from '../src/tasks/tasks.service';

interface FieldDefinition {
  id: string;
  label: string;
  tipo: FormFieldTipo;
  required: boolean;
  multiple: boolean;
}

function serviceFor(fields: FieldDefinition[], active = true) {
  const prisma = {
    taskType: {
      findUnique: async () => ({
        id: 'task-type-id',
        active,
        deletedAt: null,
        schedulable: false,
        formFields: fields,
        stepDefinitions: [],
      }),
    },
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action({
      task: { create: async () => ({ id: 'created-task-id' }) },
      formValue: { createMany: async () => ({ count: 1 }) },
    }),
  };
  const service = new TasksService(
    prisma as never,
    {} as never,
    { assertTaskTypeAccess: async () => undefined } as never,
    {} as never,
  );
  (service as unknown as { findOne: (id: string) => Promise<unknown> }).findOne = async id => ({ id });
  return service;
}

const user = { id: 'user-id', email: 'operator@example.test', roles: [] } as never;

test('task creation rejects an inactive release-gated task type', async () => {
  const service = serviceFor([], false);
  await assert.rejects(
    () => service.create({ taskTypeId: 'task-type-id' }, user),
    /TaskType not found/,
  );
});

test('task creation rejects form fields from another task type', async () => {
  const service = serviceFor([]);
  await assert.rejects(
    () => service.create({
      taskTypeId: 'task-type-id',
      formValues: [{ formFieldId: 'foreign-field-id', value: 'unexpected' }],
    }, user),
    /does not belong to the selected task type/,
  );
});

test('task creation rejects repeated non-multiple form fields', async () => {
  const service = serviceFor([{
    id: 'field-id',
    label: 'Comment',
    tipo: FormFieldTipo.texto,
    required: false,
    multiple: false,
  }]);
  await assert.rejects(
    () => service.create({
      taskTypeId: 'task-type-id',
      formValues: [
        { formFieldId: 'field-id', value: 'first' },
        { formFieldId: 'field-id', value: 'second' },
      ],
    }, user),
    /was submitted more than once/,
  );
});

test('task creation rejects missing required form fields', async () => {
  const service = serviceFor([{
    id: 'required-field-id',
    label: 'Required value',
    tipo: FormFieldTipo.texto,
    required: true,
    multiple: false,
  }]);
  await assert.rejects(
    () => service.create({ taskTypeId: 'task-type-id' }, user),
    /Required form fields are missing: Required value/,
  );
});

test('task creation rejects an image filename that was not uploaded', async () => {
  const service = serviceFor([{
    id: 'image-field-id',
    label: 'Shop Logo',
    tipo: FormFieldTipo.image,
    required: true,
    multiple: false,
  }]);
  await assert.rejects(
    () => service.create({
      taskTypeId: 'task-type-id',
      formValues: [{
        formFieldId: 'image-field-id',
        value: '123e4567-e89b-42d3-a456-426614174000.png',
      }],
    }, user),
    /Image upload for "Shop Logo" was not found/,
  );
});

test('task creation preserves distinct values for fields configured as multiple', async () => {
  const service = serviceFor([{
    id: 'multiple-field-id',
    label: 'Regions',
    tipo: FormFieldTipo.select,
    required: true,
    multiple: true,
  }]);
  const result = await service.create({
    taskTypeId: 'task-type-id',
    formValues: [
      { formFieldId: 'multiple-field-id', value: 'North' },
      { formFieldId: 'multiple-field-id', value: 'South' },
    ],
  }, user);
  assert.deepEqual(result, { id: 'created-task-id' });
});

test('task creation rejects an exact duplicate inside a multiple field', async () => {
  const service = serviceFor([{
    id: 'multiple-field-id',
    label: 'Regions',
    tipo: FormFieldTipo.select,
    required: false,
    multiple: true,
  }]);
  await assert.rejects(
    () => service.create({
      taskTypeId: 'task-type-id',
      formValues: [
        { formFieldId: 'multiple-field-id', value: 'North' },
        { formFieldId: 'multiple-field-id', value: 'North' },
      ],
    }, user),
    /contains a duplicate value/,
  );
});
