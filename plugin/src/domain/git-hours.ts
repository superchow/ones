import type { Allocation, Task } from './model.ts'
import type { GitCommit } from '../local-git.ts'

export function issueNumbers(subject: string): number[] {
  const found = new Set<number>()
  for (const match of subject.matchAll(/(?:^|[^A-Za-z0-9_])#(\d{1,9})\b/g)) {
    const n = Number(match[1])
    if (Number.isSafeInteger(n) && n > 0) found.add(n)
  }
  return [...found]
}

export function distributeMinutes(remaining: number, weights: number[]): number[] {
  const pool = Math.floor(Math.max(0, remaining) / 3) * 3
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
  if (pool <= 0 || total <= 0) return weights.map(() => 0)
  const minutes = weights.map(weight => Math.floor((pool * Math.max(0, weight) / total) / 3) * 3)
  let used = minutes.reduce((sum, value) => sum + value, 0)
  const order = weights
    .map((weight, index) => ({ index, frac: (pool * Math.max(0, weight) / total) - minutes[index]! }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index)
  for (const item of order) {
    if (used + 3 > pool || weights[item.index]! <= 0) continue
    minutes[item.index]! += 3
    used += 3
  }
  return minutes
}

export type GitHourProposal = {
  allocations: Allocation[]
  unmatchedCommits: GitCommit[]
  missingNumbers: number[]
}

export function proposeGitHours(input: {
  commits: GitCommit[]
  tasks: Task[]
  remainingMinutes: number
  start: string
}): GitHourProposal {
  const byNumber = new Map(input.tasks.map(task => [task.number, task]))
  const groups = new Map<string, { task: Task; subjects: string[]; weight: number }>()
  const unmatchedCommits: GitCommit[] = []
  const missing = new Set<number>()
  for (const commit of input.commits) {
    const numbers = issueNumbers(commit.subject)
    if (!numbers.length) {
      unmatchedCommits.push(commit)
      continue
    }
    const matched = numbers.map(number => byNumber.get(number)).filter((task): task is Task => !!task)
    for (const number of numbers) if (!byNumber.has(number)) missing.add(number)
    if (!matched.length) continue
    for (const task of matched) {
      const group = groups.get(task.id) ?? { task, subjects: [], weight: 0 }
      group.weight += 1
      if (!group.subjects.includes(commit.subject)) group.subjects.push(commit.subject)
      groups.set(task.id, group)
    }
  }
  const rows = [...groups.values()].sort((a, b) => a.task.number - b.task.number || a.task.id.localeCompare(b.task.id))
  const minutes = distributeMinutes(input.remainingMinutes, rows.map(row => row.weight))
  const allocations: Allocation[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const value = minutes[index]!
    if (value <= 0) continue
    const description = row.subjects.join('\n').slice(0, 2000)
    if (!description.trim()) continue
    allocations.push({ taskId: row.task.id, start: input.start, minutes: value, description })
  }
  return {
    allocations,
    unmatchedCommits,
    missingNumbers: [...missing].sort((a, b) => a - b)
  }
}
