import assert from 'node:assert/strict'

// clickNamed must send real browser pointer input, not HTMLElement.click().
// Chromium's pointer focus transition is what originally dismissed the calendar too early.
export async function exerciseDatePickerPointer({ evaluate, clickNamed }) {
  const field = `document.getElementById('业务日期（YYYY-MM-DD）')`
  const original = await evaluate(`${field}.value`)
  await clickNamed('业务日期（YYYY-MM-DD）')
  await clickNamed('上个月')
  assert.equal(await evaluate(`${field}.value`), original)
  const date = await evaluate(`document.querySelector('.date-calendar-grid button').getAttribute('aria-label')`)
  await clickNamed(date)
  assert.equal(await evaluate(`${field}.value`), date)
  assert.equal(await evaluate(`!!document.querySelector('.date-calendar')`), false)
  return { pointerMonthNavigation: true, pointerDaySelection: true, selectedDate: date }
}

export async function exerciseDatePicker({ evaluate, wait }) {
  await wait(`!!document.querySelector('.date-trigger')&&!app.busy`)
  const field = `document.getElementById('业务日期（YYYY-MM-DD）')`
  const original = await evaluate(`${field}.value`)
  const click = async selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const select = async (label, value) => evaluate(`(()=>{const s=document.querySelector('[aria-label="${label}"]');s.value=${JSON.stringify(String(value))};s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await click('.date-trigger')
  await evaluate(`window.originalDateTrigger=document.querySelector('.date-trigger')`)
  await click('[aria-label="上个月"]')
  assert.equal(await evaluate(`${field}.value`), original)
  assert.equal(await evaluate(`originalDateTrigger===document.querySelector('.date-trigger')&&!!document.querySelector('.date-calendar')`), true)
  await select('年份', 2024)
  await select('月份', 1)
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="2024-02-29"]')`), true)
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="2024-02-30"]')`), false)
  await click('[aria-label="2024-02-29"]')
  assert.equal(await evaluate(`${field}.value`), '2024-02-29')
  assert.equal(await evaluate(`document.querySelector('.date-calendar')===null`), true)
  assert.equal(await evaluate(`document.activeElement===${field}`), true)
  await evaluate(`(()=>{const c=[...document.querySelectorAll('label')].find(e=>e.textContent==='已确认 ONES 与 Coho 均为本人账号').querySelector('input');if(!c.checked)c.click()})()`)
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='读取考勤与已有工时').click()`)
  await wait(`!!document.querySelector('.hours-source-summary')&&!app.busy`)
  assert.equal(await evaluate(`calls.filter(c=>c.name==='day.read').at(-1).input.date`), '2024-02-29')
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='调整日期与账号').click()`)
  await click('.date-trigger')
  await select('年份', 2025)
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="2025-02-29"]')`), false)
  await click('[aria-label="2025-02-28"]')
  assert.equal(await evaluate(`app.hours.day===null`), true)
  await click('.date-trigger')
  await evaluate(`document.querySelector('.date-calendar').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  assert.equal(await evaluate(`document.querySelector('.date-calendar')===null`), true)
  assert.equal(await evaluate(`${field}.value`), '2025-02-28')
  await click('.date-trigger')
  await evaluate(`[...document.querySelectorAll('.date-calendar button')].find(b=>b.textContent==='清空').click()`)
  assert.equal(await evaluate(`${field}.value`), '')
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='读取考勤与已有工时').disabled`), true)
  await click('.date-trigger')
  await evaluate(`[...document.querySelectorAll('.date-calendar button')].find(b=>b.textContent==='今天').click()`)
  assert.equal(await evaluate(`${field}.value`), await evaluate(`new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())`))
  assert.equal(await evaluate(`calls.filter(c=>c.name==='hours.submit').length`), 0)
  return { monthNavigationPreservesControl: true, leapDay: true, nonLeapYear: true, readUsesSelectedDate: true, changeClearsAttendance: true, emptyDateBlocked: true, escape: true, today: true, writes: 0 }
}
