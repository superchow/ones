import type { Allocation, AttendanceSelection, Preview, Task, TaskPage } from '../domain/model.ts'
import { attendanceBudget, defaultPunchSelection } from '../domain/attendance.ts'
import { safeFailure } from '../domain/model.ts'
import { proposeGitHours } from '../domain/git-hours.ts'
import { GitHoursView } from './git-hours.ts'
import type { Day, Draft } from '../protocol.ts'
import type { WorkbenchUI } from './panel.ts'
import {
  UIError,
  button,
  card,
  check,
  hours,
  input,
  message,
  notice,
  request,
  row,
  select,
  stack,
  text
} from './dom.ts'

export class HoursView {
  date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
  preview: Preview | null = null
  confirmed = false
  private mapping = false
  private day: Day | null = null
  private tasks: Task[] = []
  private next: string | null = null
  private cursors = new Set<string>()
  private selected = ''
  private startPunch = ''
  private endPunch = ''
  private punchesConfirmed = false
  private manual = false
  private manualHours = ''
  private start = '09:00'
  private minutes = ''
  private description = ''
  private allocations: Allocation[] = []
  private onlyMine = true
  private taskLoaded = false
  private unmatchedNote = ''
  private git: GitHoursView
  constructor(private app: WorkbenchUI) {
    this.git = new GitHoursView(app, () => this.date)
  }
  dispose(): void { this.git.dispose() }
  projectsChanged(): void {
    this.git.projectsChanged()
    // Re-render so the Git propose action picks up newly enabled paths.
    if (!this.app.busy) this.app.render()
  }
  preferences() { return { project: '', iteration: '', onlyMine: this.onlyMine } }
  gitPreferences() { return this.git.preferences() }
  restoreGit(value: { emails: string; allAuthors: boolean }): void { this.git.restorePreferences(value) }
  restorePreferences(value: { project: string; iteration: string; onlyMine: boolean }): void {
    this.onlyMine = value.onlyMine
  }
  clearDay(): void {
    this.day = null
    this.preview = null
    this.confirmed = false
    this.startPunch = ''
    this.endPunch = ''
    this.punchesConfirmed = false
    this.manual = false
    this.manualHours = ''
    this.unmatchedNote = ''
  }
  clear(): void {
    this.clearDay()
    this.tasks = []
    this.next = null
    this.cursors.clear()
    this.selected = ''
    this.allocations = []
    this.mapping = false
    this.description = ''
    this.onlyMine = true
    this.taskLoaded = false
    this.git.clear()
  }
  changeDate(value: string): void {
    this.date = value
    this.git.clear()
    this.allocations = []
    this.unmatchedNote = ''
    this.app.invalidateDay()
    this.app.render()
  }
  private selection(): AttendanceSelection {
    if (this.manual) {
      const value = this.manualHours.trim() ? Number(this.manualHours) * 60 : NaN
      const minutes = Math.abs(value - Math.round(value)) < 1e-7 ? Math.round(value) : NaN
      return { mode: 'manual', minutes, confirmed: this.punchesConfirmed }
    }
    return { start: Number(this.startPunch), end: Number(this.endPunch), confirmed: this.punchesConfirmed }
  }
  private budget(): { minutes: number | null; reason: string } {
    if (!this.day) return { minutes: null, reason: '请先读取当日考勤与已有工时。' }
    if (!this.manual && (this.startPunch === '' || this.endPunch === '')) return { minutes: null, reason: '请选择上班和下班打卡记录；缺卡时可切换为手动输入当日工时。' }
    if (!this.punchesConfirmed) return { minutes: null, reason: this.manual ? '请填写当日工作总时长，并勾选手动工时确认。' : '请核对已选打卡，并勾选考勤确认。' }
    try {
      return { minutes: attendanceBudget(this.day.attendance, this.selection()), reason: '' }
    } catch (error) {
      return { minutes: null, reason: safeFailure(error).message }
    }
  }
  private async loadTaskPages(signal?: AbortSignal): Promise<Task[]> {
    const items: Task[] = []
    const cursors = new Set<string>()
    let after = ''
    for (let page = 0; page < 20; page++) {
      const result = await request<TaskPage>('tasks.list', { team: this.app.team, after, filter: { onlyMine: this.onlyMine } }, signal)
      if (
        new Set(result.items.map(task => task.id)).size !== result.items.length ||
        result.items.some(task => items.some(old => old.id === task.id)) ||
        (result.nextCursor !== null && cursors.has(result.nextCursor))
      ) throw new UIError('任务分页重复，列表不完整，请重新读取。')
      items.push(...result.items)
      if (!result.nextCursor) return items
      cursors.add(result.nextCursor)
      after = result.nextCursor
    }
    throw new UIError('本人工作项过多，未能完整读取；请缩小范围或稍后重试。')
  }
  private loadDay(): void {
    this.app.invalidateDay()
    void this.app.run(
      (signal) =>
        request<Day>(
          'day.read',
          { team: this.app.team, date: this.date, mappingConfirmed: this.mapping },
          signal
        ),
      (day) => {
        this.day = day
        const selected = defaultPunchSelection(day.attendance)
        this.startPunch = selected ? String(selected.start) : ''
        this.endPunch = selected ? String(selected.end) : ''
        this.punchesConfirmed = false
        if (selected) this.start = day.attendance.punches[selected.start]!.time
        this.unmatchedNote = ''
      }
    )
  }
  private proposeFromGit(): void {
    this.app.invalidate()
    const budget = this.budget()
    if (!this.day || budget.minutes === null) {
      this.app.error = budget.reason
      this.app.render()
      return
    }
    const remaining = budget.minutes - this.day.existing
    if (remaining < 3) {
      this.app.error = remaining <= 0 ? '当日已登记工时已达到考勤额度，无剩余可填工时。' : '剩余额度不足 3 分钟，无法生成可提交工时。'
      this.app.render()
      return
    }
    void this.app.run(
      async (signal) => {
        if (!this.app.gitProjects.loaded) await this.app.gitProjects.load()
        if (!this.git.ready) throw new UIError('请在 Git 关联页读取并启用至少一个本地项目，再重新计算。')
        if (!this.git.hasCurrentReport) await this.git.readLogs(signal)
        const commits = this.git.selectedCommits()
        if (!commits.length) throw new UIError('当前没有选中的 Git 提交，请展开本地 Git 整理，核对作者范围并读取、勾选提交。')
        const tasks = await this.loadTaskPages(signal)
        return { commits, tasks, remaining }
      },
      ({ commits, tasks, remaining }) => {
        this.tasks = tasks
        this.taskLoaded = true
        this.next = null
        this.cursors.clear()
        const proposal = proposeGitHours({
          commits,
          tasks,
          remainingMinutes: remaining,
          start: this.start
        })
        this.allocations = proposal.allocations
        this.selected = proposal.allocations[0]?.taskId ?? ''
        const notes: string[] = []
        if (proposal.missingNumbers.length) notes.push(`未匹配到本人工作项的编号：${proposal.missingNumbers.map(n => `#${n}`).join('、')}`)
        if (proposal.unmatchedCommits.length) notes.push(`${proposal.unmatchedCommits.length} 条提交未含可匹配的 #编号，未自动分配。`)
        if (!proposal.allocations.length) notes.push('未能根据 Git 提交自动生成工时；请确认提交标题含任务/Bug 编号，或手动补充。')
        this.unmatchedNote = notes.join(' ')
        this.app.info = proposal.allocations.length
          ? `已按剩余额度 ${hours(remaining)} 生成 ${proposal.allocations.length} 笔待确认工时；核对后预览，确认后才写入 ONES。`
          : ''
        if (!proposal.allocations.length && notes.length) this.app.error = notes.join(' ')
      }
    )
  }
  private add(): void {
    this.app.invalidate()
    if (!this.selected || !this.description.trim()) {
      this.app.error = '请选择任务并填写描述。'
      this.app.render()
      return
    }
    const minutes = Number(this.minutes)
    if (!Number.isSafeInteger(minutes) || minutes <= 0) {
      this.app.error = '请输入正整数分钟。'
      this.app.render()
      return
    }
    this.allocations.push({
      taskId: this.selected,
      start: this.start,
      minutes,
      description: this.description
    })
    this.description = ''
    this.app.error = ''
    this.app.render()
  }
  private makePreview(): void {
    const day = this.day
    if (!day) return
    this.app.invalidate()
    void this.app.run(
      (signal) =>
        request<Preview>(
          'hours.preview',
          {
            dayId: day.id,
            selection: this.selection(),
            allocations: this.allocations
          },
          signal
        ),
      (value) => {
        this.preview = value
      }
    )
  }
  private save(): void {
    void this.app.run(
      (signal) => request('draft.save', { date: this.date, allocations: this.allocations }, signal),
      () => {
        this.app.info = '已保存本机草稿；重新打开后必须重读考勤。'
      }
    )
  }
  private restore(): void {
    void this.app.run(
      (signal) => request<Draft | null>('draft.load', undefined, signal),
      (value) => {
        this.app.invalidateDay()
        if (value) {
          this.date = value.date
          this.allocations = value.allocations
          this.app.info = '草稿已恢复，请重新读取考勤并核对。'
        } else this.app.info = '当前身份没有草稿。'
      }
    )
  }
  private loadMoreTasks(): void {
    if (this.next === null) return
    const after = this.next
    void this.app.run(
      (signal) => request<TaskPage>('tasks.list', { team: this.app.team, after, filter: { onlyMine: this.onlyMine } }, signal),
      (page) => {
        if (
          new Set(page.items.map(t => t.id)).size !== page.items.length ||
          page.items.some(t => this.tasks.some(old => old.id === t.id)) ||
          (page.nextCursor !== null && this.cursors.has(page.nextCursor))
        ) {
          this.next = null
          this.app.error = '任务分页重复，列表不完整，请重新读取。'
          return
        }
        this.tasks.push(...page.items)
        this.next = page.nextCursor
        if (this.next) this.cursors.add(this.next)
      }
    )
  }
  render(): HTMLElement {
    const app = this.app,
      authenticated = app.status?.ones.connected && app.status?.coho.connected
    const assessment = this.budget()
    const budget = assessment.minutes
    const remaining = this.day && budget !== null ? budget - this.day.existing : null
    const content = stack(
      notice('先读取考勤确认当日额度与已填工时，再按 Git 当日提交自动整理任务/Bug 工时；预览确认后才写入 ONES。'),
      app.teamSelect(),
      input('业务日期（YYYY-MM-DD）', this.date, (v) => this.changeDate(v), { disabled: app.busy }),
      check(
        '已确认 ONES 与 Coho 均为本人账号',
        this.mapping,
        (v) => {
          this.mapping = v
          app.invalidateDay()
          app.render()
        },
        app.busy
      ),
      button(
        '读取考勤与已有工时',
        () => this.loadDay(),
        app.busy || !authenticated || !this.mapping || !app.team
      )
    )
    if (this.day) {
      const choices = [
        { value: '', label: '请选择实际记录' },
        ...this.day.attendance.punches.map((p, index) => ({
          value: String(index),
          label: `${p.date} ${p.time}${p.isNext ? ' · 跨日' : ''}${p.outFence !== false ? ' · 外勤标志待核对' : ''}`
        }))
      ]
      const choose = (which: 'start' | 'end', value: string) => {
        if (which === 'start') this.startPunch = value
        else this.endPunch = value
        this.punchesConfirmed = false
        app.invalidate()
        app.render()
      }
      content.append(
        card(
          '核对考勤依据',
          text(`${this.day.attendance.date} · ${this.day.attendance.punches.length} 条打卡`),
          check('手动输入当日工时', this.manual, value => {
            this.manual = value
            this.punchesConfirmed = false
            app.invalidate()
            app.render()
          }, app.busy),
          this.manual ? stack(
            input('当日工作总时长（小时）', this.manualHours, value => {
              this.manualHours = value
              this.punchesConfirmed = false
              app.invalidate()
              app.render()
            }, { type: 'number', disabled: app.busy }),
            text('填写当天实际工作总时长（含已登记部分），系统会扣除 ONES 已填工时；仅用于本次分配，不修改原始打卡。', true)
          ) : row(
            select('上班打卡', this.startPunch, choices, (v) => choose('start', v), app.busy),
            select('下班打卡', this.endPunch, choices, (v) => choose('end', v), app.busy)
          ),
          check(
            this.manual ? '已确认手动输入的是本人当日实际工作总时长' : '已核对本人当日上下班记录，无缺卡、跨日或外勤异常',
            this.punchesConfirmed,
            (v) => {
              this.punchesConfirmed = v
              app.invalidate()
              app.render()
            },
            app.busy
          ),
          this.manual ? text('额度依据：本人手动确认。', true) : text('两条明确的同日记录自动选中，核对后确认；缺卡时可手动输入当日工时。', true),
          text('当日已登记：' + hours(this.day.existing)),
          budget !== null ? text(`当日工作额度 ${hours(budget)} · 剩余可填 ${hours(Math.max(0, budget - this.day.existing))}`) : notice(assessment.reason)
        ),
        stack(button(
          '根据 Git 整理并计算工时',
          () => this.proposeFromGit(),
          app.busy
        ),
        remaining !== null && remaining < 3 ? notice(remaining <= 0 ? '当日已登记工时已达到考勤额度，无剩余可填工时。' : '剩余额度不足 3 分钟，无法生成可提交工时。') : null,
        !this.git.ready ? row(
          notice(app.gitProjects.loaded ? '尚未启用 Git 关联项目，请先配置。' : 'Git 关联尚未读取成功，点击计算会重试读取。'),
          button('管理 Git 关联', () => app.changeTab('git'), app.busy)
        ) : null)
      )
    } else content.append(notice('尚无有效考勤依据；未读取成功前，不能确认当日额度或提交工时。'))
    content.append(this.git.render())
    if (this.unmatchedNote) content.append(notice(this.unmatchedNote))
    if (this.allocations.length)
      content.append(
        card(
          '待确认工时',
          text(remaining !== null ? `按剩余额度整理，合计 ${hours(this.allocations.reduce((sum, item) => sum + item.minutes, 0))}；可修改后预览。` : '请先核对考勤额度。', true),
          ...this.allocations.map((item, index) => {
            const task = this.tasks.find((t) => t.id === item.taskId)
            return stack(
              text(task ? `[${task.issueType.name}] #${task.number} ${task.name}` : `工作项 ${item.taskId}`),
              row(
                input(
                  `开始时间 #${index + 1}`,
                  item.start,
                  (v) => {
                    item.start = v
                    app.invalidate()
                  },
                  { disabled: app.busy }
                ),
                input(
                  `时长（分钟） #${index + 1}`,
                  String(item.minutes),
                  (v) => {
                    const minutes = Number(v)
                    if (Number.isSafeInteger(minutes) && minutes > 0) item.minutes = minutes
                    app.invalidate()
                  },
                  { disabled: app.busy }
                )
              ),
              input(
                `工作描述 #${index + 1}`,
                item.description,
                (v) => {
                  item.description = v
                  app.invalidate()
                },
                { multiline: true, disabled: app.busy }
              ),
              button(
                '移除此项',
                () => {
                  this.allocations.splice(index, 1)
                  app.invalidate()
                  app.render()
                },
                app.busy
              )
            )
          })
        )
      )
    if (this.taskLoaded)
      content.append(
        card(
          '手动补充',
          text(`已读取本人 ${this.tasks.length} 项任务/需求/Bug；用于补充分配未自动匹配的提交。`, true),
          this.next ? button('加载更多工作项', () => this.loadMoreTasks(), app.busy) : null,
          select(
            '目标任务 / Bug',
            this.selected,
            [
              { value: '', label: '选择工作项' },
              ...this.tasks.map((t) => ({ value: t.id, label: `[${t.issueType.name}] #${t.number} ${t.name} · ${t.project.name}${t.sprint ? ' / ' + t.sprint.name : ''}` }))
            ],
            (v) => {
              this.selected = v
              app.render()
            },
            app.busy
          ),
          row(
            input('开始时间', this.start, (v) => { this.start = v }, { disabled: app.busy }),
            input('时长（分钟）', this.minutes, (v) => { this.minutes = v }, { disabled: app.busy })
          ),
          input('工作描述（必填）', this.description, (v) => { this.description = v }, { multiline: true, disabled: app.busy }),
          button('加入分配草稿', () => this.add(), app.busy || this.allocations.length >= 20)
        )
      )
    content.append(
      row(
        button('保存草稿', () => this.save(), app.busy || !authenticated || !this.allocations.length),
        button('恢复草稿', () => this.restore(), app.busy || !authenticated),
        button(
          '校验并预览',
          () => this.makePreview(),
          app.busy || budget === null || !this.allocations.length
        )
      )
    )
    const preview = this.preview
    if (preview)
      content.append(
        card(
          '提交预览',
          text('业务日期：' + preview.date),
          text(preview.basis === 'manual' ? '额度依据：手动确认当日工作总时长' : '额度依据：考勤打卡折算'),
          text(
            `考勤额度 ${hours(preview.budget)} · 已有 ${hours(preview.existing)} · 本次 ${hours(preview.proposed)} · 剩余 ${hours(preview.remaining)}`
          ),
          ...preview.rows.map((item) =>
            text(`${item.taskName}｜${item.start}｜${hours(item.minutes)}｜${item.description}`)
          ),
          check(
            '我确认上述任务、原日期、时长和每笔描述',
            this.confirmed,
            (v) => {
              this.confirmed = v
              app.render()
            },
            app.busy
          ),
          button(
            '确认提交到 ONES',
            () =>
              app.run(
                async (signal) => {
                  try { return { value: await request<{ count: number }>(
                    'hours.submit',
                    { previewId: preview.id, confirmed: this.confirmed },
                    signal
                  ) } } catch (error) { return { error: message(error) } }
                },
                (value) => {
                  app.invalidateDay()
                  this.allocations = []
                  this.unmatchedNote = ''
                  if (value.value) app.info = `已逐笔回读 ${value.value.count} 笔工时。`
                  else app.error = `${value.error} 请先在工时记录中核对，再重新读取考勤并分配未登记部分；本批草稿已清空，避免重复提交。`
                }
              ),
            app.busy || !app.status?.writeEnabled || !this.confirmed
          )
        )
      )
    content.append(notice(app.status?.writeEnabled ? '读取 Git 和自动整理不会提交工时；只有校验预览并确认后才逐笔写入 ONES。' : '工时提交未启用，目前可读取、整理和预览。'))
    return content
  }
}
