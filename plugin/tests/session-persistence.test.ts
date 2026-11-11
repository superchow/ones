import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Workbench, type Store, type Vault } from '../src/service.ts'
import { COHO, Transport, type Fetcher } from '../src/adapters/http.ts'
import { loginCoho } from '../src/adapters/coho.ts'
import { PreferenceStore } from '../src/preferences.ts'
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
function fixture() {
  const data = new Map<string, unknown>()
  const store: Store = { get: async key => structuredClone(data.get(key) ?? null), set: async (key, value) => { data.set(key, structuredClone(value)) }, delete: async key => { data.delete(key) } }
  const seed = (extra = {}) => data.set('session.ones', JSON.stringify({ token: 'synthetic-old', refreshToken: 'synthetic-refresh', userId: 'user-1', label: 'fixture', teams: [{ id: 'team-1', name: 'fixture' }], expiresAt: Date.now() - 1000, ...extra }))
  const service = (fetcher: Fetcher) => new Workbench({ store, vault: store as Vault, protection: async () => true, fetcher })
  return { data, store, seed, service }
}
const identity: Fetcher = async url => String(url).endsWith('/users/me') ? json({ uuid: 'user-1' }) : json({ teams: [{ uuid: 'team-1', name: 'fixture' }] })

test('expired ONES sessions refresh once concurrently and restore after restart without another login', async () => {
  const f = fixture(); f.seed(); let refreshes = 0
  const fetcher: Fetcher = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) {
      refreshes++
      assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token')
      return json({ access_token: 'synthetic-new', refresh_token: 'synthetic-rotated', token_type: 'Bearer', expires_in: 172800 })
    }
    return identity(url, init)
  }
  const service = f.service(fetcher)
  const results = await Promise.all([service.status(), service.status(), service.status()])
  assert.ok(results.every(s => s.ones.connected)); assert.equal(refreshes, 1)
  const saved = JSON.parse(String(f.data.get('session.ones')))
  assert.equal(saved.refreshToken, 'synthetic-rotated'); assert.ok(saved.expiresAt > Date.now() + 86400000)
  assert.ok((await f.service(async () => { throw Error('must not request a new login') }).status()).ones.connected)
})

test('network failures preserve credentials; rotated tokens survive a failed identity read and restart', async () => {
  const f = fixture(); f.seed(); const original = f.data.get('session.ones')
  assert.equal((await f.service(async () => { throw Error('offline') }).status()).ones.connected, false)
  assert.equal(f.data.get('session.ones'), original)
  let refreshes = 0
  const failed = f.service(async url => {
    if (String(url).endsWith('/oauth/token')) { refreshes++; return json({ access_token: 'synthetic-new', refresh_token: 'synthetic-rotated', token_type: 'Bearer', expires_in: 3600 }) }
    throw Error('offline during identity check')
  })
  assert.equal((await failed.status()).ones.connected, false)
  assert.equal(JSON.parse(String(f.data.get('session.ones'))).refreshToken, 'synthetic-rotated')
  assert.ok((await f.service(identity).status()).ones.connected)
  assert.equal(refreshes, 1)
})

test('server invalid_grant clears only the rejected login; explicit logout wins an in-flight refresh', async () => {
  const f = fixture(); f.seed(); f.data.set('preferences.v1', { keep: true })
  assert.equal((await f.service(async () => json({ error: 'invalid_grant' }, 400)).status()).ones.connected, false)
  assert.equal(f.data.has('session.ones'), false); assert.deepEqual(f.data.get('preferences.v1'), { keep: true })
  f.seed(); let begin!: () => void, finish!: () => void
  const started = new Promise<void>(r => { begin = r }), release = new Promise<void>(r => { finish = r })
  const service = f.service(async url => {
    if (String(url).endsWith('/oauth/token')) { begin(); await release; return json({ access_token: 'synthetic-new', token_type: 'Bearer', expires_in: 3600 }) }
    return identity(url)
  })
  const restoring = service.status(); await started
  const logout = service.logout('ones'); finish(); await Promise.all([restoring, logout])
  assert.equal((await service.status()).ones.connected, false); assert.equal(f.data.has('session.ones'), false)
})

test('legacy expiries are server-validated; Coho uses the actual expTime in seconds', async () => {
  const f = fixture(); f.seed({ refreshToken: undefined })
  assert.ok((await f.service(identity).status()).ones.connected)
  const login = await loginCoho(new Transport(COHO, async url => String(url).endsWith('/requestToken') ? json({ code: 200, data: { token: 'synthetic-coho', expTime: 604800 } }) : json({ code: 200, data: { tenantCode: 'ATS', globalId: 'person-1' } })), 'fixture', 'synthetic-password')
  assert.ok(login.expiresAt !== null && login.expiresAt > Date.now() + 6 * 86400000)
  f.data.delete('session.ones'); f.data.set('session.coho', JSON.stringify({ ...login, expiresAt: Date.now() - 1000 }))
  assert.ok((await f.service(async () => json({ code: 200, data: { tenantCode: 'ATS', globalId: 'person-1' } })).status()).coho.connected)
  f.data.set('session.coho', JSON.stringify({ ...login, expiresAt: 0 }))
  assert.equal((await f.service(async () => json({ code: 401 })).status()).coho.connected, false)
  assert.equal(f.data.has('session.coho'), false)
})

