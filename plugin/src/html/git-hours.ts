import type { GitCommit, GitReport } from '../local-git.ts'
import type { WorkbenchUI } from './panel.ts'
import { arrowIcon, button, check, el, input, notice, request, row, stack, text } from './dom.ts'

export class GitHoursView {
  private root?: HTMLElement
  private emails = ''
  private allAuthors = false
  private report: GitReport | null = null
  private selected = new Set<string>()
  private signature = ''
  private expanded = false
  constructor(private app: WorkbenchUI, private date: () => string) {}
  preferences() { return { emails: this.emails, allAuthors: this.allAuthors } }
  restorePreferences(value: { emails: string; allAuthors: boolean }): void { this.emails = value.emails; this.allAuthors = value.allAuthors; this.clear() }
  private get paths(): string[] { return this.app.gitProjects.paths }
  get ready(): boolean { return this.app.gitProjects.loaded && this.paths.length > 0 }
  clear(): void { this.report = null; this.selected.clear(); this.signature = '' }
  projectsChanged(): void {
    this.clear()
    const old = this.root
    if (old?.isConnected) old.replaceWith(this.render())
  }
  dispose(): void { this.root = undefined }
  private key(): string { return JSON.stringify([this.date(), this.paths, this.emails, this.allAuthors]) }
  get hasCurrentReport(): boolean { return this.report !== null && this.signature === this.key() }
  selectedCommits(): GitCommit[] {
    if (!this.report || !this.hasCurrentReport) return []
    return this.report.commits.filter(commit => this.selected.has(commit.hash))
  }
  async readLogs(signal?: AbortSignal): Promise<GitReport> {
    this.clear()
    const signature = this.key()
    const report = await request<GitReport>('git.read', { paths: [...this.paths], date: this.date(), emails: this.emails, allAuthors: this.allAuthors }, signal)
    this.signature = signature
    this.report = report
    this.selected = new Set(report.commits.map(commit => commit.hash))
    return report
  }
  private read(): void {
    void this.app.run(signal => this.readLogs(signal), () => { this.expanded = true })
  }
  render(): HTMLElement {
    const app = this.app
    const summary = app.gitProjects.loaded
      ? `已关联 ${app.gitProjects.count} 个项目 · 本次读取 ${this.paths.length} 个${this.report ? ` · 去重后 ${this.report.commits.length} 条提交` : ''}`
      : '项目关联尚未读取成功，请到 Git 关联页刷新。'
    const toggle = button('', () => { this.expanded = !this.expanded; app.render() }, app.busy)
    toggle.classList.add('status-toggle')
    toggle.append(arrowIcon('filter-arrow'))
    toggle.setAttribute('aria-label', this.expanded ? '收起本地 Git 整理' : '展开本地 Git 整理')
    toggle.setAttribute('aria-expanded', String(this.expanded))
    const header = row(el('h2', '', '从本地 Git 整理工作内容'), toggle)
    header.style.justifyContent = 'space-between'
    const content = el('section', 'card stack', header, text(summary, true))
    if (!this.expanded) {
      this.root = content
      return content
    }
    content.append(
      text('按业务日期（北京时间）读取已启用关联项目的 Git 日志，排除合并提交，相同提交只计一次。可勾选提交后用于自动计算工时。', true),
      button('管理 Git 关联', () => app.changeTab('git'), app.busy),
      ...this.paths.map(path => text(path, true)),
      input('本人 Git 作者邮箱（可填多个，逗号分隔；留空使用各仓库 user.email）', this.emails, value => { this.emails = value; app.remember() }, { disabled: app.busy || this.allAuthors }),
      check('包含所有作者（需要自行剔除他人的工作）', this.allAuthors, value => { this.allAuthors = value; this.clear(); app.render() }, app.busy),
      button('读取关联项目 Git 日志', () => this.read(), app.busy || !this.paths.length)
    )
    const report = this.report
    if (report) {
      content.append(text(`${report.date} · 去重后 ${report.commits.length} 条提交`))
      for (const repo of report.repositories) content.append(repo.error
        ? notice(`${repo.path}：${repo.error}`, true)
        : text(`${repo.path} · ${repo.count} 条${repo.truncated ? '（超过 2000 条读取上限，结果不完整）' : ''}`))
      if (report.commits.length) {
        content.append(row(
          button('全选提交', () => { this.selected = new Set(report.commits.map(c => c.hash)); app.render() }, app.busy),
          button('清空提交选择', () => { this.selected.clear(); app.render() }, app.busy)
        ))
        const list = stack(...report.commits.map(commit => check(
          `${commit.repository.split(/[/\\]/).pop()} · ${commit.subject} · ${commit.author} · ${commit.hash.slice(0, 8)}`,
          this.selected.has(commit.hash), value => { if (value) this.selected.add(commit.hash); else this.selected.delete(commit.hash); app.render() }, app.busy
        )))
        list.style.maxHeight = '320px'; list.style.overflowY = 'auto'
        content.append(list)
      } else content.append(notice('当前日期和作者范围没有匹配提交，可调整范围后重读。'))
      content.append(text('提交标题中的 #编号 用于匹配本人任务与 Bug；时长按考勤剩余额度与提交权重计算，确认预览后才会写入 ONES。', true))
    }
    this.root = content
    return content
  }
}
