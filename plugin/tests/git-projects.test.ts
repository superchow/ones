import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GitProjectStore, parseGitProjects } from '../src/git-projects.ts'
import type { Store } from '../src/service.ts'

test('Git associations persist across instances, preserve disabled and missing projects, and fence stale writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ones-associations-'))
  const pathA = join(root, 'project A'), pathB = join(root, '项目B'), file = join(root, 'settings.json')
  await mkdir(pathA); await mkdir(pathB)
  const store: Store = {
    get: async () => { try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } },
    set: async (_key, data) => { await writeFile(file, JSON.stringify(data)) },
    delete: async () => { throw Error('must not delete') }
  }
  try {
    let service = new GitProjectStore(store)
    assert.equal((await service.load()).projects.length, 0)
    let saved = await service.update({ revision: 0, action: 'add', paths: [pathA, pathB, pathA] })
    assert.equal(saved.projects.length, 2)
    saved = await service.update({ revision: saved.revision, action: 'enable', path: pathA, enabled: false })
    service = new GitProjectStore(store)
    assert.deepEqual(await service.load(), saved)
    await rm(pathB, { recursive: true })
    assert.deepEqual(await service.load(), saved)
    await assert.rejects(() => service.update({ revision: 0, action: 'remove', path: pathA }))
    const race = await Promise.allSettled([
      service.update({ revision: saved.revision, action: 'remove', path: pathB }),
      service.update({ revision: saved.revision, action: 'enable', path: pathA, enabled: true })
    ])
    assert.deepEqual(race.map(r => r.status), ['fulfilled', 'rejected'])
    const after = await new GitProjectStore(store).load()
    assert.deepEqual(after.projects, [{ path: pathA, enabled: false }])
    await assert.rejects(() => service.update({ revision: after.revision, action: 'add', paths: [pathB] }))
    assert.deepEqual(await service.load(), after)
    const failing = new GitProjectStore({ ...store, set: async () => { throw Error('disk full') } })
    await assert.rejects(() => failing.update({ revision: after.revision, action: 'enable', path: pathA, enabled: true }))
    assert.deepEqual(await service.load(), after)
    assert.throws(() => parseGitProjects({ version: 9, projects: [] }))
    assert.throws(() => parseGitProjects({ ...after, projects: [...after.projects, ...after.projects] }))
  } finally { await rm(root, { recursive: true, force: true }) }
})
