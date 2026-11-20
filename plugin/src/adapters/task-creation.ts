import { createHash, randomInt } from 'node:crypto'
import { AppError, id, record, requireThat, text, validDate, type NewTaskDraft, type Option } from '../domain/model.ts'
import { startSeconds } from '../domain/attendance.ts'
import type { OnesClient } from './ones.ts'
import type { Store } from '../service.ts'

export type CreateField = { id: string; name: string; type: 1 | 2 | 5; required: boolean; value: string; options: Option[] }
export type TaskCreateOptions = { project: Option; issueType: Option; iterations: Option[]; sprintRequired: boolean; fields: CreateField[]; stamp: string }
type FieldValue = { field_uuid: string; type: number; value: string | number | null; date_value?: string }
export type TaskCreationPlan = { draft: NewTaskDraft; stamp: string; details: string[]; payload: { assign: string; summary: string; parent_uuid: string; project_uuid: string; issue_type_uuid: string; watchers: string[]; field_values: FieldValue[] } }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Compare effective creation content, independent of API field ordering. */
export const taskCreationSignature = (payload: TaskCreationPlan['payload']) => hash({
  ...payload,
  watchers: [...payload.watchers].sort(),
  field_values: [...payload.field_values].sort((a, b) => a.field_uuid.localeCompare(b.field_uuid))
})
const system = new Set(['field001', 'field003', 'field004', 'field005', 'field006', 'field007', 'field008', 'field016'])

export function taskCreateOptions(project: Option, date: string, types: unknown[], projectData: unknown, teamData: unknown, iterations: Option[]): TaskCreateOptions {
  validDate(date)
  const projectMeta = record(projectData), teamMeta = record(teamData)
  const configs = record(projectMeta.field_config).field_configs, issueConfigs = record(projectMeta.issue_type_config).issue_type_configs
  const definitions = record(teamMeta.task_field).fields, options = record(teamMeta.task_field_option).options
  requireThat(Array.isArray(configs) && Array.isArray(issueConfigs) && Array.isArray(definitions) && Array.isArray(options), 'schema', '任务创建配置不完整。')
  const matches = types.map(record).filter(t => t.builtIn === true && String(t.detailType) === '2' && issueConfigs.some(v => { const c = record(v); return c.project_uuid === project.id && c.issue_type_uuid === t.uuid }))
  requireThat(matches.length === 1, 'schema', '该项目没有唯一启用的普通任务类型。')
  const issueType = { id: id(matches[0]!.uuid), name: text(matches[0]!.name) }
  const relevant = configs.map(record).filter(c => c.project_uuid === project.id && c.issue_type_uuid === issueType.id)
  requireThat(relevant.length > 0 && new Set(relevant.map(c => c.field_uuid)).size === relevant.length, 'schema', '任务创建字段为空或存在多个作用域，请在 ONES 中核对。')
  const fields: CreateField[] = []
  let sprintRequired = false, hasSprint = false
  for (const config of relevant) {
    const fieldId = id(config.field_uuid)
    if (config.generated === true || system.has(fieldId)) continue
    if (fieldId === 'field011') { requireThat(config.type === 7, 'schema', '迭代字段类型不匹配。'); hasSprint = true; sprintRequired = config.required === true; continue }
    const definition = definitions.map(record).find(d => d.uuid === fieldId)
    requireThat(definition, 'schema', '任务字段定义缺失。')
    if (![1, 2, 5].includes(Number(config.type)) || config.option_configs != null) {
      requireThat(config.required !== true, 'schema', `必填字段“${text(definition.name)}”暂不支持，请在 ONES 中创建任务后关联。`)
      continue
    }
    const type = config.type as 1 | 2 | 5
    const choices = type === 1 ? options.map(record).filter(o => o.field_uuid === fieldId).map(o => ({ id: id(o.uuid), name: text(o.value) })) : []
    const initial = typeof config.default_value === 'string' && !config.default_value.startsWith('$') ? config.default_value : type === 5 && config.required === true ? date : ''
    fields.push({ id: fieldId, name: text(definition.name), type, required: config.required === true, value: initial, options: choices })
  }
  return { project, issueType, iterations: hasSprint ? iterations : [], sprintRequired, fields, stamp: hash([projectMeta, teamMeta, issueType, iterations]) }
}

