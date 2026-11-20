import { button, el } from './dom.ts'

export function searchSelect(label: string, value: string, options: { value: string; label: string }[], change: (value: string) => void, disabled = false): HTMLElement {
  const caption = el('label', '', label)
  caption.htmlFor = label
  const selected = options.find(option => option.value === value)
  const trigger = button('', () => popup.isConnected ? close() : open(), disabled, 'search-select-trigger')
  trigger.id = label
  trigger.value = value
  trigger.title = selected?.label ?? '选择工作项'
  trigger.append(el('span', '', trigger.title), el('span', 'muted', '▾'))
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-controls', `${label}-popup`)
  const root = el('div', 'field search-select', caption, trigger)
  const query = el('input')
  query.type = 'search'
  query.placeholder = '搜索编号、标题或项目'
  query.setAttribute('aria-label', `查询${label}`)
  query.setAttribute('role', 'combobox')
  query.setAttribute('aria-autocomplete', 'list')
  query.setAttribute('aria-expanded', 'true')
  query.autocomplete = 'off'
  const list = el('div', 'search-select-options')
  list.id = `${label}-options`
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', label)
  query.setAttribute('aria-controls', list.id)
  const count = el('p', 'muted search-select-count')
  count.setAttribute('role', 'status')
  const popup = el('div', 'search-select-popup', query, list, count)
  popup.id = `${label}-popup`
  let active = -1
  let choices: HTMLButtonElement[] = []
  const close = () => { popup.remove(); trigger.setAttribute('aria-expanded', 'false') }
  const choose = (next: string) => {
    close()
    trigger.focus()
    if (next !== value) change(next)
  }
  const highlight = (index: number) => {
    active = index
    choices.forEach((choice, i) => choice.classList.toggle('active', i === index))
    const choice = choices[index]
    if (choice) {
      query.setAttribute('aria-activedescendant', choice.id)
      choice.scrollIntoView({ block: 'nearest' })
    } else query.removeAttribute('aria-activedescendant')
  }
  const filter = () => {
    const terms = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const matches = options.filter(option => option.value && option.value !== '__new__' && terms.every(term => option.label.toLocaleLowerCase().includes(term)))
    const visible = matches.slice(0, 100)
    if (!terms.length && selected?.value && selected.value !== '__new__' && !visible.includes(selected)) visible.unshift(selected)
    // Creation remains available even when there is no matching existing task.
    const create = options.find(option => option.value === '__new__')
    const clear = options.find(option => option.value === '')
    const rows = [...(clear && !terms.length ? [clear] : []), ...visible, ...(create ? [create] : [])]
    choices = rows.map((option, index) => {
      const node = button(option.label, () => choose(option.value))
      node.id = `${list.id}-${index}`
      node.dataset.value = option.value
      node.tabIndex = -1
      node.setAttribute('role', 'option')
      node.setAttribute('aria-selected', String(option.value === value))
      node.addEventListener('mousedown', event => event.preventDefault())
      return node
    })
    list.replaceChildren(...choices)
    count.textContent = matches.length === 0 ? '没有匹配的已加载工作项，可修改关键词或新建任务。' : matches.length > 100 ? `匹配 ${matches.length} 项，显示前 100 项；请补充关键词。` : `匹配 ${matches.length} 个已加载工作项`
    active = -1
    query.removeAttribute('aria-activedescendant')
  }
  const open = () => {
    query.value = ''
    filter()
    root.append(popup)
    trigger.setAttribute('aria-expanded', 'true')
    const bounds = trigger.getBoundingClientRect()
    popup.classList.toggle('opens-up', innerHeight - bounds.bottom < 280 && bounds.top > innerHeight - bounds.bottom)
    query.focus()
  }
  query.addEventListener('input', filter)
  query.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      highlight(Math.max(0, Math.min(choices.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const choice = active < 0 ? choices.find(node => node.dataset.value && node.dataset.value !== '__new__') : choices[active]
      choice?.click()
    }
  })
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); open() }
  })
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && popup.isConnected) { event.preventDefault(); event.stopPropagation(); close(); trigger.focus() }
  })
  root.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close()
  })
  return root
}
