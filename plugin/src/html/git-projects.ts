import type { GitProjects, GitProjectsChange } from '../git-projects.ts'
import type { FolderSelection } from '../native-folder-picker.ts'
import type { WorkbenchUI } from './panel.ts'
import { button, card, check, input, message, notice, request, row, text } from './dom.ts'

export class GitProjectsView {
  private data: GitProjects = { version: 1, revision: 0, projects: [] }
  loaded = false
  private loading = false
  private loadRequest?: Promise<void>
  private saving = false
  private mutation: Promise<boolean> = Promise.resolve(true)
  private picking = false
  private error = ''
  private info = ''
  private manualPaths = ''
  private root?: HTMLElement
  private pickerController?: AbortController
  private disposed = false
  constructor(private app: WorkbenchUI) {}
  get paths(): string[] { return this.loaded ? this.data.projects.filter(p => p.enabled).map(p => p.path) : [] }
  get count(): number { return this.data.projects.length }
  private refresh(): void {
    const old = this.root
    if (!this.disposed && old?.isConnected) old.replaceWith(this.render())
  }
  private accept(value: GitProjects): void {
    if (this.disposed) return
    this.data = value; this.loaded = true
    this.app.hours.projectsChanged()
  }
  load(): Promise<void> {
    if (this.loadRequest) return this.loadRequest
    this.loadRequest = this.readProjects().finally(() => { this.loadRequest = undefined })
    return this.loadRequest
  }
  private async readProjects(): Promise<void> {
    if (this.saving || this.disposed) return
    this.loading = true; this.error = ''; this.refresh()
    try { this.accept(await request<GitProjects>('git.projects.load', {})) }
    catch (error) { this.error = message(error) }
    finally { this.loading = false; this.refresh() }
  }
  private save(change: GitProjectsChange): Promise<boolean> {
    // A native selection may return while a manual save is finishing. Queue it
    // rather than losing the chosen paths; the server still checks revisions.
    const pending = this.mutation.then(() => this.performSave({ ...change, revision: this.data.revision }))
    this.mutation = pending
    return pending
  }
  private async performSave(change: GitProjectsChange): Promise<boolean> {
    if (!this.loaded || this.disposed) return false
    this.saving = true; this.error = ''; this.info = ''; this.refresh()
    try {
      this.accept(await request<GitProjects>('git.projects.update', change))
      this.info = '关联已自动保存，下次打开会恢复。'
      return true
    } catch (error) { this.error = message(error); return false }
    finally { this.saving = false; this.refresh() }
  }
  private async pick(): Promise<void> {
    if (!this.loaded || this.picking || this.saving) return
    const controller = new AbortController()
    this.pickerController = controller; this.picking = true; this.error = ''; this.info = ''; this.refresh()
    try {
      const result = await request<FolderSelection>('git.pickFolders', {}, controller.signal)
      if (!result.cancelled && !this.disposed) await this.save({ revision: this.data.revision, action: 'add', paths: result.paths })
    } catch (error) { if (!controller.signal.aborted) this.error = `${message(error)} 可在下方手动录入路径。` }
    finally { this.picking = false; this.pickerController = undefined; this.refresh() }
  }
  private async addManual(): Promise<void> {
    const paths = this.manualPaths.split(/\r?\n/).map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
    if (!paths.length || paths.length > 20) { this.error = '请填写 1 至 20 个项目路径，每行一个。'; this.refresh(); return }
    if (await this.save({ revision: this.data.revision, action: 'add', paths })) this.manualPaths = ''
    this.refresh()
  }
  render(): HTMLElement {
    const busy = this.loading || this.saving
    const content = card('Git 项目关联',
      text('关联保存在本机插件中，切换页面、重新打开或重启后自动恢复。勾选的项目用于考勤工时读取 Git 日志。', true),
      row(button(this.picking ? '系统选择器已打开…' : '选择项目文件夹', () => this.pick(), !this.loaded || busy || this.picking),
        button(this.loading ? '正在读取…' : '刷新关联项目', () => this.load(), busy || this.picking)),
      this.picking ? row(text('可按 Ctrl 多选；也可使用下方手动录入。', true), button('取消打开选择器', () => this.pickerController?.abort())) : null,
      this.error ? notice(this.error, true) : null,
      this.info ? notice(this.info) : null,
      input('手动录入项目文件夹（每行一个完整路径）', this.manualPaths, value => { this.manualPaths = value }, { multiline: true, maxLength: 81920, disabled: busy }),
      text('例如 D:\\ACode\\sidus-community。路径会校验、去重并自动保存。', true),
      button(this.saving ? '正在保存…' : '添加手动路径', () => this.addManual(), !this.loaded || busy),
      text(`已关联 ${this.count} / 20 个项目 · 已启用 ${this.paths.length} 个`),
      ...this.data.projects.map(project => row(
        check(project.path, project.enabled, enabled => { void this.save({ revision: this.data.revision, action: 'enable', path: project.path, enabled }) }, busy || this.picking),
        button('移除关联', () => this.save({ revision: this.data.revision, action: 'remove', path: project.path }), busy || this.picking)
      )),
      this.loaded && !this.count ? notice('尚未关联项目，请选择文件夹或手动添加路径。') : null,
      text('取消勾选仅暂停读取；移除关联不会删除本地文件夹。', true)
    )
    this.root = content
    return content
  }
  dispose(): void { this.disposed = true; this.pickerController?.abort(); this.root = undefined }
}
