import { OnesTransitions } from './adapters/ones-transitions.ts'
import { filterProject, projectMappingKey, type ProjectMapping } from './domain/project-mapping.ts'
import type { Option, TaskFilter } from './domain/model.ts'
import { createHash, randomUUID } from 'node:crypto'
import { type Allocation, type Attendance, type Preview, type Site, type Status, type Worklog, AppError, id, record, requireThat, safeFailure, text, validDate, validateAllocationTarget } from './domain/model.ts'
import { apiHours, attendanceBudget, checkAllocations, existingMinutes, startSeconds, validateDescription } from './domain/attendance.ts'
import { Submission, assertNoPending, createReceipt, parseReceipts, protectedDayHash, receiptCandidates, type Ledger, type Receipt } from './domain/submission.ts'
import { type Day, type DayInput, type Draft, type ImplementationBrief, type LoginInput, type PreviewInput, type PendingWrite, type RecoveryPreview } from './protocol.ts'
import { COHO, ONES, Transport, type Fetcher } from './adapters/http.ts'
import { loginOnes, refreshOnes, validateOnes, type OnesSession } from './adapters/ones-auth.ts'
import { CohoClient, loginCoho, validateCoho, type CohoSession } from './adapters/coho.ts'
import { OnesClient, worklogWriter } from './adapters/ones.ts'
import { TaskCreator, taskCreationSignature, type TaskCreationPlan } from './adapters/task-creation.ts'
import { BugMediaStore } from './adapters/bug-media.ts'
import { assertDetailFits, type BugDetail, type Discussion, type Attachment, type DetailPage } from './adapters/bug-details.ts'
import { allPages, mediaIds, type CompleteBug } from './domain/repair-content.ts'
import type { BugContent } from './domain/bug-content.ts'
export interface Store { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }
export interface Vault { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
export interface Dependencies { store: Store; vault: Vault; protection(): Promise<boolean>; fetcher?: Fetcher; worklogWritesEnabled?: boolean }
type Snapshot = { input: DayInput; data: Day; identity: string; stamp: string }
type Confirmation = { view: Preview; snapshot: Snapshot; input: PreviewInput; identity: string; creations: Map<string, TaskCreationPlan> }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class Workbench {
  private sessions: { ones?: OnesSession; coho?: CohoSession } = {}
  private epochs = { ones: 0, coho: 0 }
  private authQueues: Record<Site, Promise<unknown>> = { ones: Promise.resolve(), coho: Promise.resolve() }
  private ready?: Promise<void>
  private renewing: Partial<Record<Site, { epoch: number; promise: Promise<void> }>> = {}
  private connectionNotes: Partial<Record<Site, string>> = {}
  private unreadableSessions = new Set<Site>()
  private day?: Snapshot
  private preview?: Confirmation
  private recovery?: { id: string; receiptId: string; team: string; identity: string; key: string; stamp: string; expiresAt: number }
  private detailEpoch = 0
  private detailRequest?: string
  private detail?: { team: string; taskId: string; identity: string; media: BugMediaStore; view: BugDetail }
  private writeBusy = false
  private onesTransport: Transport
  private cohoTransport: Transport
  constructor(private deps: Dependencies) {
    this.onesTransport = new Transport(ONES, deps.fetcher)
    this.cohoTransport = new Transport(COHO, deps.fetcher)
  }
  private async ensureReady(): Promise<void> {
    this.ready ??= this.restore().catch(error => {
      this.ready = undefined
      throw error
    })
    await this.ready
    // Share the initial restore, but allow a later request to retry a locked vault.
    if (this.unreadableSessions.size) this.ready = undefined
  }
  private async restore(): Promise<void> {
    for (const site of ['ones', 'coho'] as const) {
      if (this.sessions[site]) continue
      const epoch = this.epochs[site]
      try {
        const raw = await this.deps.vault.get(`session.${site}`)
        if (epoch !== this.epochs[site]) continue
        this.unreadableSessions.delete(site)
        delete this.connectionNotes[site]
        if (!raw) continue
        const stored = record(JSON.parse(raw)); text(stored.token, 16000); text(stored.label)
        requireThat((site === 'coho' && stored.expiresAt === null) || (typeof stored.expiresAt === 'number' && Number.isFinite(stored.expiresAt)), 'schema', '保存的登录格式无效。')
        if (site === 'ones') {
          if (stored.refreshToken !== undefined) text(stored.refreshToken, 16000)
          id(stored.userId); requireThat(Array.isArray(stored.teams), 'schema', '团队信息无效。')
          stored.teams.forEach(t => { id(record(t).id); text(record(t).name) })
          this.sessions.ones = stored as unknown as OnesSession
        } else { id(stored.principal); this.sessions.coho = stored as unknown as CohoSession }
      } catch {
        if (epoch !== this.epochs[site]) continue
        this.unreadableSessions.add(site)
        this.connectionNotes[site] = '保存的登录暂时无法读取，凭证未删除；可刷新重试或重新登录。'
      }
    }
  }
  private async ensureSession(site: Site): Promise<void> {
    const previous = this.sessions[site], epoch = this.epochs[site]
    if (!previous || ((previous.expiresAt === null || previous.expiresAt > Date.now()) && !(site === 'ones' && this.sessions.ones?.needsValidation))) return
    if (this.renewing[site]?.epoch === epoch) return this.renewing[site]!.promise
    const promise = this.queue(site, async () => {
      if (this.epochs[site] !== epoch || this.sessions[site] !== previous) return
      const current = () => requireThat(this.epochs[site] === epoch, 'cancelled', '登录状态已变化。')
      const save = async (session: OnesSession | CohoSession) => {
        current()
        await this.deps.vault.set(`session.${site}`, JSON.stringify(session))
        current()
        if (site === 'ones') this.sessions.ones = session as OnesSession
        else this.sessions.coho = session as CohoSession
      }
      try {
        requireThat(await this.deps.protection(), 'secrets', '系统凭证库暂不可用，原登录未删除。')
        if (site === 'ones') {
          let session = previous as OnesSession
          if (!session.needsValidation && session.refreshToken) {
            session = await refreshOnes(this.onesTransport, session)
            current(); this.closeDetail()
            this.sessions.ones = session
            // Persist rotation before identity reads: a temporary network failure
            // must not lose the only usable replacement refresh token.
            await save(session)
          }
          await save(await validateOnes(this.onesTransport, session))
        } else await save(await validateCoho(this.cohoTransport, previous as CohoSession))
        delete this.connectionNotes[site]
      } catch (error) {
        if (this.epochs[site] !== epoch) throw error
        if (error instanceof AppError && ['auth', 'identity'].includes(error.code)) {
          ++this.epochs[site]; delete this.sessions[site]; this.invalidate()
          await this.deps.vault.delete(`session.${site}`)
          this.connectionNotes[site] = '服务端确认登录已失效，请重新登录。'
        } else this.connectionNotes[site] = '登录恢复暂未完成，凭证已保留；请检查连接后刷新重试。'
        throw error
      }
    })
    this.renewing[site] = { epoch, promise }
    try { await promise } finally { if (this.renewing[site]?.promise === promise) delete this.renewing[site] }
  }
  private queue<T>(site: Site, action: () => Promise<T>): Promise<T> {
    const next = this.authQueues[site].then(action, action)
    this.authQueues[site] = next.catch(() => {})
    return next
  }
  private invalidate(): void { this.day = undefined; this.preview = undefined; this.recovery = undefined; this.closeDetail() }
  private identity(): string {
    return digest([this.sessions.ones?.userId, this.sessions.coho?.principal, this.epochs.ones, this.epochs.coho])
  }
  async status(): Promise<Status> {
    await this.ensureReady()
    await Promise.allSettled((['ones', 'coho'] as const).map(site => this.ensureSession(site)))
    const ones = this.sessions.ones; const coho = this.sessions.coho
    return { ones: { connected: !!ones && ones.expiresAt > Date.now() && !ones.needsValidation, label: ones?.label ?? '未登录', ...(ones ? { profileKey: digest([ONES, ones.userId]) } : {}), ...(this.connectionNotes.ones ? { message: this.connectionNotes.ones } : {}) }, coho: { connected: !!coho && (coho.expiresAt === null || coho.expiresAt > Date.now()), label: coho?.label ?? '未登录', ...(this.connectionNotes.coho ? { message: this.connectionNotes.coho } : {}) }, teams: ones?.teams ?? [], writeEnabled: this.deps.worklogWritesEnabled === true, blockers: [...(this.deps.worklogWritesEnabled ? [] : ['工时提交未启用，当前仅开放预览。']), '执行修复通过 CLI 在已有项目创建聊天；媒体是本地引用，不能直接打开指定 session。', 'Bug 创建与内容修改尚未开放；状态更新按详情中的独立能力闸与字段配置校验，工时独立预览确认。'] }
  }
  async login(input: LoginInput, signal?: AbortSignal): Promise<Status> {
    await this.ensureReady()
    requireThat(input.site === 'ones' || input.site === 'coho', 'input', '登录站点无效。')
    const site = input.site; const epoch = ++this.epochs[site]
    this.unreadableSessions.delete(site)
    delete this.connectionNotes[site]
    this.invalidate()
    const account = text(input.account, 254).trim(); let password = text(input.password, 256)
    try {
      requireThat(await this.deps.protection(), 'secrets', '系统安全凭证存储不可用，未发送密码。')
      const session = site === 'ones' ? await loginOnes(this.onesTransport, account, password, input.httpAcknowledged, signal) : await loginCoho(this.cohoTransport, account, password, signal)
      await this.queue(site, async () => {
        requireThat(this.epochs[site] === epoch && !signal?.aborted, 'cancelled', '登录已取消或身份已切换。')
        const previous = await this.deps.vault.get(`session.${site}`)
        await this.deps.vault.set(`session.${site}`, JSON.stringify(session))
        if (this.epochs[site] !== epoch || signal?.aborted) {
          if (previous === null) await this.deps.vault.delete(`session.${site}`)
          else await this.deps.vault.set(`session.${site}`, previous)
          throw new AppError('cancelled', '登录已取消，未保留该次令牌。')
        }
        ++this.epochs[site]
        this.invalidate()
        if (site === 'ones') this.sessions.ones = session as OnesSession
        else this.sessions.coho = session as CohoSession
      })
      return this.status()
    } finally { password = ''; input.password = '' }
  }
  async logout(site: Site): Promise<Status> {
    await this.ensureReady()
    requireThat(site === 'ones' || site === 'coho', 'input', '站点无效。')
    ++this.epochs[site]; delete this.sessions[site]; this.invalidate()
    this.unreadableSessions.delete(site)
    delete this.connectionNotes[site]
    await this.queue(site, () => this.deps.vault.delete(`session.${site}`))
    return this.status()
  }
  private ones(team: string): OnesClient {
    const session = this.sessions.ones
    requireThat(session && session.expiresAt > Date.now() && !session.needsValidation, 'auth', '请先登录 ONES。')
    return new OnesClient(this.onesTransport, session, team)
  }
  private coho(): CohoClient {
    const session = this.sessions.coho
    requireThat(session && (session.expiresAt === null || session.expiresAt > Date.now()), 'auth', '请先登录 Coho，工时必须基于考勤。')
    return new CohoClient(this.cohoTransport, session)
  }
  private async authenticated<T>(site: Site, action: () => Promise<T>, session = this.sessions[site]): Promise<T> {
    const epoch = this.epochs[site]
    try { return await action() } catch (error) {
      if (error instanceof AppError && error.code === 'auth') {
        await this.queue(site, async () => {
          if (this.epochs[site] !== epoch || this.sessions[site] !== session) return
          ++this.epochs[site]
          delete this.sessions[site]
          this.unreadableSessions.delete(site)
          this.invalidate()
          await this.deps.vault.delete(`session.${site}`)
          this.connectionNotes[site] = '服务端确认登录已失效，请重新登录。'
        })
      }
      throw error
    }
  }
  async bugStatuses(team: string, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const statuses = await client.bugStatuses(signal)
      requireThat(identity === this.identity(), 'stale', '状态读取期间账号已变化，请重新读取。')
      return statuses
    })
  }
  async bugs(team: string, after = '', signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const bugs = await client.bugs(after, signal)
      requireThat(identity === this.identity(), 'stale', '缺陷读取期间账号已变化，请重新读取。')
      return bugs
    })
  }
  async projects(team: string, signal?: AbortSignal) {
    return this.taskOptions(team, client => client.projects(signal), signal)
  }
  async iterations(team: string, projectId: string, signal?: AbortSignal) {
    return this.taskOptions(team, client => client.iterations(projectId, signal), signal)
  }
  private async taskOptions(team: string, read: (client: OnesClient) => Promise<Option[]>, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones', async () => {
      const identity = this.identity(), client = this.ones(team)
      await client.assertIdentity(signal)
      const options = await read(client)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化，请重新读取。')
      return options
    })
  }
  async tasks(team: string, after = '', signal?: AbortSignal, filter: TaskFilter = {}) {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones', async () => {
      const identity = this.identity(); const client = this.ones(team)
      await client.assertIdentity(signal)
      const tasks = await client.tasks(after, signal, filter)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化，请重新读取。')
      return tasks
    })
  }
  closeDetail(detailId?: string): void {
    if (detailId !== undefined && this.detail?.media.detailId !== detailId && this.detailRequest !== detailId) return
    this.detailEpoch++
    this.detailRequest = undefined
    this.detail?.media.dispose()
    this.detail = undefined
  }
  private registerContent(media: BugMediaStore, content: BugContent[]): void {
    media.allow(content.flatMap(block => block.kind === 'media' ? [block.resourceId] : []))
  }
  async bugDetail(team: string, taskId: string, signal?: AbortSignal, requestId?: string): Promise<BugDetail & {detailId:string}> {
    await this.ensureReady(); await this.ensureSession('ones')
    this.closeDetail()
    if (requestId !== undefined) this.detailRequest = id(requestId)
    const epoch = this.detailEpoch
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const task = await client.task(taskId,signal)
      await client.assertBug(task,signal)
      const reader = client.details()
      const content = await reader.content(task,signal)
      const comments = await reader.comments(taskId,undefined,signal)
      const attachments = await reader.attachments(taskId,undefined,signal)
      requireThat(identity === this.identity() && epoch === this.detailEpoch && !signal?.aborted,'stale','读取期间身份或详情已变化，请重新打开。')
      const media = new BugMediaStore(this.onesTransport,team,client.session.token)
      this.registerContent(media,content.content)
      comments.items.forEach(comment => this.registerContent(media,comment.content))
      media.allow(attachments.items.map(attachment=>attachment.id))
      const result = {detailId:media.detailId,task,...content,comments,attachments}
      assertDetailFits(result)
      this.detail = {team,taskId,identity,media,view:result}
      return result
    })
  }
  async projectFilter(team: string, localProject: Option | null, projects: Option[]) {
    await this.ensureReady(); await this.ensureSession('ones')
    const client = this.ones(team), identity = this.identity()
    requireThat(Array.isArray(projects) && projects.length <= 2000, 'input', '项目筛选范围过大。')
    const candidates = projects.map(p => ({ id: id(p.id), name: text(p.name, 500) }))
    requireThat(new Set(candidates.map(p => p.id)).size === candidates.length, 'input', '项目身份重复。')
    const bindings: ProjectMapping[] = []
    if (localProject) for (const project of candidates) {
      const saved = await this.deps.store.get(projectMappingKey(this.scope(client), project.id))
      if (saved) {
        const value = record(saved)
        requireThat(value.sourceProjectId === project.id && typeof value.targetProjectId === 'string', 'schema', '项目映射无效。')
        bindings.push({ sourceProjectId: project.id, targetProjectId: value.targetProjectId })
      }
    }
    requireThat(identity === this.identity(), 'stale', '账号已变化，请重新读取项目筛选。')
    return { localProject, project: filterProject(localProject, candidates, bindings) }
  }
  /// 本地缓存只绑定仍有效的登录身份；首屏不联网，所有远端动作另外鉴权。
  async repairCacheContext(team: string, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    const identity = this.identity(), client = this.ones(team)
    const check = () => {
      signal?.throwIfAborted()
      requireThat(identity === this.identity(), 'stale', '账号已变化，请重新读取执行记录。')
      this.ones(team)
    }
    return { scope: this.scope(client), check }
  }
  async repairListContext(team: string, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    const identity = this.identity(), client = this.ones(team)
    const check = () => {
      signal?.throwIfAborted()
      requireThat(identity === this.identity(), 'stale', '账号已变化，请重新读取执行记录。')
    }
    await client.assertIdentity(signal)
    const reader = await client.repairReader(signal)
    check()
    return {
      scope: this.scope(client), check,
      readTask: async (taskId: string) => {
        check()
        const task = await reader.task(taskId)
        check()
        return task
      },
      readPage: async (after: string) => {
        check()
        const page = await reader.page(after)
        check()
        return page
      }
    }
  }
  /// 状态业务上下文固定在当前详情，关闭或切身份立即撤销未发送确认。
  async transitionContext(detailId: string) {
    await this.ensureReady(); await this.ensureSession('ones')
    const detail = this.currentDetail(detailId), client = this.ones(detail.team)
    await client.assertIdentity()
    const check = () => { requireThat(this.currentDetail(detailId) === detail, 'stale', '详情或身份已变化，请重新打开。') }
    const task = await client.task(detail.taskId)
    check()
    requireThat(task.project.id === detail.view.task.project.id && task.issueType.id === detail.view.task.issueType.id, 'stale', 'Bug 项目或类型已变化，请重新打开。')
    detail.view = { ...detail.view, task }
    return { scope: this.scope(client), task, adapter: new OnesTransitions(this.onesTransport, client.session, detail.team), check }
  }
  async repairContext(detailId: string) {
    await this.ensureReady(); await this.ensureSession('ones')
    const detail = this.currentDetail(detailId)
    const client = this.ones(detail.team)
    await client.assertIdentity()
    requireThat(this.currentDetail(detailId) === detail, 'stale', '详情或账号已变化。')
    return { scope: this.scope(client), task: detail.view.task }
  }
  async collectRepair(detailId: string, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    const detail = this.currentDetail(detailId)
    const client = this.ones(detail.team)
    const check = () => {
      requireThat(!signal?.aborted && this.currentDetail(detailId) === detail, 'stale', '详情或账号已变化，已取消启动。')
    }
    await client.assertIdentity(signal)
    check()
    const task = await client.task(detail.taskId, signal)
    await client.assertBug(task, signal)
    requireThat(task.project.id === detail.view.task.project.id, 'stale', 'Bug 项目已变化，请刷新详情。')
    const reader = client.details(), body = await reader.content(task, signal)
    const comments = await allPages(await reader.comments(task.id, undefined, signal), before => reader.comments(task.id, before, signal))
    const attachments = await allPages(await reader.attachments(task.id, undefined, signal), before => reader.attachments(task.id, before, signal))
    check()
    const bug: CompleteBug = { task, ...body, comments, attachments }
    const media = new BugMediaStore(this.onesTransport, detail.team, client.session.token)
    try { media.allow(mediaIds(bug)) } catch (error) { media.dispose(); throw error }
    return {
      bug,
      read: async (resource: string, offset: number) => { check(); return media.read(media.detailId, resource, offset, signal) },
      validate: async () => {
        await client.assertIdentity(signal)
        const freshTask = await client.task(task.id, signal)
        const fresh = await reader.content(freshTask, signal)
        check()
        requireThat(JSON.stringify(freshTask) === JSON.stringify(task) && fresh.updatedAt === body.updatedAt, 'stale', 'Bug 收集期间已更新，请刷新后重试。')
      },
      check,
      dispose: () => media.dispose()
    }
  }
  private currentDetail(detailId: string) {
    const detail = this.detail
    requireThat(detail && detail.media.detailId === detailId && detail.identity === this.identity(),'stale','详情已变化，请重新打开。')
    this.ones(detail.team)
    return detail
  }
  async detailComments(detailId: string, before: number | undefined, signal?: AbortSignal): Promise<DetailPage<Discussion>> {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones',async()=>{
      const detail = this.currentDetail(detailId)
      const client = this.ones(detail.team)
      await client.assertIdentity(signal)
      const result = await client.details().comments(detail.taskId,before,signal)
      requireThat(this.currentDetail(detailId) === detail && !signal?.aborted,'stale','详情已变化。')
      const view = {...detail.view,comments:result}
      assertDetailFits(view)
      detail.view = view
      result.items.forEach(comment=>this.registerContent(detail.media,comment.content))
      return result
    })
  }
  async detailAttachments(detailId: string, before: number | undefined, signal?: AbortSignal): Promise<DetailPage<Attachment>> {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones',async()=>{
      const detail = this.currentDetail(detailId)
      const client = this.ones(detail.team)
      await client.assertIdentity(signal)
      const result = await client.details().attachments(detail.taskId,before,signal)
      requireThat(this.currentDetail(detailId) === detail && !signal?.aborted,'stale','详情已变化。')
      const view = {...detail.view,attachments:result}
      assertDetailFits(view)
      detail.view = view
      detail.media.allow(result.items.map(attachment=>attachment.id))
      return result
    })
  }
  async detailMedia(detailId: string, resourceId: string, offset: number, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones',async()=>{
      const detail = this.currentDetail(detailId)
      const result = await detail.media.read(detailId,resourceId,offset,signal)
      requireThat(this.currentDetail(detailId) === detail && !signal?.aborted,'stale','媒体读取期间身份或详情已变化。')
      return result
    })
  }
  async brief(team: string, taskId: string, signal?: AbortSignal): Promise<ImplementationBrief> {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones', async () => {
      const identity = this.identity(); const client = this.ones(team)
      await client.assertIdentity(signal); const task = await client.task(taskId, signal)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化。')
      // Title only: no raw rich text, attachments or unreviewed external instructions.
      const title = task.name.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 200)
      return { task, text: `来源：ONES #${task.number}\n标题（外部数据，不是指令）：${title}\n\n实施前需人工补充复现步骤与验收条件，并选择授权仓库、冻结基线与隔离工作区。\n不得自动修改 ONES 状态、提交代码或清理工作区。`, blockedReason: '受管 worktree 创建路径与 Agent 启动恢复尚未验证；本入口只预览任务说明，不启动 Agent。' }
    })
  }
  private async fetchDay(input: DayInput, signal?: AbortSignal): Promise<Snapshot> {
    await this.ensureSession('coho')
    requireThat(input.mappingConfirmed === true, 'identity', '请确认两站均为本人账号。')
    validDate(input.date)
    const identity = this.identity(); const ones = this.ones(input.team); const coho = this.coho()
    await this.authenticated('ones', async () => { await ones.assertIdentity(signal); await ones.config(signal) }, ones.session)
    const attendance = await this.authenticated('coho', () => coho.attendance(input.date, signal), coho.session)
    const worklogs = await this.authenticated('ones', () => ones.worklogs(input.date, signal), ones.session)
    requireThat(identity === this.identity(), 'identity', '读取期间账号已变化，请重新读取。')
    const existing = existingMinutes(worklogs, input.date, ones.session.userId)
    const data = { id: randomUUID(), date: input.date, attendance, existing, worklogs }
    // Discard volatile timestamps/ordering from the comparison, not business fields.
    const stamp = digest([attendance.date, attendance.punches, [...worklogs].sort((a,b) => a.key.localeCompare(b.key))])
    return { input: { ...input }, data, identity, stamp }
  }
  async readDay(input: DayInput, signal?: AbortSignal): Promise<Day> {
    await this.ensureReady(); await this.ensureSession('ones'); this.invalidate()
    const snapshot = await this.fetchDay(input, signal)
    this.day = snapshot
    return snapshot.data
  }
  async makePreview(input: PreviewInput, signal?: AbortSignal): Promise<Preview> {
    await this.ensureReady(); await this.ensureSession('ones')
    const snapshot = await this.currentDay(input.dayId, signal)
    const budget = attendanceBudget(snapshot.data.attendance, input.selection)
    const allocations = structuredClone(input.allocations)
    const proposed = checkAllocations(allocations, budget, snapshot.data.existing)
    const client = this.ones(snapshot.input.team)
    const rows: Preview['rows'] = [], creations = new Map<string, TaskCreationPlan>()
    const creator = new TaskCreator(client)
    for (const allocation of allocations) {
      if (allocation.newTask) {
        requireThat(!allocation.taskId && !creations.has(allocation.newTask.key), 'input', '新任务建议标识重复或同时关联了现有任务。')
        const plan = await creator.prepare(allocation.newTask, snapshot.input.date, signal)
        creations.set(allocation.newTask.key, plan)
        rows.push({ ...allocation, taskName: `将新建任务：${plan.payload.summary}`, creationDetails: plan.details })
      } else {
        const task = await client.task(id(allocation.taskId), signal)
        rows.push({ ...allocation, taskName: task.name })
      }
    }
    requireThat(this.day === snapshot && snapshot.identity === this.identity(), 'stale', '预览期间身份或考勤已变化。')
    const view: Preview = { id: randomUUID(), date: snapshot.input.date, budget, existing: snapshot.data.existing, proposed, remaining: budget - snapshot.data.existing - proposed, rows, expiresAt: Date.now() + 300000, basis: input.selection.mode === 'manual' ? 'manual' : 'punches' }
    this.preview = { view, snapshot, input: structuredClone(input), identity: this.identity(), creations }
    return view
  }
  async taskCreateOptions(team: string, projectId: string, date: string, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones')
    return this.authenticated('ones', async () => {
      const identity = this.identity(), client = this.ones(team)
      await client.assertIdentity(signal)
      const options = await new TaskCreator(client).options(projectId, date, signal)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化。')
      return options
    })
  }
  private async currentDay(dayId: string, signal?: AbortSignal): Promise<Snapshot> {
    const snapshot = this.day
    requireThat(snapshot && snapshot.data.id === dayId && snapshot.identity === this.identity(), 'stale', '考勤或身份已变化，请重新读取考勤并确认当日工时。')
    if (Date.now() - snapshot.data.attendance.fetchedAt >= 300000) {
      // AI analysis and manual review can outlive the read cache. Refresh evidence,
      // preserving the confirmed snapshot ID only when all business fields match.
      const fresh = await this.fetchDay(snapshot.input, signal)
      requireThat(this.day === snapshot && snapshot.identity === this.identity(), 'stale', '刷新期间账号或所选日期已变化，请重新读取考勤。')
      requireThat(fresh.stamp === snapshot.stamp, 'stale', '考勤或已登记工时已变化，请重新读取考勤、确认当日工时后重新计算；已有 AI 分析文件仍保留。')
      snapshot.data = { ...fresh.data, id: snapshot.data.id }
    }
    return snapshot
  }
  async aiHoursContext(input: Pick<PreviewInput, 'dayId' | 'selection'>, signal?: AbortSignal) {
    await this.ensureReady(); await this.ensureSession('ones'); await this.ensureSession('coho')
    const snapshot = await this.currentDay(input.dayId, signal)
    const budget = attendanceBudget(snapshot.data.attendance, input.selection)
    const scope = this.scope(this.ones(snapshot.input.team))
    const key = digest([scope, this.sessions.coho?.principal, snapshot.stamp, input.selection])
    return { key, team: snapshot.input.team, date: snapshot.input.date, budget, existing: snapshot.data.existing,
      remaining: budget - snapshot.data.existing, basis: input.selection.mode === 'manual' ? 'manual' : 'punches',
      check: () => requireThat(this.day === snapshot && snapshot.identity === this.identity(), 'stale', '账号或考勤已变化，请重新读取。') }
  }
  async submit(previewId: string, confirmed: boolean): Promise<{ count: number }> {
    await this.ensureReady(); await this.ensureSession('ones')
    requireThat(this.deps.worklogWritesEnabled === true, 'not_enabled', '当前未启用工时提交。')
    requireThat(!this.writeBusy, 'busy', '另一个写入尚未结束。'); this.writeBusy = true
    let count = 0, writeAttempted = false
    try {
      const confirmation = this.preview
      requireThat(confirmed === true && confirmation && confirmation.view.id === previewId && confirmation.identity === this.identity() && confirmation.view.expiresAt > Date.now(), 'stale', '请重新预览并确认工时。')
      this.preview = undefined // one-shot confirmation; errors never revive it
      const client = this.ones(confirmation.snapshot.input.team)
      const fresh = await this.fetchDay(confirmation.snapshot.input)
      requireThat(fresh.stamp === confirmation.snapshot.stamp && fresh.identity === confirmation.identity, 'stale', '考勤或已登记工时发生变化，请重新分配。')
      const budget = attendanceBudget(fresh.data.attendance, confirmation.input.selection)
      checkAllocations(confirmation.input.allocations, budget, fresh.data.existing)
      const scope = digest([ONES, client.team, client.session.userId])
      const ledger = this.ledger()
      assertNoPending(await ledger.load(), scope)
      const creator = new TaskCreator(client)
      for (const original of confirmation.creations.values()) {
        const current = await creator.prepare(original.draft, fresh.input.date)
        requireThat(taskCreationSignature(current.payload) === taskCreationSignature(original.payload), 'stale', '新任务实际创建内容发生变化，请重新预览确认。')
      }
      const writer = new Submission(ledger, worklogWriter(client))
      for (const allocation of confirmation.input.allocations) {
        requireThat(this.identity() === confirmation.identity, 'identity', '身份发生变化，后续提交已停止。')
        let rows = await client.worklogs(fresh.input.date)
        checkAllocations([allocation], budget, existingMinutes(rows, fresh.input.date, client.session.userId))
        let taskId = allocation.taskId
        if (allocation.newTask) {
          writeAttempted = true
          taskId = await creator.createOrRead(confirmation.creations.get(allocation.newTask.key)!, scope, fresh.input.date, this.deps.store, () => requireThat(this.identity() === confirmation.identity, 'identity', '账号已变化，创建已停止。'))
        }
        await client.task(taskId)
        if (allocation.newTask) {
          rows = await client.worklogs(fresh.input.date)
          checkAllocations([allocation], budget, existingMinutes(rows, fresh.input.date, client.session.userId))
        }
        const intent = { scope, date: fresh.input.date, task: taskId, owner: client.session.userId, hours: apiHours(allocation.minutes), startTime: startSeconds(fresh.input.date, allocation.start), description: allocation.description }
        requireThat(this.identity() === confirmation.identity, 'identity', '提交前账号已变化，未发送本笔写入。')
        writeAttempted = true
        await writer.add(intent, digest([previewId, count, intent]), rows); count++
      }
      this.invalidate()
      return { count }
    } catch (error) {
      this.preview = undefined
      if (writeAttempted) throw new AppError('worklog-partial', `本批已有 ${count} 笔完成回读，其余未完成或结果待核实；请先查看工时记录及待核对提交，勿整批重发。${error instanceof AppError ? error.message : ''}`)
      if (error instanceof AppError && ['auth', 'identity'].includes(error.code)) throw error
      throw new AppError('worklog-preflight', safeFailure(error).message)
    } finally { this.writeBusy = false }
  }
  private ledger(): Ledger {
    return {
      load: async () => parseReceipts(await this.deps.store.get('receipts')),
      save: rows => this.deps.store.set('receipts', structuredClone(rows))
    }
  }
  private scope(client: OnesClient): string { return digest([ONES, client.team, client.session.userId]) }
  async worklogs(team: string, date: string, signal?: AbortSignal): Promise<Worklog[]> {
    await this.ensureReady(); await this.ensureSession('ones')
    validDate(date)
    return this.authenticated('ones', async () => {
      const identity = this.identity()
      const client = this.ones(team)
      await client.assertIdentity(signal)
      const rows = await client.worklogs(date, signal)
      existingMinutes(rows, date, client.session.userId)
      requireThat(identity === this.identity(), 'stale', '读取期间账号已变化。')
      return rows
    })
  }
  async pending(team: string): Promise<PendingWrite[]> {
    await this.ensureReady(); await this.ensureSession('ones')
    const client = this.ones(team)
    return (await this.ledger().load()).filter(row => row.scope === this.scope(client) && row.state !== 'verified').map(row => ({
      id: row.id, kind: row.kind, date: row.intent.date, minutes: row.intent.hours * 60 / 100000,
      state: row.state as 'submitting' | 'unknown', hasKey: !!row.key
    }))
  }
  async previewRecovery(team: string, receiptId: string, signal?: AbortSignal): Promise<RecoveryPreview> {
    await this.ensureReady(); await this.ensureSession('ones')
    requireThat(!this.writeBusy, 'busy', '写入或核对仍在进行。')
    this.recovery = undefined
    const identity = this.identity()
    const client = this.ones(team)
    const receipt = (await this.ledger().load()).find(row => row.id === receiptId && row.scope === this.scope(client) && row.state !== 'verified')
    requireThat(receipt, 'identity', '当前身份没有这条待核实操作。')
    const rows = await this.worklogs(team, receipt.intent.date, signal)
    const matches = receiptCandidates(receipt, rows)
    requireThat(identity === this.identity(), 'stale', '核对期间账号已变化。')
    if (matches.length !== 1) return { id: null, receiptId, matchCount: matches.length, candidate: null, message: matches.length ? '发现多个符合项，无法唯一归属；继续阻断，不自动重试。' : '没有找到完整匹配项，不代表写入失败；继续阻断，不自动重试。' }
    const candidate = matches[0]
    const view = { id: randomUUID(), receiptId, team, identity, key: candidate.key, stamp: digest(rows), expiresAt: Date.now() + 300000 }
    this.recovery = view
    return { id: view.id, receiptId, matchCount: 1, candidate, message: '请核对该记录确属本次操作。确认只更新本地核对状态，不新增或修改 ONES 工时。' }
  }
  async confirmRecovery(previewId: string, confirmed: boolean): Promise<{ verified: true }> {
    await this.ensureReady(); await this.ensureSession('ones')
    requireThat(confirmed === true && !this.writeBusy, 'confirmation', '请确认匹配记录属于本次操作。')
    const view = this.recovery
    requireThat(view && view.id === previewId && view.identity === this.identity() && view.expiresAt > Date.now(), 'stale', '核对预览已失效，请重新回读。')
    this.recovery = undefined
    this.writeBusy = true
    try {
      const client = this.ones(view.team)
      const ledger = this.ledger()
      const receipts = await ledger.load()
      const receipt = receipts.find(row => row.id === view.receiptId && row.scope === this.scope(client) && row.state !== 'verified')
      requireThat(receipt, 'identity', '待核实操作已变化。')
      const rows = await this.worklogs(view.team, receipt.intent.date)
      const matches = receiptCandidates(receipt, rows)
      requireThat(view.identity === this.identity() && digest(rows) === view.stamp && matches.length === 1 && matches[0].key === view.key, 'conflict', '记录或身份已变化，未解除阻断。')
      receipt.key = view.key
      receipt.state = 'verified'
      await ledger.save(receipts)
      this.invalidate()
      return { verified: true }
    } finally { this.writeBusy = false }
  }
  async describe(input: { team: string; date: string; key: string; description: string; confirmed: boolean }) {
    await this.ensureReady(); await this.ensureSession('ones')
    requireThat(this.deps.worklogWritesEnabled === true, 'not_enabled', '当前未启用工时描述更新。')
    requireThat(input.confirmed === true && !this.writeBusy, 'confirmation', '请确认更新且等待其它写入结束。')
    validateDescription(input.description)
    this.writeBusy = true
    try {
      const identity = this.identity()
      const client = this.ones(input.team)
      validDate(input.date)
      await client.assertIdentity()
      await client.config()
      const ledger = this.ledger()
      const receipts = await ledger.load()
      assertNoPending(receipts, this.scope(client))
      requireThat(receipts.length < 1000, 'ledger', '本地操作记录已达到上限。')
      const writer = worklogWriter(client)
      const original = await writer.get(text(input.key, 150))
      requireThat(original.owner === client.session.userId && original.type === 'recorded', 'identity', '不是本人登记工时。')
      const before = await client.worklogs(input.date)
      existingMinutes(before, input.date, client.session.userId)
      requireThat(before.filter(row => row.key === original.key).length === 1, 'identity', '原日期无法唯一定位该工时。')
      if (original.description === input.description) return { key: original.key }
      requireThat(original.description.trim() === '', 'conflict', '原记录已有不同描述，禁止覆盖。')
      const latest = await writer.get(original.key)
      requireThat(JSON.stringify(latest) === JSON.stringify(original), 'conflict', '原记录已变化，请重新确认。')
      const intent = { scope: this.scope(client), date: input.date, task: original.task, owner: original.owner, hours: original.hours, startTime: original.startTime, description: input.description }
      const receipt = createReceipt(intent, digest([randomUUID(), intent]), before, 'describe', original.key)
      receipts.push(receipt)
      await ledger.save(receipts)
      requireThat(identity === this.identity(), 'identity', '更新前账号已变化，未发送描述更新。')
      await writer.describe(original.key, input.description)
      const after = await client.worklogs(input.date)
      const amended = await writer.get(original.key)
      requireThat(identity === this.identity() && receiptCandidates(receipt, after).length === 1 && protectedDayHash([amended], original.key) === protectedDayHash([original], original.key) && amended.description === input.description, 'readback', '更新后保护字段不一致，请核实。')
      receipt.state = 'verified'
      await ledger.save(receipts)
      this.invalidate()
      return { key: original.key }
    } finally { this.writeBusy = false }
  }
  async saveDraft(draft: Draft): Promise<{ saved: true }> {
    await this.ensureReady()
    requireThat(this.sessions.ones && this.sessions.coho, 'identity', '请先登录两站，草稿需要绑定本人身份。')
    validDate(draft.date); requireThat(Array.isArray(draft.allocations) && draft.allocations.length <= 20, 'input', '草稿最多 20 笔。')
    for (const row of draft.allocations) { validateAllocationTarget(row); apiHours(row.minutes); text(row.description, 2000) }
    await this.deps.store.set('draft', { owner: digest([this.sessions.ones.userId, this.sessions.coho.principal]), value: draft })
    return { saved: true }
  }
  async loadDraft(): Promise<Draft | null> {
    await this.ensureReady()
    if (!this.sessions.ones || !this.sessions.coho) return null
    const stored = await this.deps.store.get('draft'); if (stored === null) return null
    const raw = record(stored)
    if (raw.owner !== digest([this.sessions.ones.userId, this.sessions.coho.principal])) return null
    this.invalidate() // restored data never carries confirmation or attendance authority
    const value = record(raw.value); validDate(value.date)
    requireThat(Array.isArray(value.allocations) && value.allocations.length <= 20, 'schema', '本机草稿格式无效。')
    for (const entry of value.allocations) { const row = record(entry); validateAllocationTarget(row); apiHours(row.minutes as number); text(row.start, 5); text(row.description, 2000) }
    return value as unknown as Draft
  }
}
