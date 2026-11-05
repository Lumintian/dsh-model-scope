import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Answer, type Ask, AskUnavailable, type Question } from '../src/ask.ts'
import { type CommandHost, createCommands, PAGE_SIZE, type ProviderModels } from '../src/commands.ts'
import { DEFAULT_SETTINGS, type ScopeSettings } from '../src/config.ts'
import { Scope } from '../src/scope.ts'

function catalog(): ProviderModels[] {
  return [
    { id: 'deepseek-account', name: 'DeepSeek Account', models: [] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] },
    { id: 'cpa-home', name: '家用 CPA', models: ['gpt-5.4', 'gpt-5.5', 'gpt-image-2', 'gpt-6-luna'].map(id => ({ id, name: id })) },
    { id: 'openrouter', name: 'openrouter', models: [{ id: 'claude-x', name: 'Claude X' }] },
  ]
}

function setup(initial: Partial<ScopeSettings> = {}, models: ProviderModels[] = catalog()) {
  let settings: ScopeSettings = { ...DEFAULT_SETTINGS, ...initial }
  const writes: Array<Partial<ScopeSettings>> = []
  const host: CommandHost = {
    read: () => settings,
    write: async (patch) => {
      writes.push(patch)
      settings = { ...settings, ...patch }
    },
    catalog: async () => models,
    defaultModel: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
    surface: () => 'web',
  }
  const [command] = createCommands(host)
  const asked: Question[][] = []
  /** Run with scripted card replies, one function per card. */
  const run = async (args: string, ...cards: Array<(questions: Question[]) => Array<Omit<Answer, 'id'> & { id: string }>>) => {
    let index = 0
    const ask: Ask = async (questions) => {
      asked.push(questions)
      const reply = cards[index++]
      assert.ok(reply, `unexpected card #${index}: ${questions.map(q => q.question).join(' | ')}`)
      return new Map(reply(questions).map(answer => [answer.id, answer]))
    }
    const result = await command!.run({ args, ask, current: { provider: 'cpa-home', model: 'gpt-5.5' } })
    assert.equal(index, cards.length, 'every scripted card was used')
    return result
  }
  return { run, writes, asked, settings: () => settings }
}

const pick = (id: string, ...selected: string[]) => ({ id, selected })

test('menu → show/hide: hides visible models and re-shows hidden ones, writing exact patterns', async () => {
  const app = setup({ exclude: ['cpa-home/gpt-image-2'] })
  const result = await app.run('',
    () => [pick('action', '显示/隐藏模型')],
    () => [pick('provider', '家用 CPA（cpa-home）')],
    (questions) => {
      assert.deepEqual(questions.map(q => q.id), ['hide', 'show'])
      assert.deepEqual(questions[0]!.options!.map(o => o.label), ['gpt-5.4', 'gpt-5.5', 'gpt-6-luna'])
      assert.match(questions[0]!.options![1]!.description!, /当前会话在用/)
      assert.match(questions[1]!.options![0]!.description!, /被规则 cpa-home\/gpt-image-2 隐藏/)
      return [pick('hide', 'gpt-5.4', 'gpt-5.5'), pick('show', 'gpt-image-2')]
    },
  )
  assert.equal(result.kind, 'success')
  assert.equal(result.text.split('\n')[0], '已在 家用 CPA（cpa-home） 隐藏 2 个、显示 1 个模型')
  assert.match(result.text, /当前会话正在用的模型被隐藏了/)
  assert.deepEqual(app.settings().exclude, ['cpa-home/gpt-5.4', 'cpa-home/gpt-5.5'])
  assert.deepEqual(app.writes, [{ exclude: ['cpa-home/gpt-5.4', 'cpa-home/gpt-5.5'] }])
})

