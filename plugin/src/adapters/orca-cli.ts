import { execFile } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { AppError, record, requireThat, text, type Option } from '../domain/model.ts'

export type LocalTarget = { projectId: string; name: string; path: string; selector: string }
export type CliRunner = (args: string[], cwd?: string) => Promise<Record<string, unknown>>
export class OrcaCliError extends AppError {
  constructor(readonly cliCode: string, message: string) { super('cli', message) }
}
// Pinned to the executable verified on this installation; never search PATH or invoke a shell.
export const ORCA_CLI = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
  : '/Applications/Orca.app/Contents/Resources/bin/orca'
export const runCli: CliRunner = (args, cwd) => new Promise((resolve, reject) => {
  // Orca deliberately gives workers a minimal environment. Its standalone CLI
  // still needs the Windows profile paths to find this host's running runtime.
  const env = process.platform === 'win32' ? { ...process.env,
    APPDATA: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    USERPROFILE: process.env.USERPROFILE ?? homedir(),
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows'
  } : process.env
  execFile(ORCA_CLI, [...args, '--json'], { cwd, env, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
    try {
      requireThat((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT', 'cli-unavailable', '未找到已配置的 Orca CLI；请安装匹配版本，未启动会话。')
      // Do not reflect stderr/argv: they may contain Bug text.
      const envelope = record(JSON.parse(stdout))
      const failure = record(envelope.error ?? {}).code
      const code = typeof failure === 'string' && /^[a-z_]{1,64}$/.test(failure) ? `（${failure}）` : ''
      if (error || envelope.ok !== true) throw new OrcaCliError(typeof failure === 'string' ? failure : '', `Orca CLI 未完成操作${code}；若已开始启动，请先核实会话，勿重新发送。`)
      resolve(record(envelope.result))
    } catch (failure) {
      reject(failure instanceof AppError ? failure : new AppError('cli', 'Orca CLI 返回不可用；若已开始启动，请到项目核实，勿重复发送。'))
    }
  })
})
export class OrcaCli {
  private analysisPending = new Map<string, Promise<LocalTarget>>()
  constructor(private run: CliRunner = runCli) {}
  async projects(): Promise<Option[]> {
    const result = await this.run(['project', 'list'])
    requireThat(Array.isArray(result.projects) && !result.truncated, 'partial', 'Orca 项目列表不完整。')
    return result.projects.map(value => {
      const p = record(value)
      return { id: text(p.id, 1000), name: text(p.displayName, 500) }
    })
  }
  async projectForWorkspace(workspaceId: string): Promise<Option | null> {
    // Host workspace.list supplies an identity selector or an exact legacy/folder id.
    const selector = workspaceId.startsWith('identity:') ? workspaceId : `id:${workspaceId}`
    const shown = await this.run(['worktree', 'show', '--worktree', selector])
    const workspace = record(shown.worktree)
    if (typeof workspace.projectId !== 'string') return null
    return (await this.projects()).find(p => p.id === workspace.projectId) ?? null
  }
  async projectForTerminals(ids: string[]): Promise<Option | null> {
    if (!ids.length) return null
    // No --worktree means inventory, not the caller cwd. Discard output previews immediately.
    const result = await this.run(['terminal', 'list', '--limit', '10000'])
    if (!Array.isArray(result.terminals) || result.truncated !== false) return null
    const rows = result.terminals.map(record).filter(t => ids.includes(String(t.handle)))
    if (rows.length !== ids.length || new Set(rows.map(t => t.handle)).size !== ids.length) return null
    if (rows.some(t => t.executionHostId !== 'local' || typeof t.worktreeId !== 'string')) return null
    const owners = new Set(rows.map(t => String(t.worktreeId)))
    return owners.size === 1 ? this.projectForWorkspace([...owners][0]!) : null
  }
  async target(project: Option): Promise<LocalTarget> {
    const result = await this.run(['project', 'setups', '--project', project.id, '--host', 'local'])
    requireThat(Array.isArray(result.setups) && !result.truncated, 'partial', 'Orca 项目目录信息不完整。')
    const candidates = result.setups.map(record).filter(s => s.projectId === project.id && s.hostId === 'local' && s.setupState === 'ready')
    requireThat(candidates.length === 1, 'target', '该项目没有唯一就绪的本地目录；请先在 Orca 中配置项目。')
    const setup = candidates[0]!, path = text(setup.path, 4096), repoId = text(setup.repoId, 1000)
    requireThat(isAbsolute(path), 'target', '项目目录必须是绝对路径。')
    if (setup.kind === 'folder') {
      // Native folder selectors are accepted by agent launch; no folder is created here.
      return { projectId: project.id, name: project.name, path, selector: `folder:${repoId}` }
    }
    requireThat(setup.kind === 'git', 'target', '暂不支持此项目类型。')
    const listing = await this.run(['worktree', 'list', '--repo', `id:${repoId}`, '--limit', '10000'])
    requireThat(Array.isArray(listing.worktrees) && listing.truncated === false, 'partial', '已有工作区列表不完整。')
    const workspaces = listing.worktrees.map(record).filter(w => w.projectId === project.id && w.repoId === repoId && w.hostId === 'local' && w.path === path && w.isMainWorktree === true && w.isArchived !== true)
    requireThat(workspaces.length === 1, 'target', '未找到唯一的已有项目主目录；不会创建工作区或选择其它任务分支。')
    return { projectId: project.id, name: project.name, path, selector: `id:${text(workspaces[0]!.id, 6000)}` }
  }
  launch(target: LocalTarget, agent: string, prompt: string): Promise<Record<string, unknown>> {
    requireThat(agent === 'codex' || agent === 'claude' || agent === 'cursor', 'input', '请选择支持的聊天 Agent。')
    // cursor does not support structured chat; omit --surface and let Orca pick (terminal).
    const surfaceArgs = agent === 'cursor' ? [] : ['--surface', 'chat']
    return this.run(['agent', 'launch', '--agent', agent, '--worktree', target.selector, ...surfaceArgs, '--prompt', prompt, '--focus'], target.path)
  }
  /** Try to launch an agent chat in preference order: codex → claude → cursor.
   *  Uses `account list` rateLimits to skip agents that are unconfigured or have exhausted
   *  their quota window, then attempts the actual launch. Falls back to the next candidate
   *  if the launch itself fails (e.g. a stale rateLimits snapshot). Throws when every
   *  candidate is either unavailable or fails to launch. */
  async launchWithFallback(target: LocalTarget, prompt: string): Promise<Record<string, unknown>> {
    const accountList = await this.run(['account', 'list'])
    const rateLimits = record(accountList.rateLimits ?? {})
    const rateAvailable = (provider: string): boolean => {
      try {
        const limits = record(rateLimits[provider] ?? {})
        if (limits.status !== 'ok') return false
        for (const key of ['weekly', 'monthly'] as const) {
          const window = limits[key]
          if (window != null) {
            const { usedPercent } = record(window)
            if (typeof usedPercent === 'number' && usedPercent >= 100) return false
          }
        }
        return true
      } catch { return false }
    }
    const rateReason = (provider: string): string => {
      try {
        const limits = record(rateLimits[provider] ?? {})
        if (limits.status !== 'ok') return typeof limits.error === 'string' ? limits.error : '不可用'
        for (const key of ['weekly', 'monthly'] as const) {
          const window = limits[key]
          if (window != null) {
            const w = record(window)
            if (typeof w.usedPercent === 'number' && w.usedPercent >= 100)
              return typeof w.resetDescription === 'string' ? `将于 ${w.resetDescription} 重置` : '额度已用完'
          }
        }
      } catch { /* fall through */ }
      return '不可用'
    }
    const candidates = (['codex', 'claude', 'cursor'] as const).filter(rateAvailable)
    const skipped = (['codex', 'claude', 'cursor'] as const)
      .filter(a => !rateAvailable(a))
      .map(a => `${a}（${rateReason(a)}）`)
    if (!candidates.length)
      throw new AppError('agent-quota', `AI Agent 暂无可用额度：${skipped.join('；')}；请等待重置后重试。`)
    const launchErrors: string[] = []
    for (const agent of candidates) {
      try { return await this.launch(target, agent, prompt) }
      catch (error) { launchErrors.push(`${agent}：${error instanceof AppError ? error.message : '启动失败'}`) }
    }
    const skippedNote = skipped.length ? `（已跳过：${skipped.join('；')}）` : ''
    throw new AppError('cli', `所有可用 AI Agent 均启动失败${skippedNote}：${launchErrors.join('；')}；若已开始启动，请到 Orca 项目核实，勿重复发送。`)
  }
  async targetForPath(path: string): Promise<LocalTarget> {
    requireThat(isAbsolute(path), 'target', 'AI 工作目录必须是本地绝对路径。')
    // Resolve junctions / symlinks so the path:selector matches what Orca stored.
    let realPath = path
    try { realPath = realpathSync(path) } catch { /* non-existent path; keep original for the error */ }
    const shown = await this.run(['worktree', 'show', '--worktree', `path:${realPath}`])
    const workspace = record(shown.worktree), address = record(workspace.address)
    const actual = text(workspace.path, 4096)
    const normalise = (p: string) => { try { return realpathSync(p).toLowerCase() } catch { return resolve(p).toLowerCase() } }
    const same = process.platform === 'win32' ? normalise(actual) === normalise(realPath) : resolve(actual) === resolve(realPath)
    requireThat(same && address.environment === 'local' && workspace.isArchived !== true, 'target', '无法确认 AI 工作区的本地目录与身份，请在 Orca 中核对。')
    return { path: actual, selector: text(address.worktree, 6000), projectId: String(workspace.projectId ?? ''), name: String(workspace.displayName ?? path) }
  }
  async analysisTarget(path: string): Promise<LocalTarget> {
    const key = resolve(path)
    if (this.analysisPending.has(key)) return this.analysisPending.get(key)!
    const pending = this.registerAnalysisFolder(path)
    this.analysisPending.set(key, pending)
    try { return await pending } finally { this.analysisPending.delete(key) }
  }
  private async registerAnalysisFolder(path: string): Promise<LocalTarget> {
    try { return await this.targetForPath(path) }
    catch (error) {
      if (!(error instanceof OrcaCliError) || error.cliCode !== 'selector_not_found') throw error
    }
    // The caller supplies a private, ordinary analysis directory, never a business
    // repository. Register it without Git checkout, source attachment or agent launch.
    try {
      await this.run(['repo', 'add', '--path', path, '--kind', 'folder'])
      return await this.targetForPath(path)
    } catch {
      throw new AppError('analysis-workspace', 'Orca 尚未确认“工时分析”工作区创建成功，本次未启动 AI。请重试；插件会先核对已有工作区，存在时直接使用。')
    }
  }
}
export type LaunchReceipt = { state: 'sent' | 'unknown' | 'terminal'; sessionId?: string; handle?: string }
export function launchReceipt(result: Record<string, unknown>): LaunchReceipt {
  // agent launch returns AgentLaunchResult directly (worktree create nests it in launch).
  const launch = result.launch ? record(result.launch) : result
  const outcome = record(launch.outcome)
  const handle = typeof outcome.handle === 'string' ? outcome.handle : undefined
  if (outcome.kind === 'terminal') return { state: 'terminal', ...(handle ? { handle } : {}) }
  requireThat(outcome.kind === 'structured', 'cli', '未取得聊天创建回执。')
  const sessionId = text(outcome.sessionId, 1000)
  const prompt = launch.prompt ? record(launch.prompt) : {}
  return { state: prompt.outcome === 'journaled' && typeof prompt.messageId === 'string' && !launch.warning ? 'sent' : 'unknown', sessionId, ...(handle ? { handle } : {}) }
}