test('temporary vault failures can be retried without losing a rotated token or saved login', async () => {
  const f = fixture(); f.seed({ expiresAt: Date.now() + 600000 }); let unreadable = true
  const vault: Vault = { ...f.store as Vault, get: async key => { if (unreadable) throw Error('keyring locked'); return String(f.data.get(key) ?? '') || null } }
  const service = new Workbench({ store: f.store, vault, protection: async () => true, fetcher: identity })
  assert.equal((await service.status()).ones.connected, false)
  unreadable = false; assert.ok((await service.status()).ones.connected)
  f.seed(); let writesFail = true, renewals = 0
  const rotating = new Workbench({ store: f.store, vault: { ...f.store as Vault, set: async (key, value) => { if (writesFail) throw Error('disk full'); await f.store.set(key, value) } }, protection: async () => true, fetcher: async (url, init) => {
    if (String(url).endsWith('/oauth/token')) { renewals++; return json({ access_token: 'synthetic-new', refresh_token: 'synthetic-rotated', token_type: 'Bearer', expires_in: 3600 }) }
    return identity(url, init)
  } })
  assert.equal((await rotating.status()).ones.connected, false)
  writesFail = false; assert.ok((await rotating.status()).ones.connected)
  assert.equal(renewals, 1); assert.equal(JSON.parse(String(f.data.get('session.ones'))).refreshToken, 'synthetic-rotated')
})

test('settings survive new service instances, merge concurrent updates and exclude secrets and confirmations', async () => {
  const f = fixture(), prefs = new PreferenceStore(f.store), key = 'a'.repeat(64)
  await Promise.all([
    prefs.update({ kind: 'account', site: 'ones', value: 'fixture@example.test' }),
    prefs.update({ kind: 'tab', value: 'hours' }),
    prefs.update({ kind: 'team', key, value: 'team-1' }),
    prefs.update({ kind: 'git', value: { emails: 'fixture@example.test', allAuthors: false } }),
    prefs.update({ kind: 'filters', key: key + ':team-1', value: { project: 'project-1', projectName: 'Fixture', projectFollowing: false, statuses: [], hours: { project: 'project-2', iteration: 'iteration-1', onlyMine: true }, password: 'must-never-persist', confirmed: true } as never })
  ])
  const restored = await new PreferenceStore(f.store).load()
  assert.equal(restored.accounts.ones, 'fixture@example.test'); assert.equal(restored.tab, 'hours')
  assert.deepEqual(restored.profiles[key + ':team-1'].statuses, [])
  assert.equal(restored.profiles[key + ':team-1'].hours.iteration, 'iteration-1')
  assert.equal(JSON.stringify(restored).includes('must-never-persist'), false)
  assert.equal(JSON.stringify(restored).includes('confirmed'), false)
  const before = structuredClone(f.data.get('preferences.v1'))
  await assert.rejects(() => prefs.update({ kind: 'filters', key: '__proto__', value: {} as never }))
  assert.deepEqual(f.data.get('preferences.v1'), before)
})

test('retrying one unreadable site keeps the other restored session and accepts legacy Coho null expiry', async () => {
  const f = fixture(); f.seed({ expiresAt: Date.now() + 600000 })
  f.data.set('session.coho', JSON.stringify({ token: 'synthetic-coho', principal: 'person-1', label: 'fixture', expiresAt: null }))
  let locked = true
  const service = new Workbench({ store: f.store, protection: async () => true,
    vault: { ...f.store as Vault, get: async key => {
      if (key === 'session.coho' && locked) throw Error('locked')
      return String(f.data.get(key) ?? '') || null
    } }, fetcher: async () => { throw Error('unexpected network') } })
  const first = await service.status()
  assert.equal(first.ones.connected, true); assert.equal(first.coho.connected, false)
  locked = false
  const results = await Promise.all([service.status(), service.status()])
  assert.ok(results.every(result => result.ones.connected && result.coho.connected))
  assert.equal(JSON.parse(String(f.data.get('session.coho'))).expiresAt, null)
})

test('Coho expiry revalidation is shared, preserves offline credentials, and never exchanges tokens', async () => {
  const f = fixture()
  const saved = JSON.stringify({ token: 'synthetic-coho', principal: 'person-1', label: 'fixture', expiresAt: 0 })
  f.data.set('session.coho', saved)
  assert.equal((await f.service(async () => { throw Error('offline') }).status()).coho.connected, false)
  assert.equal(f.data.get('session.coho'), saved)
  const paths: string[] = []
  const service = f.service(async url => {
    paths.push(new URL(String(url)).pathname)
    return json({ code: 200, data: { tenantCode: 'ATS', globalId: 'person-1' } })
  })
  const results = await Promise.all([service.status(), service.status(), service.status()])
  assert.ok(results.every(result => result.coho.connected))
  assert.deepEqual(paths, ['/gateway/auth/user/getCurrentUser'])
  assert.equal(JSON.parse(String(f.data.get('session.coho'))).token, 'synthetic-coho')
})

test('a delayed 401 from the old ONES access token cannot revoke a rotated session', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = fixture(); f.seed({ expiresAt: Date.now() + 1000 })
  let started!: () => void, release!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const service = f.service(async (url, init) => {
    if (new Headers(init?.headers).get('Authorization') === 'Bearer synthetic-old') {
      started(); await held; return json({}, 401)
    }
    if (String(url).endsWith('/oauth/token')) return json({ access_token: 'synthetic-new', refresh_token: 'synthetic-rotated', token_type: 'Bearer', expires_in: 3600 })
    return identity(url, init)
  })
  const oldRead = assert.rejects(service.bugStatuses('team-1'))
  await pending
  t.mock.timers.tick(2000)
  assert.equal((await service.status()).ones.connected, true)
  release(); await oldRead
  assert.equal((await service.status()).ones.connected, true)
  assert.equal(JSON.parse(String(f.data.get('session.ones'))).refreshToken, 'synthetic-rotated')
})
