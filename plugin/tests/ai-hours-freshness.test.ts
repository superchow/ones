import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench, type Store } from '../src/service.ts'
import { AiHoursWorkflow } from '../src/ai-hours.ts'
import { ensurePrivateDirectory } from '../src/private-files.ts'

const date = '2026-11-10'
const selection = { mode: 'manual' as const, minutes: 480, confirmed: true }
const allocation = { taskId: 'task', start: '09:00', minutes: 480, description: '完成登录修复' }

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), 'ones-ai-freshness-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = new Map<string, unknown>(), expiresAt = Date.now() + 7200000
  const store: Store = {
    get: async key => structuredClone(data.get(key) ?? null),
    set: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => { data.delete(key) }
  }
  data.set('session.ones', JSON.stringify({ token: 'fixture', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt }))
  data.set('session.coho', JSON.stringify({ token: 'fixture', principal: 'person', label: 'Fixture', expiresAt }))
  const state = { attendanceReads: 0, logReads: 0, changedPunch: false, changedLog: false, offline: false }
  const service = new Workbench({ store, vault: { get: async key => data.get(key) as string ?? null, set: store.set, delete: store.delete }, protection: async () => true,
    fetcher: async (url, init = {}) => {
      const path = new URL(String(url)).pathname, body = init.body ? JSON.parse(String(init.body)) : {}
      if (path.endsWith('/users/me')) return Response.json({ uuid: 'owner' })
      if (path.endsWith('/info')) return Response.json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
      if (path.endsWith('/getCurrentUser')) return Response.json({ code: 200, data: { tenantCode: 'ATS', globalId: 'person' } })
      if (path.endsWith('/getInfoByDateAndUser')) return Response.json({ code: 200, data: { kqqs: 'period' } })
      if (path.endsWith('/attCalendar')) {
        state.attendanceReads++
        if (state.offline) return new Response('unavailable', { status: 503 })
        return Response.json({ code: 200, data: { dateList: [{ date }], dkList: state.changedPunch ? [{ date, realDate: date, time: '09:00', isNext: false, outFence: false }] : [] } })
      }
      if (body.query?.includes('PluginPage')) {
        state.logReads++
        return Response.json({ data: { buckets: [{ manhours: state.changedLog ? [{ key: 'other-log', hours: 100000, startTime: Date.parse(date + 'T09:00:00+08:00') / 1000, type: 'recorded', description: 'Other work', owner: { uuid: 'owner' }, task: { uuid: 'other' } }] : [], pageInfo: { hasNextPage: false, unstable: false, endCursor: '' } }] } })
      }
      if (body.query?.includes('PluginTask')) return Response.json({ data: { tasks: [{ uuid: 'task', number: 1, name: 'Login', project: { uuid: 'project', name: 'Project' }, issueType: { uuid: 'bug', name: 'Bug' }, status: { uuid: 'open', name: 'Open' } }] } })
      throw Error('Unexpected request, including any write: ' + path)
    }
  })
  const day = await service.readDay({ team: 'team', date, mappingConfirmed: true })
  const input = { dayId: day.id, selection }, context = await service.aiHoursContext(input)
  const id = 'a'.repeat(64), directory = join(root, id)
  await ensurePrivateDirectory(directory, 'Fixture directory')
  await store.set('ai-hours.' + id, { context: context.key, paths: [root], tasks: [{ id: 'task' }], projects: [], receipt: { id, date, state: 'sent' } })
  await writeFile(join(directory, 'result.json'), JSON.stringify({ version: 1, requestId: id, allocations: [allocation], notes: '已完成分析' }), { mode: 0o600 })
  const workflow = new AiHoursWorkflow(service, { load: async () => ({ version: 1, revision: 1, projects: [{ path: root, enabled: true }] }) }, store, undefined, root)
  return { service, workflow, input: { ...input, id }, context, state }
}

test('AI result survives a long analysis; unchanged evidence refreshes without losing its ID or context', async t => {
  const f = await fixture(t)
  assert.equal((await f.workflow.result(f.input)).ready, true)
  assert.equal(f.state.attendanceReads, 1)
  t.mock.timers.tick(6 * 60000)
  const result = await f.workflow.result(f.input)
  assert.ok(result.ready)
  assert.deepEqual(result.allocations, [allocation])
  assert.equal(f.state.attendanceReads, 2)
  assert.equal(f.state.logReads, 2)
  assert.equal((await f.service.aiHoursContext(f.input)).key, f.context.key)
  // A further long review must also be able to preview, using the same confirmed day.
  t.mock.timers.tick(6 * 60000)
  const preview = await f.service.makePreview({ ...f.input, allocations: result.allocations })
  assert.equal(preview.proposed, 480)
  assert.equal(f.state.attendanceReads, 3)
  assert.equal(f.state.logReads, 3)
})

for (const change of ['changedPunch', 'changedLog'] as const) test(`expired AI evidence rejects actual changes: ${change}`, async t => {
  const f = await fixture(t)
  t.mock.timers.tick(300000)
  f.state[change] = true
  await assert.rejects(() => f.workflow.result(f.input), /考勤或已登记工时已变化/)
  await assert.rejects(() => f.service.makePreview({ ...f.input, allocations: [allocation] }), /考勤或已登记工时已变化/)
})

test('failed refresh retains the AI result and retries the read without treating old evidence as fresh', async t => {
  const f = await fixture(t)
  t.mock.timers.tick(360000)
  f.state.offline = true
  await assert.rejects(() => f.workflow.result(f.input))
  f.state.offline = false
  assert.equal((await f.workflow.result(f.input)).ready, true)
  assert.equal(f.state.attendanceReads, 3)
})

test('refresh cannot revive a replaced day or bypass an unconfirmed duration', async t => {
  const f = await fixture(t)
  t.mock.timers.tick(360000)
  await assert.rejects(() => f.workflow.result({ ...f.input, selection: { ...selection, confirmed: false } }))
  await f.service.readDay({ team: 'team', date, mappingConfirmed: true })
  await assert.rejects(() => f.workflow.result(f.input), /考勤或身份已变化/)
})
