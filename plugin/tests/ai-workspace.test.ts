import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { OrcaCli, OrcaCliError } from '../src/adapters/orca-cli.ts'

const path = resolve('private-hours-analysis')
const workspace = () => ({ worktree: { path, projectId: 'analysis', address: { environment: 'local', worktree: 'folder:analysis' } } })

test('analysis registers an independent folder once, then reuses its exact address without business-repo routing', async () => {
  const calls: string[][] = []
  let exists = false
  const cli = new OrcaCli(async args => {
    calls.push(args)
    if (args[0] === 'repo') { assert.deepEqual(args, ['repo', 'add', '--path', path, '--kind', 'folder']); exists = true; return {} }
    assert.deepEqual(args, ['worktree', 'show', '--worktree', `path:${path}`])
    if (!exists) throw new OrcaCliError('selector_not_found', 'Missing')
    return workspace()
  })
  const [a, b] = await Promise.all([cli.analysisTarget(path), cli.analysisTarget(path)])
  assert.equal(a.selector, 'folder:analysis'); assert.deepEqual(a, b)
  assert.equal((await cli.analysisTarget(path)).path, path)
  assert.equal(calls.filter(args => args[0] === 'repo').length, 1)
  assert.equal(calls.some(args => args[0] === 'agent'), false)
})

test('lost folder registration response is recovered by lookup, without another registration or launch', async () => {
  let exists = false, adds = 0
  const cli = new OrcaCli(async args => {
    if (args[0] === 'repo') { adds++; exists = true; throw new OrcaCliError('', 'Lost response') }
    if (!exists) throw new OrcaCliError('selector_not_found', 'Missing')
    return workspace()
  })
  await assert.rejects(() => cli.analysisTarget(path))
  assert.equal((await cli.analysisTarget(path)).selector, 'folder:analysis')
  assert.equal(adds, 1)
})

test('ambiguous, remote, archived and mismatched contexts never register or select a business workspace', async () => {
  for (const code of ['selector_ambiguous', 'runtime_access_denied', '']) {
    let requests = 0
    const failure = new OrcaCliError(code, 'Stop')
    const cli = new OrcaCli(async () => { requests++; throw failure })
    await assert.rejects(() => cli.analysisTarget(path), error => error === failure)
    assert.equal(requests, 1)
  }
  for (const changed of [{ path: resolve('business-repo') }, { isArchived: true }, { address: { environment: 'remote', worktree: 'identity:remote' } }]) {
    let requests = 0
    const cli = new OrcaCli(async () => { requests++; return { worktree: { ...workspace().worktree, ...changed } } })
    await assert.rejects(() => cli.analysisTarget(path))
    assert.equal(requests, 1)
  }
})
