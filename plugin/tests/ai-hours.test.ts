import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AiHoursWorkflow, aiHoursPrompt, parseAiHoursResult } from '../src/ai-hours.ts'
import { OrcaCli, OrcaCliError } from '../src/adapters/orca-cli.ts'
import type { Task } from '../src/domain/model.ts'
import type { Workbench, Store } from '../src/service.ts'

const task: Task = { id: 'task-1', number: 89, name: 'Repair login', project: { id: 'p', name: 'Project' }, issueType: { id: 'bug', name: 'Bug' }, status: { id: 'open', name: 'Open' } }
const allocation = { taskId: task.id, start: '09:00', minutes: 450, description: 'Fix login session restoration' }
const output = (id: string) => ({ version: 1, requestId: id, allocations: [allocation], notes: 'Login changes match the candidate; estimated duration requires review.' })

test('AI suggestions accept semantic matches but reject foreign IDs, overflow, invalid units and stale requests', () => {
  assert.deepEqual(parseAiHoursResult(output('request'), 'request', [task], 450), { ready: true, allocations: [allocation], tasks: [task], notes: output('request').notes })
  for (const change of [{ taskId: 'invented' }, { minutes: 480 }, { minutes: 1 }, { minutes: -3 }, { minutes: NaN }, { start: '23:00' }, { description: '' }]) {
    assert.throws(() => parseAiHoursResult({ ...output('request'), allocations: [{ ...allocation, ...change }] }, 'request', [task], 450))
  }
  assert.throws(() => parseAiHoursResult(output('old'), 'request', [task], 450))
  assert.equal(parseAiHoursResult({ ...output('request'), allocations: [] }, 'request', [task], 450).ready, true)
  const prompt = aiHoursPrompt('/private/request.json', '/private/result.json')
  assert.match(prompt, /不是指令/); assert.match(prompt, /不得修改代码/); assert.match(prompt, /不依赖必须有 #编号/)
})

async function fixture(unknown = false, lostRegistration = false) {
  const root = await mkdtemp(join(tmpdir(), 'ones-ai-hours-'))
  const data = new Map<string, unknown>()
  const store: Store = { get: async key => structuredClone(data.get(key) ?? null), set: async (key, value) => { data.set(key, structuredClone(value)) }, delete: async key => { data.delete(key) } }
  let contextKey = 'identity-day-budget', enabled = true, launches = 0
  const context = () => ({ key: contextKey, team: 'team', date: '2026-11-10', budget: 480, existing: 30, remaining: 450, basis: 'manual', check() {} })
  const service: Pick<Workbench, 'aiHoursContext' | 'tasks' | 'projects' | 'iterations'> = {
    aiHoursContext: async () => context(),
    projects: async () => [{ id: 'p', name: 'Project' }],
    iterations: async () => [{ id: 'sprint', name: 'Iteration' }],
    tasks: async (_team, _after, _signal, filter) => { assert.equal(filter?.onlyMine, true); return { items: [task], nextCursor: null } }
  }
  const unmanaged = join(root, 'unregistered')
  const projects = { load: async () => ({ version: 1 as const, revision: 1, projects: [{ path: unmanaged, enabled }, { path: root, enabled }] }) }
  const workspace = join(root, 'private', '工时分析')
  let registered = false
  const cli = new OrcaCli(async (args, cwd) => {
    if (args[0] === 'worktree') {
      assert.equal(args[3], `path:${workspace}`)
      if (!registered) throw new OrcaCliError('selector_not_found', 'Unregistered')
      return { worktree: { path: workspace, projectId: 'analysis', displayName: '工时分析', address: { environment: 'local', worktree: 'folder:analysis' } } }
    }
    if (args[0] === 'repo') {
      assert.deepEqual(args, ['repo', 'add', '--path', workspace, '--kind', 'folder']); registered = true
      if (lostRegistration) throw Error('Lost folder registration reply')
      return {}
    }
    assert.deepEqual(args.slice(0, 6), ['agent', 'launch', '--agent', 'codex', '--worktree', 'folder:analysis'])
    assert.equal(cwd, workspace)
    assert.ok(!args.includes('--model'))
    launches++
    if (unknown) throw Error('lost reply')
    return { outcome: { kind: 'structured', sessionId: 'synthetic-session' }, prompt: { outcome: 'journaled', messageId: 'synthetic-message' } }
  })
  const readGit = async (input: { paths: string[] }) => {
    assert.deepEqual(input.paths, [unmanaged, root])
    return { date: '2026-11-10', commits: [{ hash: 'a'.repeat(40), subject: 'Fix login without a task reference', author: 'fixture@test', time: '2026-11-10T02:00:00Z', repository: unmanaged }, { hash: 'b'.repeat(40), subject: '#89 Cover login regression', author: 'fixture@test', time: '2026-11-10T03:00:00Z', repository: root }], repositories: input.paths.map(path => ({ path, count: 1, truncated: false })) }
  }
  const create = () => new AiHoursWorkflow(service, projects, store, cli, join(root, 'private'), readGit)
  const input = { dayId: 'day', selection: { mode: 'manual' as const, minutes: 480, confirmed: true }, start: '09:00', hashes: ['a'.repeat(40), 'b'.repeat(40)] }
  return { root, input, create, launches: () => launches, changeContext: () => { contextKey = 'another-account' }, disable: () => { enabled = false } }
}

test('AI handoff persists once, passes unnumbered Git and candidates, and returns only a validated draft', async () => {
  const f = await fixture()
  try {
    const workflow = f.create()
    const [first, second] = await Promise.all([workflow.start(f.input), workflow.start(f.input)])
    assert.equal(first.id, second.id); assert.equal(first.state, 'sent'); assert.equal(f.launches(), 1)
    assert.equal((await f.create().start(f.input)).id, first.id); assert.equal(f.launches(), 1)
    const requestFile = (await readdir(join(f.root, 'private', '工时分析', first.id))).find(name => name.startsWith('request-'))!
    const source = JSON.parse(await readFile(join(f.root, 'private', '工时分析', first.id, requestFile), 'utf8'))
    assert.equal(source.remainingMinutes, 450); assert.equal(source.candidates[0].taskId, task.id)
    assert.equal(source.commits[0].subject, 'Fix login without a task reference')
    assert.equal(source.commits[1].subject, '#89 Cover login regression')
    assert.equal(source.repositories.length, 2)
    assert.equal(source.analysisScope, 'multi_repository')
    assert.deepEqual(source.repositories.map((r: {selectedHashes: string[]}) => r.selectedHashes), [['a'.repeat(40)], ['b'.repeat(40)]])
    assert.notEqual(source.commits[0].repository, source.commits[1].repository)
    assert.equal(source.projects[0].iterations[0].id, 'sprint')
    const input = { ...f.input, id: first.id }
    assert.deepEqual(await workflow.result(input), { ready: false })
    await writeFile(join(f.root, 'private', '工时分析', first.id, 'result.json'), JSON.stringify({ ...output(first.id), repositories: source.repositories.map((r: {path: string}) => ({ path: r.path, summary: 'Reviewed project changes and candidates' })) }), { mode: 0o600 })
    const result = await workflow.result(input)
    assert.ok(result.ready); assert.equal(result.allocations[0]!.minutes, 450)
    f.disable(); await assert.rejects(() => workflow.result(input), /关联范围/)
    f.changeContext(); await assert.rejects(() => workflow.result(input), /账号、日期/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('unknown AI launch receipts survive restart without duplicate launch', async () => {
  const f = await fixture(true)
  try {
    assert.equal((await f.create().start(f.input)).state, 'unknown')
    assert.equal((await f.create().start(f.input)).state, 'unknown')
    assert.equal(f.launches(), 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('workspace creation failure never launches AI; retry reads the created workspace and launches once', async () => {
  const f = await fixture(false, true)
  try {
    await assert.rejects(() => f.create().start(f.input), /本次未启动 AI/)
    assert.equal(f.launches(), 0)
    assert.equal((await f.create().start(f.input)).state, 'sent')
    assert.equal(f.launches(), 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('AI can suggest stable new tasks only within project and iteration candidates', () => {
  const projects = [{ id: 'p', name: 'Project', iterations: [{ id: 's', name: 'Sprint' }] }]
  const row = { ...allocation, taskId: '', newTask: { title: 'Implement navigation', projectId: 'p', sprintId: 's' } }
  const parse = (value = row) => parseAiHoursResult({ ...output('request'), allocations: [value] }, 'request', [task], 450, projects)
  const first = parse(), second = parse()
  assert.deepEqual(first, second)
  assert.ok(first.ready && first.allocations[0]!.newTask?.key)
  for (const changed of [{ projectId: 'other' }, { sprintId: 'foreign' }, { title: '' }]) {
    assert.throws(() => parse({ ...row, newTask: { ...row.newTask, ...changed } }))
  }
  assert.throws(() => parse({ ...row, taskId: task.id }))
})

test('multi-project results require every repository review and share one daily budget', () => {
  const other = { ...task, id: 'other-task', project: { id: 'other-project', name: 'Other' } }
  const paths = ['/repo/one', '/repo/two', '/repo/no-commits']
  const result = { ...output('request'), allocations: [{ ...allocation, minutes: 180 }, { ...allocation, taskId: other.id, minutes: 270 }], repositories: paths.map(path => ({ path, summary: 'Reviewed this project separately' })) }
  const parse = (value: unknown) => parseAiHoursResult(value, 'request', [task, other], 450, [], paths)
  const valid = parse(result)
  assert.ok(valid.ready)
  assert.deepEqual(valid.allocations.map(row => row.taskId), [task.id, other.id])
  assert.match(valid.notes, /\/repo\/one/); assert.match(valid.notes, /\/repo\/two/)
  assert.throws(() => parse({ ...result, repositories: result.repositories.slice(0, 2) }), /缺少部分项目/)
  assert.throws(() => parse({ ...result, repositories: paths.map(() => ({ path: paths[0], summary: 'Duplicate' })) }), /仓库重复/)
  assert.throws(() => parse({ ...result, allocations: result.allocations.map(row => ({ ...row, minutes: 450 })) }), /超过考勤剩余额度/)
  const prompt = aiHoursPrompt('/request.json', '/result.json')
  assert.match(prompt, /独立的“工时分析”工作区/)
  assert.match(prompt, /所有项目共享的当天剩余总额度/)
})