test('show/hide: a wildcard rule is reported instead of silently failing; include mode edits the allow list', async () => {
  const app = setup({ exclude: ['*/gpt-image-*'] })
  let result = await app.run('',
    () => [pick('action', '显示/隐藏模型')],
    () => [pick('provider', 'cpa-home')],
    () => [pick('show', 'gpt-image-2')],
  )
  assert.equal(result.text.split('\n')[0], '家用 CPA（cpa-home） 的 1 个模型没能显示：它们被通配或正则规则隐藏')
  assert.match(result.text, /仍被规则 \*\/gpt-image-\* 隐藏/)
  assert.deepEqual(app.writes, [], 'nothing to write')

  const included = setup({ mode: 'include', include: ['cpa-home/gpt-5.5', 'openrouter/*'] })
  result = await included.run('',
    () => [pick('action', '显示/隐藏模型')],
    () => [pick('provider', 'cpa-home')],
    (questions) => {
      assert.deepEqual(questions.find(q => q.id === 'hide')!.options!.map(o => o.label), ['gpt-5.5'])
      return [pick('hide', 'gpt-5.5'), pick('show', 'gpt-6-luna')]
    },
  )
  assert.equal(result.kind, 'success')
  assert.deepEqual(included.settings().include, ['openrouter/*', 'cpa-home/gpt-6-luna'])
  assert.deepEqual(included.settings().exclude, [])
})

test('hiding the default model explains keepDefault', async () => {
  const app = setup()
  const result = await app.run('',
    () => [pick('action', '显示/隐藏模型')],
    () => [pick('provider', 'DeepSeek（deepseek-official）')],
    () => [pick('hide', 'deepseek-chat')],
  )
  assert.match(result.text, /deepseek-chat：是默认模型，会继续显示（keepDefault）/)
  assert.deepEqual(app.settings().exclude, ['deepseek-official/deepseek-chat'])

  // Hidden by a rule but kept as the default: offered on the "show" page, where un-hiding it removes the rule.
  const again = await app.run('',
    () => [pick('action', '显示/隐藏模型')],
    () => [pick('provider', 'DeepSeek（deepseek-official）')],
    (questions) => {
      assert.deepEqual(questions.map(q => q.id), ['show'])
      assert.match(questions[0]!.options![0]!.description!, /被规则 deepseek-official\/deepseek-chat 隐藏，作为默认模型仍显示/)
      return [pick('show', 'deepseek-chat')]
    },
  )
  assert.equal(again.text.split('\n')[0], '已在 DeepSeek（deepseek-official） 显示 1 个模型')
  assert.deepEqual(app.settings().exclude, [])
})

test('all mode: hiding keeps the priority entry, so showing the model again restores its place', async () => {
  const app = setup({ include: ['cpa-home/gpt-6-luna'] })
  await app.run('',
    () => [pick('action', '显示/隐藏模型')],
    () => [pick('provider', 'cpa-home')],
    () => [pick('hide', 'gpt-6-luna')],
  )
  assert.deepEqual(app.settings(), { ...DEFAULT_SETTINGS, include: ['cpa-home/gpt-6-luna'], exclude: ['cpa-home/gpt-6-luna'] })
})

test('long model lists are split into pages of one card', async () => {
  const many: ProviderModels[] = [{ id: 'big', name: 'big', models: Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({ id: `m${i}`, name: `m${i}` })) }]
  const app = setup({}, many)
  const result = await app.run('',
    () => [pick('action', '显示/隐藏模型')],
    (questions) => {
      assert.deepEqual(questions.map(q => q.id), ['hide#0', 'hide#1'])
      assert.equal(questions[0]!.options!.length, PAGE_SIZE)
      assert.equal(questions[1]!.header, '隐藏 2/2')
      return [pick('hide#0', 'm0'), pick('hide#1', `m${PAGE_SIZE + 4}`)]
    },
  )
  assert.equal(result.kind, 'success')
  assert.deepEqual(app.settings().exclude, ['big/m0', `big/m${PAGE_SIZE + 4}`])
})

