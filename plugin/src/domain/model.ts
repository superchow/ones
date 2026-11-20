export type Site = 'ones' | 'coho'
export type Connection = { connected: boolean; label: string; profileKey?: string; message?: string }
export type Option = { id: string; name: string }
export type Task = { id: string; number: number; name: string; project: Option; issueType: Option; status: Option; sprint?: Option | null }
export type TaskFilter = { projectId?: string; sprintId?: string; onlyMine?: boolean }
export type TaskPage = { items: Task[]; nextCursor: string | null }
export type Punch = { date: string; realDate: string; time: string; isNext: boolean; outFence: boolean | null }
export type Attendance = { date: string; punches: Punch[]; fetchedAt: number }
export type AttendanceSelection = { mode?: 'punches'; start: number; end: number; confirmed: boolean } | { mode: 'manual'; minutes: number; confirmed: boolean }
export type Worklog = { key: string; task: string; owner: string; hours: number; startTime: number; description: string; type: string }
export type NewTaskDraft = { key: string; title: string; projectId: string; sprintId: string; fields: Record<string, string> }
export type Allocation = { taskId: string; newTask?: NewTaskDraft; start: string; minutes: number; description: string }
export function validateAllocationTarget(value: unknown): void {
  const row = record(value)
  if (row.newTask === undefined) { id(row.taskId); return }
  requireThat(row.taskId === '', 'input', '新任务建议不能同时关联现有任务。')
  const draft = record(row.newTask)
  id(draft.key)
  requireThat(typeof draft.title === 'string' && draft.title.length <= 500, 'input', '新任务标题过长或格式无效。')
  requireThat(typeof draft.projectId === 'string' && typeof draft.sprintId === 'string', 'input', '新任务项目或迭代无效。')
  if (draft.projectId) id(draft.projectId)
  if (draft.sprintId) id(draft.sprintId)
  const fields = record(draft.fields)
  requireThat(Object.keys(fields).length <= 50, 'input', '新任务字段过多。')
  for (const [key, value] of Object.entries(fields)) { id(key); requireThat(typeof value === 'string' && value.length <= 2000, 'input', '新任务字段格式无效。') }
}
export type Preview = { id: string; date: string; budget: number; existing: number; proposed: number; remaining: number; rows: (Allocation & { taskName: string; creationDetails?: string[] })[]; expiresAt: number; basis?: 'punches' | 'manual' }
export type Status = { ones: Connection; coho: Connection; teams: Option[]; writeEnabled: boolean; blockers: string[] }
export class AppError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'AppError' }
}
export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, message)
}
export function record(x: unknown): Record<string, unknown> {
  requireThat(x !== null && typeof x === 'object' && !Array.isArray(x), 'schema', '接口结构不匹配，已停止操作。')
  return x as Record<string, unknown>
}
export function text(x: unknown, max = 500): string {
  requireThat(typeof x === 'string' && x.length > 0 && x.length <= max, 'schema', '必填字段缺失或格式不匹配。')
  return x
}
export function id(x: unknown): string {
  const value = text(x, 100)
  requireThat(/^[A-Za-z0-9_-]+$/.test(value), 'input', '标识格式无效。')
  return value
}
export function validDate(value: unknown): string {
  const date = text(value, 10)
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date, 'input', '日期格式应为 YYYY-MM-DD。')
  return date
}
export function minuteOfDay(value: unknown): number {
  const time = text(value, 5)
  requireThat(/^([01]\d|2[0-3]):[0-5]\d$/.test(time), 'input', '时间格式应为 HH:mm。')
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}
export function safeFailure(error: unknown): { code: string; message: string } {
  // Never reflect response bodies, input values, URLs or upstream exception messages.
  return error instanceof AppError ? { code: error.code, message: error.message } : { code: 'unavailable', message: '操作未完成，请检查连接后重试；写入结果需先核实。' }
}
