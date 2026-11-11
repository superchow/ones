import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distributeMinutes, issueNumbers, proposeGitHours } from '../src/domain/git-hours.ts'
import type { Task } from '../src/domain/model.ts'
import type { GitCommit } from '../src/local-git.ts'

const task = (number: number, id = `task-${number}`): Task => ({
  id,
  number,
  name: `task ${number}`,
  project: { id: 'p', name: 'project' },
  issueType: { id: 't', name: number % 2 ? 'bug' : 'task' },
  status: { id: 's', name: 'open' }
})
const commit = (subject: string, hash = subject.padEnd(40, '0').slice(0, 40)): GitCommit => ({
  hash,
  subject,
  author: 'me@example.test',
  time: '2026-11-09T12:00:00.000Z',
  repository: '/fixture/repo'
})

test('issueNumbers extracts bounded #refs and ignores lookalikes', () => {
  assert.deepEqual(issueNumbers('fix #12 and #34'), [12, 34])
  assert.deepEqual(issueNumbers('#12/#12 again'), [12])
  assert.deepEqual(issueNumbers('C#12 and abc#9'), [])
  assert.deepEqual(issueNumbers('no refs here'), [])
})

test('distributeMinutes keeps 3-minute units and prefers largest remainders', () => {
  assert.deepEqual(distributeMinutes(480, [1, 1]), [240, 240])
  assert.deepEqual(distributeMinutes(10, [1]), [9])
  assert.deepEqual(distributeMinutes(9, [1, 1, 1]), [3, 3, 3])
  assert.deepEqual(distributeMinutes(3, [2, 1]), [3, 0])
  assert.deepEqual(distributeMinutes(0, [1, 1]), [0, 0])
})

test('proposeGitHours matches #numbers, weights minutes, and reports unmatched', () => {
  const proposal = proposeGitHours({
    commits: [
      commit('#89 fix login'),
      commit('#89 add tests'),
      commit('#88 inspect bug'),
      commit('chore without number'),
      commit('#77 foreign item')
    ],
    tasks: [task(89, 'task-fixture'), task(88, 'bug-fixture')],
    remainingMinutes: 480,
    start: '09:00'
  })
  assert.equal(proposal.allocations.length, 2)
  assert.equal(proposal.allocations[0]!.taskId, 'bug-fixture')
  assert.equal(proposal.allocations[1]!.taskId, 'task-fixture')
  assert.equal(proposal.allocations[0]!.minutes + proposal.allocations[1]!.minutes, 480)
  assert.equal(proposal.allocations[1]!.minutes, 321)
  assert.equal(proposal.allocations[0]!.minutes, 159)
  assert.equal(proposal.allocations[0]!.minutes % 3, 0)
  assert.equal(proposal.allocations[1]!.minutes % 3, 0)
  assert.match(proposal.allocations[1]!.description, /#89 fix login/)
  assert.deepEqual(proposal.missingNumbers, [77])
  assert.equal(proposal.unmatchedCommits.length, 1)
  assert.equal(proposal.unmatchedCommits[0]!.subject, 'chore without number')
})
