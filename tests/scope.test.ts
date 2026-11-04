import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS, type ScopeSettings } from '../src/config.ts'
import { isExactPattern, parseMatch, Scope, scopeCatalog } from '../src/scope.ts'

function scope(settings: Partial<ScopeSettings>): Scope {
  return new Scope({ ...DEFAULT_SETTINGS, ...settings })
}

function catalog() {
  return {
    default: { provider: 'deepseek-official', model: 'deepseek-chat' },
    routableProviders: ['deepseek-official', 'cpa-home', 'openrouter'],
    failures: [{ id: 'broken', name: 'Broken', message: 'down' }],
    groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'deepseek-reasoner', name: 'Reasoner' }] },
      {
        id: 'cpa-home',
        name: 'CPA home',
        models: [
          { id: 'gpt-5.4', name: 'GPT-5.4' },
          { id: 'gpt-5.5', name: 'GPT-5.5', reasoning: { efforts: [] } },
          { id: 'gpt-image-2', name: 'Image' },
          { id: 'gpt-6-luna', name: 'Luna' },
        ],
      },
      { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'claude-x', name: 'Claude X' }, { id: 'gpt-image-1', name: 'Image 1' }] },
    ],
  }
}

const ids = (value: ReturnType<typeof catalog>): string[][] => value.groups.map(group => [group.id, ...group.models.map(model => model.id)])

test('parseMatch: glob is whole-name and case-insensitive; regex keeps flags without g/y', () => {
  assert.ok(parseMatch('gpt-*').test('GPT-5.5'))
  assert.ok(!parseMatch('gpt-5').test('gpt-5.5'))
  assert.ok(parseMatch('gpt-5.5').test('gpt-5.5'))
  assert.ok(!parseMatch('gpt-5.5').test('gpt-5x5'), 'dots are literal')
  const regex = parseMatch('/^gpt-(5|6)/gi')
  assert.equal(regex.flags, 'i')
  assert.ok(regex.test('GPT-6') && regex.test('GPT-6'))
  assert.throws(() => parseMatch('  '))
  assert.ok(isExactPattern('cpa-home/gpt-5.5'))
  assert.ok(!isExactPattern('cpa-home/*'))
  assert.ok(!isExactPattern('/gpt/'))
})

test('an empty scope returns the very same catalog', () => {
  const value = catalog()
  assert.equal(scopeCatalog(value, scope({})), value)
})

test('exclude hides in all mode; patterns match provider/model and bare model', () => {
  const result = scopeCatalog(catalog(), scope({ exclude: ['*/gpt-image-*', 'deepseek-reasoner'] }))
  assert.deepEqual(ids(result), [
    ['deepseek-official', 'deepseek-chat'],
    ['cpa-home', 'gpt-5.4', 'gpt-5.5', 'gpt-6-luna'],
    ['openrouter', 'claude-x'],
  ])
})

test('include orders models inside a group and providers by their best match', () => {
  const result = scopeCatalog(catalog(), scope({ include: ['openrouter/claude-x', 'cpa-home/gpt-5.5', 'gpt-6-*'] }))
  assert.deepEqual(ids(result), [
    ['openrouter', 'claude-x', 'gpt-image-1'],
    ['cpa-home', 'gpt-5.5', 'gpt-6-luna', 'gpt-5.4', 'gpt-image-2'],
    ['deepseek-official', 'deepseek-chat', 'deepseek-reasoner'],
  ])
})

test('include mode is an allow list; exclude still wins; empty groups disappear', () => {
  const result = scopeCatalog(catalog(), scope({
    mode: 'include',
    include: ['cpa-home/gpt-*'],
    exclude: ['gpt-image-*'],
    keepDefault: false,
  }))
  assert.deepEqual(ids(result), [['cpa-home', 'gpt-5.4', 'gpt-5.5', 'gpt-6-luna']])
})

test('keepDefault keeps the default model visible', () => {
  const result = scopeCatalog(catalog(), scope({ mode: 'include', include: ['cpa-home/gpt-5.5'], exclude: ['deepseek-chat'] }))
  assert.deepEqual(ids(result), [['cpa-home', 'gpt-5.5'], ['deepseek-official', 'deepseek-chat']])
  const explained = scope({ exclude: ['deepseek-chat'] }).explain({ provider: 'deepseek-official', model: 'deepseek-chat' }, true)
  assert.deepEqual(explained, { visible: true, reason: 'kept-default', hiddenBy: 'deepseek-chat' })
})

test('providerOrder comes first, case-insensitive; unlisted providers keep include and original order', () => {
  const result = scopeCatalog(catalog(), scope({ providerOrder: ['CPA-home'], include: ['openrouter/*'] }))
  assert.deepEqual(result.groups.map(group => group.id), ['cpa-home', 'openrouter', 'deepseek-official'])
})

test('other catalog fields and model fields pass through untouched', () => {
  const original = catalog()
  const result = scopeCatalog(original, scope({ exclude: ['gpt-5.4'] }))
  assert.deepEqual(result.default, original.default)
  assert.deepEqual(result.routableProviders, original.routableProviders)
  assert.deepEqual(result.failures, original.failures)
  const cpa = result.groups.find(group => group.id === 'cpa-home')!
  assert.equal(cpa.name, 'CPA home')
  assert.deepEqual(cpa.models[0], { id: 'gpt-5.5', name: 'GPT-5.5', reasoning: { efforts: [] } })
  assert.equal(original.groups[1]!.models.length, 4, 'input is not mutated')
})

test('invalid patterns are reported and ignored; unknown shapes pass through', () => {
  const s = scope({ exclude: ['/(/', 'gpt-5.4'] })
  assert.equal(s.issues.length, 1)
  assert.match(s.issues[0]!, /exclude\[0\]/)
  assert.ok(!s.isVisible({ provider: 'cpa-home', model: 'gpt-5.4' }))
  const odd = { groups: [{ id: 'x', models: 'nope' }] }
  assert.equal(scopeCatalog(odd, s), odd)
})
