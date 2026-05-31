import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommandTextForDispatch } from '../src/command-normalizer.js';

test('normalizeCommandTextForDispatch strips operator prefixes without inventing scope', () => {
  const result = normalizeCommandTextForDispatch('치즈 질문: direct 모드가 왜 원문으로 안 갔는지 확인해줘');
  assert.equal(result.text, 'direct 모드가 왜 원문으로 안 갔는지 확인해줘');
  assert.equal(result.changed, true);
  assert.ok(result.rules.includes('strip-operator-prefix'));
});

test('normalizeCommandTextForDispatch extracts User Command fenced payload', () => {
  const input = [
    '도커로 빌드산출물을 이미지로 생성해서 쓰고있는데 그럼 어떻게해? 라고 물어봤는데',
    '',
    '# User Command',
    '',
    '```',
    '추가 확인 요청이야. 사용자는 도커로 빌드산출물을 이미지로 생성해서 쓰고있는데 그럼 어떻게해? 라고 해. 그러면 필요한 배포 방식을 확인해줘',
    '```',
  ].join('\n');
  const result = normalizeCommandTextForDispatch(input);
  assert.equal(result.text, '도커로 빌드산출물을 이미지로 생성해서 쓰고있는데 그럼 어떻게해? 필요한 배포 방식을 확인해줘');
  assert.equal(result.changed, true);
  assert.ok(result.rules.includes('extract-user-command-fence'));
  assert.ok(result.rules.includes('strip-hermes-boilerplate'));
  assert.doesNotMatch(result.text, /# User Command|추가 확인 요청|사용자는/);
});

test('normalizeCommandTextForDispatch preserves raw when requested', () => {
  const input = '치즈 질문: 그대로 보내';
  const result = normalizeCommandTextForDispatch(input, { raw: true });
  assert.equal(result.text, input);
  assert.equal(result.changed, false);
  assert.deepEqual(result.rules, ['raw-preserve-requested']);
});
