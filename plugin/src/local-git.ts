import { execFile } from 'node:child_process'
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { AppError, requireThat, safeFailure, validDate } from './domain/model.ts'

export type Folder = { name: string; path: string }
export type FolderPage = { path: string; parent: string | null; folders: Folder[] }
export type GitInput = { paths: string[]; date: string; emails?: string; allAuthors?: boolean }
export type GitCommit = { hash: string; subject: string; author: string; time: string; repository: string }
export type GitReport = { date: string; commits: GitCommit[]; repositories: { path: string; count: number; truncated: boolean; error?: string }[] }

export async function resolveFolders(paths: string[]): Promise<string[]> {
  requireThat(Array.isArray(paths) && paths.length > 0 && paths.length <= 20, 'folder', '请填写 1 至 20 个项目文件夹路径，每行一个。')
  const unique = new Map<string, string>()
  for (const value of paths) {
    const path = await localDirectory(value)
    unique.set(process.platform === 'win32' ? path.toLowerCase() : path, path)
  }
  return [...unique.values()]
}

async function localDirectory(value: string): Promise<string> {
  requireThat(typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !value.includes('\0'), 'folder', '请选择本机绝对目录。')
  requireThat(!/^[/\\]{2}/.test(value), 'folder', '请选择本机目录，不支持网络共享。')
  try {
    const path = await realpath(value)
    requireThat(!/^[/\\]{2}/.test(path) && (await stat(path)).isDirectory(), 'folder', '所选路径不是本机文件夹。')
    return path
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('folder', '目录不存在或无权访问，请重新选择。')
  }
}

export async function browseFolders(value?: string): Promise<FolderPage> {
  if (!value) {
    const roots = process.platform === 'win32' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`) : ['/']
    const folders: Folder[] = []
    for (const path of roots) { if (await stat(path).then(s => s.isDirectory(), () => false)) folders.push({ name: path, path }) }
    return { path: '', parent: null, folders }
  }
  const path = await localDirectory(value)
  try {
    const entries = await readdir(path, { withFileTypes: true })
    const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    requireThat(folders.length <= 2000, 'folder', '此目录子文件夹过多，请输入更具体的项目路径。')
    return { path, parent: dirname(path) === path ? '' : dirname(path), folders }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('folder', '无法读取此目录，请选择可访问的项目文件夹。')
  }
}

function git(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // Arguments are passed directly: paths and commit text never become shell commands.
    execFile('git', ['--no-pager', '-C', path, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, signal,
      env: { ...process.env, HOME: process.env.HOME ?? homedir(),
        ...(process.platform === 'win32' ? { USERPROFILE: process.env.USERPROFILE ?? homedir(),
          APPDATA: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
          LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}),
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: '' }
    }, (error, stdout, stderr) => {
      if (error) {
        const reason = /dubious ownership/i.test(stderr) ? 'Git 尚未信任此仓库，请先在终端核实其所有者与 safe.directory 配置。'
          : error.killed ? 'Git 读取超时，请减少所选项目后重试。'
          : /not a git repository/i.test(stderr) ? '此文件夹不是 Git 仓库，请选择项目根目录。'
          : `Git ${args[0]} 读取失败，请确认仓库可访问。`
        reject(new AppError('git', signal?.aborted ? 'Git 读取已取消。' : (error as NodeJS.ErrnoException).code === 'ENOENT' ? '未找到 Git，请安装并重启 Orca。' : reason))
      }
      else resolve(stdout)
    })
  })
}

export async function readGitLogs(input: GitInput, signal?: AbortSignal): Promise<GitReport> {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)])
  const date = validDate(input.date)
  requireThat(Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 20, 'folder', '请选择 1 至 20 个本地项目文件夹。')
  requireThat(input.emails === undefined || (typeof input.emails === 'string' && input.emails.length <= 2000), 'input', '作者邮箱过长。')
  requireThat(input.allAuthors === undefined || typeof input.allAuthors === 'boolean', 'input', '作者范围无效。')
  const aliases = (input.emails ?? '').split(/[,;\s]+/).filter(Boolean).map(email => email.toLowerCase())
  const from = Date.parse(`${date}T00:00:00+08:00`) / 1000, to = from + 86400
  const report: GitReport = { date, commits: [], repositories: [] }
  const seenPaths = new Set<string>(), seenHashes = new Set<string>()
  // Bound each batch to four subprocesses, preserving the selected folder order.
  for (let offset = 0; offset < input.paths.length; offset += 4) {
    signal?.throwIfAborted()
    const results = await Promise.all(input.paths.slice(offset, offset + 4).map(async value => {
      try {
        const path = await localDirectory(value)
        const root = (await git(path, ['rev-parse', '--show-toplevel'], signal)).trim()
        const canonical = await localDirectory(root)
        const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
        if (seenPaths.has(key)) return null
        seenPaths.add(key)
        const emails = aliases.length ? aliases : input.allAuthors ? [] : [(await git(canonical, ['config', 'user.email'], signal).catch(() => { throw new AppError('git-author', '未能读取仓库作者配置，请填写本人提交使用的邮箱。') })).trim().toLowerCase()]
        requireThat(input.allAuthors || emails.some(Boolean), 'git-author', '仓库未配置作者邮箱，请填写本人提交使用的邮箱。')
        // --since-as-filter avoids stopping at an out-of-order commit date. Scan all local refs,
        // excluding merge-only messages; strict timezone and exact email filtering follow below.
        const output = await git(canonical, ['log', '--all', '--no-merges', `--since-as-filter=@${from}`, `--until=@${to - 1}`, '-n', '2001', '--format=%H%x00%ct%x00%ae%x00%s'], signal)
        const lines = output.trim() ? output.trim().split('\n') : []
        const commits: GitCommit[] = []
        for (const line of lines.slice(0, 2000)) {
          const [hash, seconds, email, subject] = line.replace(/\r$/, '').split('\0')
          requireThat(/^[a-f0-9]{40,64}$/.test(hash!) && Number.isSafeInteger(Number(seconds)) && email !== undefined && subject !== undefined, 'git-format', 'Git 日志格式异常，请核对仓库。')
          const timestamp = Number(seconds)
          if (timestamp < from || timestamp >= to || (!input.allAuthors && !emails.includes(email!.toLowerCase()))) continue
          commits.push({ hash: hash!, subject: subject!.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2000), author: email!, time: new Date(timestamp * 1000).toISOString(), repository: canonical })
        }
        return { path: canonical, commits, truncated: lines.length > 2000 }
      } catch (error) {
        return { path: typeof value === 'string' ? value : '', commits: [], truncated: false, error: safeFailure(error).message }
      }
    }))
    for (const result of results) {
      if (!result) continue
      const unique = result.commits.filter(commit => !seenHashes.has(commit.hash) && !!seenHashes.add(commit.hash))
      report.commits.push(...unique)
      report.repositories.push({ path: result.path, count: unique.length, truncated: result.truncated, ...('error' in result ? { error: result.error } : {}) })
    }
  }
  signal?.throwIfAborted()
  report.commits.sort((a, b) => b.time.localeCompare(a.time) || a.hash.localeCompare(b.hash))
  requireThat(Buffer.byteLength(JSON.stringify(report), 'utf8') <= 2 * 1024 * 1024, 'git-limit', 'Git 日志内容超过读取上限，请减少所选项目或缩小作者范围。')
  return report
}
