import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskCreateOptions, prepareNewTask, TaskCreator } from '../src/adapters/task-creation.ts'
import type { OnesClient } from '../src/adapters/ones.ts'
import type { NewTaskDraft } from '../src/domain/model.ts'
import { Workbench, type Store } from '../src/service.ts'

const project = { id: 'project', name: 'Project' }, sprint = { id: 'sprint', name: 'Iteration' }
const types = [{ uuid: 'type', name: 'Task', builtIn: true, detailType: 2 }]
const configs = [
  { field_uuid: 'field001', type: 2, required: true },
  { field_uuid: 'field004', type: 8, required: true },
  { field_uuid: 'field011', type: 7, required: true },
  { field_uuid: 'due', type: 5, required: true },
  { field_uuid: 'priority', type: 1, required: true, default_value: 'normal' }
].map(c => ({ ...c, project_uuid: project.id, issue_type_uuid: 'type', option_configs: null }))
const projectData = { field_config: { field_configs: configs }, issue_type_config: { issue_type_configs: [{ project_uuid: 'project', issue_type_uuid: 'type' }] } }
const teamData = { task_field: { fields: [{ uuid: 'due', name: 'Due' }, { uuid: 'priority', name: 'Priority' }] }, task_field_option: { options: [{ uuid: 'normal', field_uuid: 'priority', value: 'Normal' }] } }
const date = '2026-11-10'
const options = () => taskCreateOptions(project, date, types, projectData, teamData, [sprint])
const draft: NewTaskDraft = { key: 'suggestion', title: 'Repair login', projectId: 'project', sprintId: 'sprint', fields: {} }
function memory() {
  const data = new Map<string, unknown>()
  const store: Store = { get: async k => structuredClone(data.get(k) ?? null), set: async (k, v) => { data.set(k, structuredClone(v)) }, delete: async k => { data.delete(k) } }
  return { data, store }
}

test('creation resolves project schema, defaults and iteration; rejects invalid or unsupported required fields', () => {
  const plan = prepareNewTask(draft, options(), 'owner')
  assert.equal(plan.payload.field_values.find(f => f.field_uuid === 'due')?.date_value, date)
  assert.equal(plan.payload.field_values.find(f => f.field_uuid === 'priority')?.value, 'normal')
  assert.equal(plan.payload.field_values.find(f => f.field_uuid === 'field011')?.value, 'sprint')
  for (const change of [{ title: '' }, { projectId: 'other' }, { sprintId: '' }, { sprintId: 'foreign' }, { fields: { priority: 'foreign' } }, { fields: { due: '2026-02-30' } }] as Partial<NewTaskDraft>[]) {
    assert.throws(() => prepareNewTask({ ...draft, ...change }, options(), 'owner'))
  }
  const unsupported = structuredClone(projectData)
  unsupported.field_config.field_configs[3]!.type = 99
  assert.throws(() => taskCreateOptions(project, date, types, unsupported, teamData, [sprint]), /暂不支持/)
})

test('uncertain task creation persists its ID; restart only reads it and checks fields', async () => {
  const mem = memory(), plan = prepareNewTask(draft, options(), 'owner')
  let posts = 0, taskId = '', mismatch = false
  const client = {
    session: { userId: 'owner' },
    task: async () => ({ name: plan.payload.summary, project, issueType: { id: 'type' } }),
    api: async (path: string, body?: { tasks: { uuid: string }[] }) => {
      if (path === '/tasks/add3') { posts++; taskId = body!.tasks[0]!.uuid; throw Error('lost response after server creation') }
      return { uuid: taskId, field_values: mismatch ? [] : plan.payload.field_values }
    }
  } as unknown as OnesClient
  await assert.rejects(() => new TaskCreator(client).createOrRead(plan, 'scope', date, mem.store, () => {}), /结果待核实/)
  mismatch = true
  await assert.rejects(() => new TaskCreator(client).createOrRead(plan, 'scope', date, mem.store, () => {}), /未通过字段回读/)
  mismatch = false
  plan.payload.field_values.reverse()
  assert.equal(await new TaskCreator(client).createOrRead(plan, 'scope', date, mem.store, () => {}), taskId)
  assert.equal(posts, 1)
  await assert.rejects(() => new TaskCreator(client).createOrRead(prepareNewTask({ ...draft, title: 'Changed' }, options(), 'owner'), 'scope', date, mem.store, () => {}), /不能修改后再次创建/)
  assert.equal(posts, 1)
})

