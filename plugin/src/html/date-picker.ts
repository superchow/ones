/** Render the calendar inside the panel: native date popups are unreliable in Orca webviews. */
export function datePicker(label: string, value: string, change: (value: string) => void, disabled = false): HTMLElement {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElement(tag)
    node.textContent = text
    return node
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  const initial = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today
  let year = Number(initial.slice(0, 4))
  let month = Number(initial.slice(5, 7)) - 1
  const root = make('div')
  root.className = 'field date-field'
  const caption = make('label', label)
  caption.htmlFor = label
  const trigger = make('button', value || '选择日期')
  trigger.type = 'button'
  trigger.id = label
  trigger.value = value
  trigger.disabled = disabled
  trigger.className = 'date-trigger'
  trigger.setAttribute('aria-expanded', 'false')
  const calendar = make('div')
  calendar.className = 'date-calendar stack'
  calendar.setAttribute('role', 'group')
  calendar.setAttribute('aria-label', '选择日期')
  calendar.id = `${label}-calendar`
  trigger.setAttribute('aria-controls', calendar.id)
  const close = () => {
    calendar.remove()
    trigger.setAttribute('aria-expanded', 'false')
  }
  const choose = (date: string) => {
    trigger.value = date
    trigger.textContent = date || '选择日期'
    close()
    trigger.focus()
    if (date !== value) { value = date; change(date) }
  }
  const action = (text: string, callback: () => void) => {
    const node = make('button', text)
    node.type = 'button'
    node.addEventListener('click', callback)
    return node
  }
  const renderMonth = () => {
    const header = make('div')
    header.className = 'date-calendar-header'
    const navigate = (offset: number) => {
      month += offset
      if (month < 0) { year--; month = 11 }
      if (month > 11) { year++; month = 0 }
      renderMonth()
      calendar.querySelector<HTMLButtonElement>(offset < 0 ? '[aria-label="上个月"]' : '[aria-label="下个月"]')?.focus()
    }
    const previous = action('‹', () => navigate(-1))
    previous.setAttribute('aria-label', '上个月')
    previous.disabled = year <= 1000 && month === 0
    const next = action('›', () => navigate(1))
    next.setAttribute('aria-label', '下个月')
    next.disabled = year >= 9999 && month === 11
    const years = make('select')
    years.setAttribute('aria-label', '年份')
    for (let y = Math.max(1000, year - 10); y <= Math.min(9999, year + 10); y++) {
      const option = make('option', `${y} 年`)
      option.value = String(y)
      years.append(option)
    }
    years.value = String(year)
    years.addEventListener('change', () => {
      year = Number(years.value); renderMonth()
      calendar.querySelector<HTMLSelectElement>('[aria-label="年份"]')?.focus()
    })
    const months = make('select')
    months.setAttribute('aria-label', '月份')
    for (let m = 0; m < 12; m++) {
      const option = make('option', `${m + 1} 月`)
      option.value = String(m)
      months.append(option)
    }
    months.value = String(month)
    months.addEventListener('change', () => {
      month = Number(months.value); renderMonth()
      calendar.querySelector<HTMLSelectElement>('[aria-label="月份"]')?.focus()
    })
    header.append(previous, years, months, next)
    const grid = make('div')
    grid.className = 'date-calendar-grid'
    for (const day of ['一', '二', '三', '四', '五', '六', '日']) {
      const cell = make('span', day)
      cell.className = 'muted'
      grid.append(cell)
    }
    const offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7
    for (let i = 0; i < offset; i++) grid.append(make('span'))
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    for (let day = 1; day <= days; day++) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const cell = action(String(day), () => choose(date))
      cell.setAttribute('aria-label', date)
      cell.setAttribute('aria-pressed', String(date === value))
      if (date === today) cell.setAttribute('aria-current', 'date')
      grid.append(cell)
    }
    const footer = make('div')
    footer.className = 'row'
    footer.append(action('今天', () => choose(today)), action('清空', () => choose('')), action('关闭日历', () => { close(); trigger.focus() }))
    calendar.replaceChildren(header, grid, footer)
  }
  trigger.addEventListener('click', () => {
    if (calendar.isConnected) { close(); return }
    renderMonth()
    root.append(calendar)
    trigger.setAttribute('aria-expanded', 'true')
    // Keep the panel calendar within the viewport, including narrow plugin panels.
    calendar.style.left = ''
    const bounds = calendar.getBoundingClientRect()
    if (bounds.left < 8) calendar.style.left = `${8 - root.getBoundingClientRect().left}px`
    calendar.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
  })
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && calendar.isConnected) {
      event.preventDefault(); event.stopPropagation(); close(); trigger.focus()
    }
  })
  root.addEventListener('focusout', event => {
    // Chromium temporarily focuses BODY between pointer-down and the next focus-in.
    // Reading activeElement in a microtask here removes the day before its click.
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close()
  })
  root.append(caption, trigger)
  return root
}
