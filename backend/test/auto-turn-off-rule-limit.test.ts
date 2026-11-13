import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateSync } from 'class-validator';
import { CreateAutoTurnOffRuleDto } from '../src/integrations/dto/create-auto-turn-off-rule.dto';
import { UpdateAutoTurnOffRuleDto } from '../src/integrations/dto/update-auto-turn-off-rule.dto';

const shopIds = Array.from({ length: 9001 }, (_, index) => `57${String(index).padStart(17, '0')}`);

test('auto turn off rules accept 9,000 shop IDs and reject 9,001 on create and update', () => {
  for (const RuleDto of [CreateAutoTurnOffRuleDto, UpdateAutoTurnOffRuleDto]) {
    const valid = Object.assign(new RuleDto(), { shopIds: shopIds.slice(0, 9000) });
    const invalid = Object.assign(new RuleDto(), { shopIds });
    assert.equal(validateSync(valid).some(error => error.property === 'shopIds'), false);
    assert.equal(validateSync(invalid).some(error => error.property === 'shopIds'), true);
  }
});
