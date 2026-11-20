import type { Allocation, Option, Task } from '../domain/model.ts'
import type { TaskCreateOptions } from '../adapters/task-creation.ts'
import type { WorkbenchUI } from './panel.ts'
import { button, el, input, message, notice, request, select, text } from './dom.ts'
import { searchSelect } from './search-select.ts'

export class AllocationTargetEditor {
  private projects: Option[] = []
  private options = new Map<string, TaskCreateOptions>()
  constructor(private app: WorkbenchUI, private date: () => string) {}
  clear(): void { this.projects = []; this.options.clear() }
  setProjects(projects: Option[]): void { this.projects = projects }
  private key(project: string) { return JSON.stringify([this.app.team, this.date(), project]) }
  private load(item: Allocation): void {
    if (!item.newTask) return
    const draft = item.newTask
    void this.app.run(async signal => {
      const projects = await request<Option[]>('tasks.projects', { team: this.app.team }, signal)
      const selected = projects.some(p => p.id === draft.projectId) ? draft.projectId : ''
      try {
        const options = selected ? await request<TaskCreateOptions>('tasks.createOptions', { team: this.app.team, projectId: selected, date: this.date() }, signal) : null
        return { projects, options, selected, error: '' }
      } catch (error) { return { projects, options: null, selected, error: message(error) } }
    }, ({ projects, options, selected, error }) => {
      this.projects = projects
      if (item.newTask !== draft) return
      draft.projectId = selected
      if (options) this.options.set(this.key(selected), options)
      else this.options.delete(this.key(selected))
      if (error) this.app.error = error
    })
  }
  render(item: Allocation, index: number, tasks: Task[]): HTMLElement {
    const app = this.app, suffix = ` #${index + 1}`
    const current = tasks.find(t => t.id === item.taskId)
    const content = el('div', 'stack hours-target', el('h4', 'hours-section-title', '任务关联'), searchSelect('关联任务 / Bug' + suffix, item.newTask ? '__new__' : item.taskId, [
      { value: '', label: '选择已有任务 / Bug' }, { value: '__new__', label: '新建任务后登记工时' },
      ...tasks.map(t => ({ value: t.id, label: `[${t.issueType.name}] #${t.number} ${t.name} · ${t.project.name}` }))
    ], value => {
      app.invalidate()
      if (value === '__new__') {
        item.newTask = { key: crypto.randomUUID(), title: item.description.split('\n')[0]!.slice(0, 500), projectId: current?.project.id ?? '', sprintId: '', fields: {} }
        item.taskId = ''
        this.load(item)
      } else { item.taskId = value; delete item.newTask; app.render() }
    }, app.busy))
    const draft = item.newTask
    if (!draft) {
      if (current) content.append(
        el('div', 'hours-task-summary',
          el('span', 'hours-task-type', `${current.issueType.name} #${current.number}`),
          el('strong', 'hours-task-title', current.name)),
        el('dl', 'hours-project-meta',
          el('div', '', el('dt', '', '所属项目'), el('dd', '', current.project.name)),
          el('div', '', el('dt', '', '所属迭代'), el('dd', '', current.sprint === undefined ? '待核对' : current.sprint?.name ?? '未设置迭代')))
      )
      return content
    }
    const options = this.options.get(this.key(draft.projectId))
    const creation = el('div', 'stack hours-task-creation',
      el('h4', 'hours-section-title', '新任务信息与项目归属'),
      text('提交时先创建此任务，再登记下方工时。', true))
    content.append(creation)
    creation.append(
      input('新任务标题' + suffix, draft.title, value => { draft.title = value; app.invalidate(); app.render() }, { disabled: app.busy }),
      select('新任务所属项目' + suffix, draft.projectId, [{ value: '', label: '选择项目' }, ...this.projects.map(p => ({ value: p.id, label: p.name }))], value => {
        draft.projectId = value; draft.sprintId = ''; draft.fields = {}; app.invalidate(); this.load(item)
      }, app.busy),
      button(options ? '刷新任务创建字段' : '读取项目与创建字段', () => { app.invalidate(); this.load(item) }, app.busy)
    )
    if (!options) { creation.append(notice('请选择所属项目并读取创建字段，补全后才能预览。')); return content }
    creation.append(text(`工作项类型：${options.issueType.name} · 负责人：本人`, true),
      select('新任务所属迭代' + suffix, draft.sprintId, [{ value: '', label: options.sprintRequired ? '请选择迭代（必填）' : '无所属迭代' }, ...options.iterations.map(s => ({ value: s.id, label: s.name }))], value => { draft.sprintId = value; app.invalidate(); app.render() }, app.busy))
    for (const field of options.fields.filter(f => f.required || f.value || draft.fields[f.id] !== undefined)) {
      const label = field.name + (field.required ? '（必填）' : '') + suffix
      const value = draft.fields[field.id] ?? field.value
      const change = (value: string) => { draft.fields[field.id] = value; app.invalidate(); app.render() }
      creation.append(field.type === 1
        ? select(label, value, [{ value: '', label: '请选择' }, ...field.options.map(o => ({ value: o.id, label: o.name }))], change, app.busy)
        : input(label, value, change, { type: field.type === 5 ? 'date' : 'text', disabled: app.busy }))
    }
    return content
  }
}