export function prepareNewTask(draft: NewTaskDraft, options: TaskCreateOptions, owner: string): TaskCreationPlan {
  id(draft.key); id(owner)
  const title = text(draft.title, 500).trim()
  requireThat(title.length > 0 && !/[\x00-\x1f]/.test(title) && draft.projectId === options.project.id, 'input', '请填写新任务标题并选择所属项目。')
  const values = record(draft.fields), allowed = new Set(options.fields.map(f => f.id))
  requireThat(Object.keys(values).every(key => allowed.has(key)), 'input', '任务字段配置已变化，请重新选择项目。')
  requireThat((!options.sprintRequired && !draft.sprintId) || options.iterations.some(s => s.id === draft.sprintId), 'input', '请选择该项目的有效所属迭代。')
  const field_values: FieldValue[] = [{ field_uuid: 'field004', type: 8, value: owner }, { field_uuid: 'field001', type: 2, value: title }, { field_uuid: 'field016', type: 20, value: null }]
  const details = [`项目：${options.project.name}`, `类型：${options.issueType.name}`, `负责人：本人`, `迭代：${options.iterations.find(s => s.id === draft.sprintId)?.name ?? '无'}`]
  if (draft.sprintId) field_values.push({ field_uuid: 'field011', type: 7, value: id(draft.sprintId) })
  for (const field of options.fields) {
    const value = values[field.id] ?? field.value
    requireThat(typeof value === 'string' && value.length <= 2000, 'input', `字段“${field.name}”格式无效。`)
    requireThat(!field.required || value.trim().length > 0, 'input', `请填写新任务的“${field.name}”。`)
    if (!value.trim()) continue
    if (field.type === 1) requireThat(field.options.some(o => o.id === value), 'input', `请选择“${field.name}”的有效选项。`)
    if (field.type === 5) validDate(value)
    field_values.push({ field_uuid: field.id, type: field.type, value: field.type === 5 ? startSeconds(value, '00:00') : value, ...(field.type === 5 ? { date_value: value } : {}) })
    details.push(`${field.name}：${field.options.find(o => o.id === value)?.name ?? value}`)
  }
  return { draft: structuredClone(draft), stamp: options.stamp, details, payload: { assign: owner, summary: title, parent_uuid: '', project_uuid: options.project.id, issue_type_uuid: options.issueType.id, watchers: [owner], field_values } }
}

export class TaskCreator {
  constructor(private client: OnesClient) {}
  async options(projectId: string, date: string, signal?: AbortSignal): Promise<TaskCreateOptions> {
    const project = (await this.client.projects(signal)).find(p => p.id === projectId)
    requireThat(project, 'scope', '新任务所属项目不可访问或已归档。')
    const [types, projectData, teamData, iterations] = await Promise.all([
      this.client.graph('query PluginCreateTypes{issueTypes{uuid name builtIn detailType}}', {}, 'Task', signal),
      this.client.api(`/project/${id(projectId)}/stamps/data?t=field_config,issue_type_config`, { field_config: 0, issue_type_config: 0 }, signal),
      this.client.api('/stamps/data?t=task_field,task_field_option', { task_field: 0, task_field_option: 0 }, signal),
      this.client.iterations(projectId, signal)
    ])
    requireThat(Array.isArray(types.issueTypes), 'schema', '工作项类型配置缺失。')
    return taskCreateOptions(project, date, types.issueTypes, projectData, teamData, iterations)
  }
  async prepare(draft: NewTaskDraft, date: string, signal?: AbortSignal) {
    return prepareNewTask(draft, await this.options(draft.projectId, date, signal), this.client.session.userId)
  }
  async createOrRead(plan: TaskCreationPlan, scope: string, date: string, store: Store, check: () => void): Promise<string> {
    const key = 'hours-new-task.' + hash([scope, date, plan.draft.key]), signature = taskCreationSignature(plan.payload)
    const previous = await store.get(key)
    let taskId: string
    if (previous) {
      const receipt = record(previous)
      requireThat(receipt.signature === signature || receipt.signature === hash(plan.payload), 'conflict', `该建议已尝试创建任务 ${String(receipt.taskId)}，不能修改后再次创建；请改为关联该任务。`)
      taskId = id(receipt.taskId)
    } else {
      const alphabet = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxy'
      taskId = this.client.session.userId + Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('')
      await store.set(key, { signature, taskId, state: 'unknown' })
      check()
      try {
        const result = await this.client.api('/tasks/add3', { tasks: [{ ...plan.payload, uuid: taskId }] })
        requireThat(Array.isArray(result.tasks) && result.tasks.length === 1 && record(result.tasks[0]).uuid === taskId && (!result.bad_tasks || Array.isArray(result.bad_tasks) && result.bad_tasks.length === 0), 'task-create', '任务创建响应需要核实。')
      } catch { throw new AppError('task-create', `任务创建结果待核实（ID：${taskId}），尚未为该项登记工时；重新提交只回读此任务，不重复创建。`) }
    }
    check()
    try {
      const task = await this.client.task(taskId)
      const info = await this.client.api(`/task/${taskId}/info`)
      requireThat(info.uuid === taskId && task.name === plan.payload.summary && task.project.id === plan.payload.project_uuid && task.issueType.id === plan.payload.issue_type_uuid && Array.isArray(info.field_values), 'readback', '新任务回读不一致。')
      for (const expected of plan.payload.field_values.filter(f => f.field_uuid !== 'field016')) {
        const matches = info.field_values.map(record).filter(f => f.field_uuid === expected.field_uuid)
        requireThat(matches.length === 1 && matches[0]!.type === expected.type && matches[0]!.value === expected.value, 'readback', '新任务字段回读不一致。')
      }
      check()
      await store.set(key, { signature, taskId, state: 'verified' })
      return taskId
    } catch { throw new AppError('task-create', `任务 ${taskId} 尚未通过字段回读核对，未为该项登记工时；请检查 ONES 原单后重试核对。`) }
  }
}
