import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browseFolders, readGitLogs } from '../src/local-git.ts'

function git(path: string, args: string[], extra: Record<string, string> = {}) {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...extra } }).trim()
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ones git 中文 '))
  const repo = join(root, '项目 一')
  await mkdir(repo)
  git(repo, ['init', '-q']); git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'me@example.test'])
  const commit = (subject: string, date: string, email = 'me@example.test') => {
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_EMAIL: email })
    return git(repo, ['rev-parse', 'HEAD'])
  }
  return { root, repo, commit, clean: () => rm(root, { recursive: true, force: true }) }
}

test('multi-folder Git: Shanghai boundaries, exact authors, clones dedup, partial errors and read-only tree', async () => {
  const f = await fixture()
  try {
    f.commit('前一天', '2026-11-08T23:59:59+08:00')
    const first = f.commit('修复初始化 <script>fixture</script>', '2026-11-09T00:00:00+08:00')
    f.commit('别人的工作', '2026-11-09T12:00:00+08:00', 'other@example.test')
    const last = f.commit('修复迭代列表', '2026-11-09T23:59:59+08:00')
    f.commit('次日', '2026-11-10T00:00:00+08:00')
    const copy = join(f.root, '第二个项目')
    git(f.root, ['clone', '-q', f.repo, copy]); git(copy, ['config', 'user.email', 'me@example.test'])
    const before = git(f.repo, ['status', '--porcelain=v1'])
    const report = await readGitLogs({ paths: [f.repo, copy, f.root, f.repo], date: '2026-11-09' })
    assert.deepEqual(report.commits.map(c => c.hash), [last, first])
    assert.equal(report.repositories.length, 3)
    assert.equal(report.repositories.filter(r => r.error).length, 1)
    assert.equal(report.repositories.filter(r => !r.error).reduce((n, r) => n + r.count, 0), 2)
    assert.equal(git(f.repo, ['status', '--porcelain=v1']), before)
    const all = await readGitLogs({ paths: [f.repo], date: '2026-11-09', allAuthors: true })
    assert.equal(all.commits.length, 3)
    const alias = await readGitLogs({ paths: [f.repo], date: '2026-11-09', emails: 'ME@example.test,other@example.test' })
    assert.equal(alias.commits.length, 3)
    const empty = await readGitLogs({ paths: [f.repo], date: '2026-11-07' })
    assert.equal(empty.commits.length, 0)
    assert.equal(empty.repositories[0]!.error, undefined)
  } finally { await f.clean() }
})

test('multi-folder Git: bounded inputs, actual folder navigation and cancellation', async () => {
  const f = await fixture()
  try {
    f.commit('fixture', '2026-11-09T12:00:00+08:00')
    const page = await browseFolders(f.root)
    assert.equal(page.folders[0]!.path, f.repo)
    assert.ok((await browseFolders()).folders.length)
    for (const paths of [[], Array(21).fill(f.repo)]) await assert.rejects(() => readGitLogs({ paths, date: '2026-11-09' }))
    await assert.rejects(() => readGitLogs({ paths: [f.repo], date: '2026-02-30' }))
    await assert.rejects(() => browseFolders('relative-folder'))
    await assert.rejects(() => browseFolders('\\\\server\\share'))
    await assert.rejects(() => readGitLogs({ paths: [f.repo], date: '2026-11-09' }, AbortSignal.abort()))
  } finally { await f.clean() }
})