for (const mode of ['success', 'mismatch', 'config-change', 'metadata-change', 'manual-edit', 'payload-change', 'quota-change'] as const) test(`batch creates and verifies task before worklog: ${mode}`, async () => {
  const { data, store } = memory(), expiresAt = Date.now() + 600000
  data.set('session.ones', JSON.stringify({ token: 'fixture', userId: 'owner', label: 'Fixture', teams: [{ id: 'team', name: 'Team' }], expiresAt }))
  data.set('session.coho', JSON.stringify({ token: 'fixture', principal: 'person', label: 'Fixture', expiresAt }))
  const actions: string[] = [], logs: Record<string, unknown>[] = []
  let created: Record<string, unknown> | undefined, submitted = false
  const service = new Workbench({ store, vault: { get: async k => data.get(k) as string ?? null, set: store.set, delete: store.delete }, protection: async () => true, worklogWritesEnabled: true,
    fetcher: async (url, init = {}) => {
      const path = new URL(String(url)).pathname, body = init.body ? JSON.parse(String(init.body)) : {}
      if (path.endsWith('/users/me')) return Response.json({ uuid: 'owner' })
      if (path.includes('/task/') && path.endsWith('/info')) { actions.push('task-readback'); return Response.json({ ...created, field_values: mode === 'mismatch' ? [] : created!.field_values }) }
      if (path.endsWith('/info')) return Response.json({ timezone: 'Asia/Shanghai', workhours_unit: 'hour', configs: [{ type: 'manhour_mode', data: 'simple' }] })
      if (path.endsWith('/getCurrentUser')) return Response.json({ code: 200, data: { tenantCode: 'ATS', globalId: 'person' } })
      if (path.endsWith('/getInfoByDateAndUser')) return Response.json({ code: 200, data: { kqqsId: 'period', kqqs: 'period' } })
      if (path.endsWith('/attCalendar')) return Response.json({ code: 200, data: { dateList: [{ date }], dkList: [] } })
      if (path.endsWith('/tasks/add3')) { actions.push('task-create'); created = body.tasks[0]; return Response.json({ tasks: [{ uuid: created!.uuid }] }) }
      if (path.endsWith('/stamps/data')) {
        if (!path.includes('/project/project/')) return Response.json({ ...teamData, stamp: submitted ? 2 : 1 })
        const meta = structuredClone(projectData)
        if (submitted && mode === 'config-change') meta.field_config.field_configs[4]!.required = false
        if (submitted && mode === 'metadata-change') meta.field_config.field_configs.reverse()
        if (submitted && mode === 'payload-change') meta.field_config.field_configs[3]!.default_value = '2026-11-12'
        return Response.json(meta)
      }
      const q = body.query ?? '', v = body.variables
      if (q.includes('PluginProjects')) return Response.json({ data: { buckets: [{ projects: [{ uuid: project.id, name: project.name }], pageInfo: { hasNextPage: false } }] } })
      if (q.includes('PluginIterations')) return Response.json({ data: { sprints: [{ uuid: sprint.id, name: sprint.name, project: { uuid: project.id } }] } })
      if (q.includes('PluginCreateTypes')) return Response.json({ data: { issueTypes: types } })
      if (q.includes('PluginTask')) return Response.json({ data: { tasks: [{ uuid: created!.uuid, number: 1, name: created!.summary, project: { uuid: project.id, name: project.name }, issueType: { uuid: 'type', name: 'Task' }, status: { uuid: 'open', name: 'Open' } }] } })
      if (q.includes('PluginAdd')) {
        actions.push('worklog-create')
        assert.ok(actions.includes('task-readback'))
        assert.equal(v.task, created!.uuid)
        logs.push({ key: 'log', hours: v.hours, startTime: v.start_time, type: v.type, description: v.description, owner: { uuid: v.owner }, task: { uuid: v.task } })
        return Response.json({ data: { addManhour: { key: 'log' } } })
      }
      if (q.includes('PluginReadback')) { actions.push('worklog-readback'); return Response.json({ data: { manhours: logs } }) }
      if (q.includes('PluginPage')) return Response.json({ data: { buckets: [{ manhours: logs, pageInfo: { hasNextPage: false, unstable: false, endCursor: '' } }] } })
      throw Error('Unexpected fixture request: ' + q)
    } })
  const row = { taskId: '', newTask: structuredClone(draft), start: '09:00', minutes: 60, description: 'Repair login' }
  await service.saveDraft({ date, allocations: [row] })
  assert.deepEqual((await service.loadDraft())!.allocations[0], row)
  const day = await service.readDay({ date, team: 'team', mappingConfirmed: true })
  let preview = await service.makePreview({ dayId: day.id, selection: { mode: 'manual', minutes: 480, confirmed: true }, allocations: [row] })
  if (mode === 'manual-edit') {
    row.newTask.title = '人工核对后的任务标题'
    row.newTask.fields.due = '2026-11-13'
    row.minutes = 90
    row.description = '人工核对后的工作描述'
    preview = await service.makePreview({ dayId: day.id, selection: { mode: 'manual', minutes: 480, confirmed: true }, allocations: [row] })
  }
  assert.match(preview.rows[0]!.taskName, /将新建任务/)
  assert.equal(actions.length, 0)
  submitted = true
  if (mode === 'quota-change') logs.push({ key: 'external', hours: 800000, startTime: Date.parse(date + 'T09:00:00+08:00') / 1000, type: 'recorded', description: 'Existing', owner: { uuid: 'owner' }, task: { uuid: 'other' } })
  if (['success', 'config-change', 'metadata-change', 'manual-edit'].includes(mode)) {
    assert.deepEqual(await service.submit(preview.id, true), { count: 1 })
    assert.deepEqual(actions, ['task-create', 'task-readback', 'worklog-create', 'worklog-readback'])
    assert.equal(created!.summary, row.newTask.title)
    assert.equal(logs[0]!.description, row.description)
    assert.equal(logs[0]!.hours, row.minutes / 60 * 100000)
  } else {
    await assert.rejects(() => service.submit(preview.id, true), { code: mode === 'mismatch' ? 'worklog-partial' : 'worklog-preflight' })
    assert.equal(actions.includes('worklog-create'), false)
    assert.equal(actions.includes('task-create'), mode === 'mismatch')
  }
})
