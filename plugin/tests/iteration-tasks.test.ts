import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OnesClient } from '../src/adapters/ones.ts'
import { Transport, ONES } from '../src/adapters/http.ts'

test('iteration tasks: server scopes, full project membership, pagination and wrong-scope rejection', async () => {
  const filters: Record<string, unknown>[] = []
  let projectId = 'project', sprintId = 'sprint'
  const client = new OnesClient(new Transport(ONES, async (_url, init) => {
    const { query, variables } = JSON.parse(String(init?.body))
    assert.ok(!query.includes('mutation'))
    if (query.includes('PluginProjects')) return Response.json({ data: { buckets: [{ projects: [{ uuid: 'project', name: '测试项目' }], pageInfo: { hasNextPage: false } }] } })
    if (query.includes('PluginIterations')) {
      assert.deepEqual(variables.filters, [{ project_in: ['project'], visibleInProject_equal: true }])
      return Response.json({ data: { sprints: [{ uuid: sprintId, name: '测试迭代', project: { uuid: projectId } }] } })
    }
    filters.push(variables.filter)
    return Response.json({ data: { buckets: [{ tasks: [{ uuid: 'task', number: 1, name: '普通任务', project: { uuid: projectId, name: '项目' }, sprint: { uuid: sprintId, name: '迭代' }, issueType: { uuid: 'normal', name: '任务' }, status: { uuid: 'todo', name: '未开始' } }], pageInfo: { hasNextPage: true, endCursor: 'next', unstable: false } }] } })
  }), { token: 'fixture', userId: 'me', label: 'fixture', teams: [{ id: 'team', name: 'fixture' }], expiresAt: Date.now() + 60000 }, 'team')
  assert.deepEqual(await client.projects(), [{ id: 'project', name: '测试项目' }])
  assert.deepEqual(await client.iterations('project'), [{ id: 'sprint', name: '测试迭代' }])
  const filter = { projectId: 'project', sprintId: 'sprint', onlyMine: false }
  const page = await client.tasks('', undefined, filter)
  assert.equal(page.items[0]!.issueType.name, '任务')
  assert.equal(page.nextCursor, 'next')
  assert.deepEqual(filters[0], { project_in: ['project'], sprint_in: ['sprint'] })
  await client.tasks('', undefined, { ...filter, onlyMine: true })
  assert.deepEqual(filters[1], { assign_in: ['me'], project_in: ['project'], sprint_in: ['sprint'] })
  await client.tasks()
  assert.deepEqual(filters[2], { assign_in: ['me'] })
  await assert.rejects(() => client.tasks('next', undefined, filter))
  await assert.rejects(() => client.tasks('', undefined, { sprintId: 'sprint' }))
  sprintId = 'wrong'
  await assert.rejects(() => client.tasks('', undefined, filter))
  projectId = 'wrong'
  await assert.rejects(() => client.iterations('project'))
})
