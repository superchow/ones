import type { Store } from './service.ts'
import { record, requireThat, type Site } from './domain/model.ts'

export type Filters = { project: string; projectName: string; projectFollowing: boolean; statuses: string[] | null; hours: { project: string; iteration: string; onlyMine: boolean } }
export type GitPreference = { emails: string; allAuthors: boolean }
export type Preferences = { version: 1; accounts: Record<Site, string>; tab: string; git: GitPreference; teams: Record<string, string>; profiles: Record<string, Filters> }
export type PreferenceChange = { kind: 'account'; site: Site; value: string } | { kind: 'tab'; value: string } | { kind: 'git'; value: GitPreference } | { kind: 'team'; key: string; value: string } | { kind: 'filters'; key: string; value: Filters }
const tabs = ['bugs', 'implementation', 'git', 'hours', 'recovery', 'settings']
export const defaultPreferences = (): Preferences => ({ version: 1, accounts: { ones: '', coho: '' }, tab: 'bugs', git: { emails: '', allAuthors: false }, teams: {}, profiles: {} })
const string = (v: unknown, max = 254): string => { requireThat(typeof v === 'string' && v.length <= max, 'input', '保存的设置格式无效。'); return v }
const bool = (v: unknown): boolean => { requireThat(typeof v === 'boolean', 'input', '保存的设置格式无效。'); return v }
const option = (v: unknown): string => { const s = string(v, 100); requireThat(!s || /^[\w-]+$/.test(s), 'input', '筛选标识无效。'); return s }
const profile = (v: unknown, team = false): string => { const s = string(v, 170); requireThat((team ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{64}:[\w-]{1,100}$/).test(s), 'input', '设置所属账号无效。'); return s }
function filters(value: unknown): Filters {
  const v = record(value), hours = record(v.hours)
  requireThat(v.statuses === null || (Array.isArray(v.statuses) && v.statuses.length <= 100), 'input', '状态筛选无效。')
  return { project: option(v.project), projectName: string(v.projectName, 500), projectFollowing: bool(v.projectFollowing), statuses: v.statuses === null ? null : (v.statuses as unknown[]).map(s => string(s, 100)), hours: { project: option(hours.project), iteration: option(hours.iteration), onlyMine: bool(hours.onlyMine) } }
}
function git(value: unknown): GitPreference { const v = record(value); return { emails: string(v.emails, 2000), allAuthors: bool(v.allAuthors) } }
export function parsePreferences(value: unknown): Preferences {
  if (value === null) return defaultPreferences()
  const v = record(value), accounts = record(v.accounts), teams = record(v.teams), profiles = record(v.profiles)
  requireThat(v.version === 1 && tabs.includes(String(v.tab)) && Object.keys(teams).length <= 32 && Object.keys(profiles).length <= 64, 'schema', '本机设置版本或数量不受支持。')
  return { version: 1, accounts: { ones: string(accounts.ones), coho: string(accounts.coho) }, tab: String(v.tab), git: git(v.git), teams: Object.fromEntries(Object.entries(teams).map(([k, v]) => [profile(k, true), option(v)])), profiles: Object.fromEntries(Object.entries(profiles).map(([k, v]) => [profile(k), filters(v)])) }
}
export class PreferenceStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private store: Store) {}
  async load(): Promise<Preferences> { await this.queue; return parsePreferences(await this.store.get('preferences.v1')) }
  async update(change: PreferenceChange): Promise<{ saved: true }> {
    const action = this.queue.then(async () => {
      const data = parsePreferences(await this.store.get('preferences.v1'))
      switch (change.kind) {
        case 'account': requireThat(change.site === 'ones' || change.site === 'coho', 'input', '账号类型无效。'); data.accounts[change.site] = string(change.value); break
        case 'tab': requireThat(tabs.includes(change.value), 'input', '页面无效。'); data.tab = change.value; break
        case 'git': data.git = git(change.value); break
        case 'team': data.teams[profile(change.key, true)] = option(change.value); break
        case 'filters': data.profiles[profile(change.key)] = filters(change.value); break
        default: throw new Error('Unsupported preference')
      }
      // Whitelist serialization: passwords, tokens, previews and confirmations
      // cannot be persisted through this API, even if supplied by a panel.
      await this.store.set('preferences.v1', parsePreferences(data))
      return { saved: true as const }
    })
    this.queue = action.catch(() => {})
    return action
  }
}