test('priority: add at the front in catalog order, move, remove', async () => {
  const app = setup({ include: ['openrouter/*'] })
  let result = await app.run('',
    () => [pick('action', '调整模型优先级')],
    () => [pick('action', '添加模型')],
    () => [pick('provider', 'cpa-home')],
    () => [pick('models', 'gpt-6-luna', 'gpt-5.5'), pick('where', '最前')],
  )
  assert.equal(result.text.split('\n')[0], '已把 2 个模型加到优先级列表最前')
  assert.deepEqual(app.settings().include, ['cpa-home/gpt-5.5', 'cpa-home/gpt-6-luna', 'openrouter/*'])

  result = await app.run('',
    () => [pick('action', '调整模型优先级')],
    () => [pick('action', '调整一条的位置')],
    (questions) => {
      assert.deepEqual(questions[0]!.options!.map(o => o.label), ['1. cpa-home/gpt-5.5', '2. cpa-home/gpt-6-luna', '3. openrouter/*'])
      return [pick('entry', '3. openrouter/*'), pick('move', '移到最前')]
    },
  )
  assert.equal(result.text.split('\n')[0], '已把 openrouter/* 移到第 1 位')
  assert.deepEqual(app.settings().include, ['openrouter/*', 'cpa-home/gpt-5.5', 'cpa-home/gpt-6-luna'])

  await app.run('',
    () => [pick('action', '调整模型优先级')],
    () => [pick('action', '调整一条的位置')],
    () => [pick('entry', '2. cpa-home/gpt-5.5'), pick('move', '下移一位')],
  )
  assert.deepEqual(app.settings().include, ['openrouter/*', 'cpa-home/gpt-6-luna', 'cpa-home/gpt-5.5'])

  result = await app.run('',
    () => [pick('action', '调整模型优先级')],
    () => [pick('action', '移除条目')],
    () => [pick('entries', '1. openrouter/*')],
  )
  assert.equal(result.text.split('\n')[0], '已从优先级列表移除 1 条')
  assert.deepEqual(app.settings().include, ['cpa-home/gpt-6-luna', 'cpa-home/gpt-5.5'])
})

test('provider order: materializes the effective order, then moves one provider', async () => {
  const app = setup({ include: ['openrouter/*'] })
  const result = await app.run('',
    () => [pick('action', '调整 provider 顺序')],
    (questions) => {
      assert.match(questions[0]!.question, /openrouter → deepseek-official → cpa-home/)
      return [pick('provider', '家用 CPA（cpa-home）'), pick('move', '上移一位')]
    },
  )
  assert.equal(result.kind, 'success')
  assert.deepEqual(app.settings().providerOrder, ['openrouter', 'cpa-home', 'deepseek-official'])
  assert.match(result.text, /DeepSeek 账号和 DeepSeek 官方两个分组放在最前/)

  await app.run('',
    () => [pick('action', '调整 provider 顺序')],
    () => [pick('provider', 'openrouter'), pick('move', '恢复默认顺序')],
  )
  assert.deepEqual(app.settings().providerOrder, [])
})

test('mode: include with an empty list is refused; switching back and forth works', async () => {
  const app = setup()
  let result = await app.run('mode include')
  assert.equal(result.kind, 'error')
  await app.run('top cpa-home/gpt-5.5')
  result = await app.run('',
    () => [pick('action', '切换模式')],
    () => [pick('mode', 'include：只显示优先级列表里的')],
  )
  assert.match(result.text, /已切到 include 模式/)
  assert.equal(app.settings().mode, 'include')
  result = await app.run('mode all')
  assert.equal(app.settings().mode, 'all')
})

test('reset asks for confirmation from the menu; status lists every provider', async () => {
  const app = setup({ include: ['openrouter/*'], exclude: ['gpt-image-*'], providerOrder: ['cpa-home'] })
  const status = await app.run('status')
  const lines = status.text.split('\n')
  assert.equal(lines[0], '模型范围：all 模式 · 显示 5/6 个模型 · 优先级 1 条 · 作用于 Web 模型选择器')
  assert.ok(lines.some(line => line.startsWith('- 家用 CPA（cpa-home）：显示 3/4') && line.includes('隐藏：gpt-image-2')))
  assert.ok(!lines.some(line => line.includes('deepseek-account')), 'providers without models are left out')

  let result = await app.run('', () => [pick('action', '恢复默认')], () => [pick('confirm', '取消')])
  assert.equal(result.text, '已取消，没有做任何修改')
  result = await app.run('', () => [pick('action', '恢复默认')], () => [pick('confirm', '恢复默认')])
  assert.deepEqual(app.settings(), DEFAULT_SETTINGS)
  assert.ok(new Scope(app.settings()).isIdentity)
})

