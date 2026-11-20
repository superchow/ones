import { isAbsolute } from 'node:path'
import { record, requireThat, text } from './domain/model.ts'
import { resolveFolders } from './local-git.ts'
import type { Store } from './service.ts'

export type GitProject = { path: string; enabled: boolean }
export type GitProjects = { version: 1; revision: number; projects: GitProject[] }
export type GitProjectsChange = { revision: number } & (
  { action: 'add'; paths: string[] } | { action: 'remove'; path: string } | { action: 'enable'; path: string; enabled: boolean }
)
const key = 'git.projects.v1'
const identity = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path

export function parseGitProjects(value: unknown): GitProjects {
  if (value === null) return { version: 1, revision: 0, projects: [] }
  const data = record(value)
  requireThat(data.version === 1 && Number.isSafeInteger(data.revision) && (data.revision as number) >= 0 && Array.isArray(data.projects) && data.projects.length <= 20, 'git-projects', '本机 Git 关联记录格式异常，未覆盖原记录。')
  const projects = data.projects.map(value => {
    const project = record(value), path = text(project.path, 4096)
    requireThat(isAbsolute(path) && !/^[/\\]{2}/.test(path) && typeof project.enabled === 'boolean', 'git-projects', '本机 Git 项目记录无效，请核对配置。')
    return { path, enabled: project.enabled }
  })
  requireThat(new Set(projects.map(p => identity(p.path))).size === projects.length, 'git-projects', '本机 Git 关联记录重复，未覆盖原记录。')
  // Missing/unmounted directories remain listed so users can reconnect or remove them.
  return { version: 1, revision: data.revision as number, projects }
}

export class GitProjectStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private store: Store) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action, action)
    this.queue = pending.catch(() => {})
    return pending
  }
  load(): Promise<GitProjects> { return this.serial(async () => parseGitProjects(await this.store.get(key))) }
  update(input: GitProjectsChange): Promise<GitProjects> {
    return this.serial(async () => {
      const saved = parseGitProjects(await this.store.get(key))
      requireThat(input.revision === saved.revision, 'stale', '关联项目已在其它页面更新，请刷新后重试。')
      if (input.action === 'add') {
        const paths = await resolveFolders(input.paths)
        const projects = new Map(saved.projects.map(project => [identity(project.path), project]))
        for (const path of paths) if (!projects.has(identity(path))) projects.set(identity(path), { path, enabled: true })
        requireThat(projects.size <= 20, 'git-projects', '最多关联 20 个项目，请先移除不需要的关联。')
        saved.projects = [...projects.values()]
      } else {
        requireThat(input.action === 'remove' || input.action === 'enable', 'input', '项目关联操作无效。')
        const path = text(input.path, 4096)
        const project = saved.projects.find(p => identity(p.path) === identity(path))
        requireThat(project, 'stale', '该项目关联已不存在，请刷新列表。')
        if (input.action === 'remove') saved.projects = saved.projects.filter(p => p !== project)
        else { requireThat(typeof input.enabled === 'boolean', 'input', '项目启用状态无效。'); project.enabled = input.enabled }
      }
      requireThat(saved.revision < Number.MAX_SAFE_INTEGER, 'git-projects', '关联记录版本超过范围。')
      saved.revision++
      await this.store.set(key, saved)
      return structuredClone(saved)
    })
  }
}
