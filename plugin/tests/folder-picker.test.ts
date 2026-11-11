import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveFolders } from '../src/local-git.ts'
import { decodeFolderSelection, nativeFolderScript } from '../src/native-folder-picker.ts'
import { GitProjectsView } from '../src/html/git-projects.ts'
import type { WorkbenchUI } from '../src/html/panel.ts'

test('manual folders validate real paths, deduplicate, and reject a bad batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ones folders '))
  try {
    const first = join(root, '项目 一'), second = join(root, 'project two')
    await mkdir(first); await mkdir(second)
    assert.deepEqual(await resolveFolders([first, second, first]), [first, second])
    for (const paths of [[], Array(21).fill(first), [first, join(root, 'missing')], ['relative'], ['\\\\server\\share']]) await assert.rejects(() => resolveFolders(paths))
    assert.deepEqual(decodeFolderSelection('{"paths":[],"cancelled":true}'), { paths: [], cancelled: true })
    for (const value of ['not json', '{"paths":[3],"cancelled":false}', '{"paths":["x"],"cancelled":true}']) assert.throws(() => decodeFolderSelection(value))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('picker cancellation/failure retain selections; manual fallback avoids a full page render', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'orca')
  let mode = 'success', calls = 0
  let revision = 0
  const paths = new Set<string>()
  Object.defineProperty(globalThis, 'orca', { configurable: true, value: { host: { call: async (_name: string, payload: { name: string; input: unknown }) => {
    assert.deepEqual(payload, JSON.parse(JSON.stringify(payload)))
    calls++
    if (payload.name.startsWith('git.projects.')) {
      if (payload.name === 'git.projects.update') {
        const input = payload.input as { revision: number; paths: string[] }
        assert.equal(input.revision, revision)
        input.paths.forEach(path => paths.add(path)); revision++
      }
      return { output: { ok: true, value: { version: 1, revision, projects: [...paths].map(path => ({ path, enabled: true })) } } }
    }
    return { output: mode === 'failed' ? { ok: false, error: { code: 'picker', message: '无法打开选择器' } }
      : { ok: true, value: mode === 'cancelled' ? { paths: [], cancelled: true } : { paths: ['D:\\Repo A'], cancelled: false } } }
  } } } })
  try {
    const app = { render() { throw Error('full page rendered') }, run() { throw Error('global busy changed') }, hours: { projectsChanged() {} } } as unknown as WorkbenchUI
    const view = new GitProjectsView(app) as unknown as {
      load(): Promise<void>; pick(): Promise<void>; addManual(): Promise<void>; manualPaths: string; paths: string[]; error: string
    }
    await view.load()
    await view.pick(); assert.deepEqual([...view.paths], ['D:\\Repo A'])
    mode = 'cancelled'; await view.pick(); assert.equal(view.paths.length, 1)
    mode = 'failed'; await view.pick(); assert.match(view.error, /手动录入/)
    view.manualPaths = '"D:\\Repo B"\n'; await view.addManual(); assert.equal(view.paths.length, 2)
    await view.addManual(); assert.equal(calls, 6); assert.match(view.error, /请填写/)
  } finally { if (descriptor) Object.defineProperty(globalThis, 'orca', descriptor); else Reflect.deleteProperty(globalThis, 'orca') }
})

test('Windows native multi-folder COM dialog compiles and accepts folder options without opening', { skip: process.platform !== 'win32' }, () => {
  const output = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(nativeFolderScript, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, ONES_PICKER_CHECK_ONLY: '1' } })
  assert.equal(output, 'True')
})
