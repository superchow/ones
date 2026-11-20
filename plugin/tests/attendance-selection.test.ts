import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attendanceBudget, defaultPunchSelection } from '../src/domain/attendance.ts'
import type { Attendance } from '../src/domain/model.ts'

const attendance = (...times: string[]): Attendance => ({
  date: '2026-11-10', fetchedAt: 1,
  punches: times.map(time => ({ date: '2026-11-10', realDate: '2026-11-10', time, isNext: false, outFence: false }))
})

test('defaults follow record time rather than response order and still require confirmation', () => {
  const value = attendance('18:30', '09:00')
  const selection = defaultPunchSelection(value)!
  assert.deepEqual(selection, { start: 1, end: 0 })
  assert.equal(attendanceBudget(value, { ...selection, confirmed: true }), 480)
  assert.throws(() => attendanceBudget(value, { ...selection, confirmed: false }))
})

test('missing, extra, duplicate, invalid and cross-day punches are not silently paired', () => {
  for (const times of [[], ['09:00'], ['09:00', '12:00', '18:30'], ['09:00', '09:00'], ['invalid', '18:30']]) {
    assert.equal(defaultPunchSelection(attendance(...times)), null)
  }
  const value = attendance('09:00', '18:30')
  value.punches[1]!.isNext = true
  assert.equal(defaultPunchSelection(value), null)
  value.punches[1]!.isNext = false
  value.punches[1]!.realDate = '2026-11-11'
  assert.equal(defaultPunchSelection(value), null)
})

test('default selection does not broaden budget rules or hide abnormal attendance', () => {
  const value = attendance('09:15', '20:00')
  assert.deepEqual(defaultPunchSelection(value), { start: 0, end: 1 })
  assert.throws(() => attendanceBudget(value, { ...defaultPunchSelection(value)!, confirmed: true }), /时段/)
  const unknownFence = attendance('09:00', '18:30')
  unknownFence.punches[0]!.outFence = null
  assert.throws(() => attendanceBudget(unknownFence, { ...defaultPunchSelection(unknownFence)!, confirmed: true }), /外勤/)
})

test('confirmed normal days include early arrival and overtime after 21:00 in full half hours', () => {
  for (const [start, end, minutes] of [
    ['08:58', '21:20', 600], ['09:00', '21:29', 600], ['08:58', '21:30', 630],
    ['09:00', '22:00', 660], ['08:30', '18:30', 480], ['09:00', '23:59', 750]
  ] as const) {
    const value = attendance(start, end)
    assert.equal(attendanceBudget(value, { ...defaultPunchSelection(value)!, confirmed: true }), minutes)
  }
  assert.throws(() => attendanceBudget(attendance('09:01', '21:20'), { start: 0, end: 1, confirmed: true }))
})

test('manual daily duration requires confirmation and a bounded whole-minute value, including missing punches', () => {
  for (const times of [[], ['09:00'], ['18:30']]) {
    const value = attendance(...times)
    assert.equal(attendanceBudget(value, { mode: 'manual', minutes: 480, confirmed: true }), 480)
    assert.throws(() => attendanceBudget(value, { mode: 'manual', minutes: 480, confirmed: false }))
    for (const minutes of [NaN, Infinity, -1, 1441, 480.5]) {
      assert.throws(() => attendanceBudget(value, { mode: 'manual', minutes, confirmed: true }))
    }
  }
})