test('shortcuts validate patterns; unknown verbs show usage; cards unavailable fall back to status', async () => {
  const app = setup()
  let result = await app.run('hide /(/')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /无效/)
  result = await app.run('frobnicate')
  assert.equal(result.kind, 'error')
  assert.equal(result.text.split('\n')[0], '不认识「frobnicate」这个参数')

  const host: CommandHost = {
    read: () => DEFAULT_SETTINGS,
    write: async () => {},
    catalog: async () => catalog(),
    defaultModel: () => undefined,
    surface: () => 'models',
  }
  const [command] = createCommands(host)
  result = await command!.run({ args: '', ask: async () => { throw new AskUnavailable() } })
  assert.equal(result.kind, 'success')
  assert.match(result.text.split('\n')[0]!, /作用于本 profile 的模型列表/)
  assert.match(result.text, /这个界面不能弹出卡片/)
})

test('favorites: add from the menu, reorder, shortcuts, status', async () => {
  const app = setup()
  let result = await app.run('',
    () => [pick('action', '收藏与轮切')],
    (questions) => {
      assert.match(questions[0]!.question, /当前：空/)
      return [pick('action', '添加模型')]
    },
    () => [pick('provider', 'cpa-home')],
    (questions) => {
      assert.equal(questions[1]!.options![1]!.label, '最后')
      return [pick('models', 'gpt-6-luna', 'gpt-5.5'), pick('where', '最后')]
    },
  )
  assert.equal(result.text.split('\n')[0], '已把 2 个模型加到收藏末尾')
  assert.match(result.text, /Ctrl\+Alt\+M/)
  assert.deepEqual(app.settings().favorites, ['cpa-home/gpt-5.5', 'cpa-home/gpt-6-luna'])

  result = await app.run('fav openrouter/claude-x cpa-home/gpt-5.5')
  assert.equal(result.text.split('\n')[0], '已收藏：openrouter/claude-x、cpa-home/gpt-5.5')
  assert.deepEqual(app.settings().favorites, ['cpa-home/gpt-5.5', 'cpa-home/gpt-6-luna', 'openrouter/claude-x'])

  await app.run('fav',
    () => [pick('action', '调整一条的位置')],
    () => [pick('entry', '3. openrouter/claude-x'), pick('move', '移到最前')],
  )
  assert.deepEqual(app.settings().favorites, ['openrouter/claude-x', 'cpa-home/gpt-5.5', 'cpa-home/gpt-6-luna'])

  const status = await app.run('status')
  assert.match(status.text.split('\n')[0]!, / · 收藏 3 条 · /)
  assert.ok(status.text.includes('收藏（favorites，轮切顺序）：1. openrouter/claude-x  2. cpa-home/gpt-5.5  3. cpa-home/gpt-6-luna'))
  assert.ok(status.text.includes('★gpt-5.5'))

  // The show/hide card marks favorites.
  await app.run('',
    () => [pick('action', '显示/隐藏模型')],
    () => [pick('provider', 'cpa-home')],
    (questions) => {
      assert.match(questions[0]!.options!.find(o => o.label === 'gpt-5.5')!.description!, /★ 收藏/)
      return [pick('hide')]
    },
  )

  result = await app.run('unfav cpa-home/gpt-5.5')
  assert.equal(result.text.split('\n')[0], '已取消收藏：cpa-home/gpt-5.5')
  assert.deepEqual(app.settings().favorites, ['openrouter/claude-x', 'cpa-home/gpt-6-luna'])
})
