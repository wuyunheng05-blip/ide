import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { searchQuery, verificationScript, withinRoot } from './security.mjs'

protocol.registerSchemesAsPrivileged([{ scheme: 'workmate', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const rendererRoot = path.join(root, 'dist')
const ignored = new Set(['node_modules', '.git', 'dist', '.next', '.cache'])
const maxTextFileSize = 5 * 1024 * 1024
const maxToolIterations = 6
const verificationTimeoutMs = 120000
const maxVerificationOutputBytes = 24 * 1024
const maxSearchResults = 50
const maxSearchOutputBytes = 120 * 1024
const maxGitOutputBytes = 48 * 1024
const allowedVerificationScripts = new Set(['build', 'test', 'lint'])
let workspaceRoot = null
const configPath = () => path.join(app.getPath('userData'), 'settings.json')
const defaults = { model: 'deepseek-chat', autoWrite: true, confirmBeforeWrite: false, allowWorkspaceCommands: false, apiKey: '', doubaoSearchKey: '' }

function withinWorkspace(targetPath) {
  if (!workspaceRoot) throw new Error('请先选择工作区')
  return withinRoot(workspaceRoot, targetPath)
}
async function validateTextFile(targetPath, allowMissing = false) {
  try {
    const info = await stat(targetPath)
    if (!info.isFile()) throw new Error('只能操作文件')
    if (info.size > maxTextFileSize) throw new Error('文件超过 5 MB，无法安全操作')
  } catch (error) {
    if (!allowMissing || error?.code !== 'ENOENT') throw error
    const parent = await stat(path.dirname(targetPath))
    if (!parent.isDirectory()) throw new Error('目标目录不存在')
  }
}
async function readTextFile(filePath) {
  const targetPath = withinWorkspace(filePath)
  await validateTextFile(targetPath)
  const content = await readFile(targetPath, 'utf8')
  if (content.includes('\0')) throw new Error('不支持打开二进制文件')
  return content
}
async function writeTextFile(filePath, content) {
  if (typeof content !== 'string') throw new Error('文件内容必须为文本')
  if (Buffer.byteLength(content, 'utf8') > maxTextFileSize) throw new Error('保存内容超过 5 MB 限制')
  const targetPath = withinWorkspace(filePath)
  await validateTextFile(targetPath, true)
  await writeFile(targetPath, content, 'utf8')
  return true
}
async function walk(folder, depth = 0, maxDepth = 5) {
  const entries = await readdir(folder, { withFileTypes: true })
  const visible = entries.filter(entry => !ignored.has(entry.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return Promise.all(visible.map(async entry => {
    const entryPath = path.join(folder, entry.name)
    return { name: entry.name, path: entryPath, type: entry.isDirectory() ? 'directory' : 'file', children: entry.isDirectory() && depth < maxDepth ? await walk(entryPath, depth + 1, maxDepth) : undefined }
  }))
}
async function searchWorkspace(query, limit = 20) {
  const needle = searchQuery(query).toLocaleLowerCase()
  const maxResults = Math.min(Math.max(Number(limit) || 20, 1), maxSearchResults)
  const results = []
  async function visit(folder) {
    if (results.length >= maxResults) return
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (ignored.has(entry.name) || results.length >= maxResults) continue
      const entryPath = path.join(folder, entry.name)
      if (entry.isDirectory()) { await visit(entryPath); continue }
      if (!entry.isFile()) continue
      try {
        await validateTextFile(entryPath)
        const content = await readFile(entryPath, 'utf8')
        if (content.includes('\0')) continue
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
          if (lines[index].toLocaleLowerCase().includes(needle)) results.push({ path: entryPath, relativePath: path.relative(workspaceRoot, entryPath), line: index + 1, text: lines[index].slice(0, 300) })
        }
      } catch { /* Skip unreadable, oversized, or non-text files. */ }
    }
  }
  await visit(workspaceRoot)
  return results
}
function runProcess(command, args, maxBytes = maxGitOutputBytes) {
  if (!workspaceRoot) return Promise.reject(new Error('请先选择工作区'))
  return new Promise((resolve, reject) => {
    let output = ''
    let truncated = false
    let settled = false
    const settle = (callback, value) => { if (!settled) { settled = true; clearTimeout(timeout); callback(value) } }
    const append = chunk => { const text = String(chunk); const remaining = maxBytes - Buffer.byteLength(output, 'utf8'); if (remaining <= 0) { truncated = true; return }; const clipped = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8'); output += clipped; if (clipped.length < text.length) truncated = true }
    const child = spawn(command, args, { cwd: workspaceRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => { child.kill(); settle(reject, new Error(`${command} 超过 ${verificationTimeoutMs / 1000} 秒已停止\n${output}`.trim())) }, verificationTimeoutMs)
    child.stdout.on('data', append); child.stderr.on('data', append)
    child.on('error', error => settle(reject, new Error(`无法运行 ${command}：${error.message}`)))
    child.on('close', code => { const summary = `${output}${truncated ? '\n[输出已截断]' : ''}`.trim(); settle(code === 0 ? resolve : reject, code === 0 ? summary : new Error(`${command} 执行失败（退出码 ${code ?? '未知'}）\n${summary}`.trim())) })
  })
}
async function gitStatus() {
  const output = await runProcess('git', ['status', '--porcelain=v1', '--branch'])
  const lines = output.split(/\r?\n/).filter(Boolean)
  return { branch: lines.find(line => line.startsWith('## '))?.slice(3) || '', changes: lines.filter(line => !line.startsWith('## ')).map(line => ({ status: line.slice(0, 2), path: line.slice(3) })) }
}
async function gitDiff(filePath = '') {
  const args = ['diff', '--no-ext-diff', '--']
  if (filePath) args.push(path.relative(workspaceRoot, withinWorkspace(filePath)))
  return runProcess('git', args)
}
async function chooseWorkspace() {
  const result = await dialog.showOpenDialog({ title: '选择项目文件夹', properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  workspaceRoot = path.resolve(result.filePaths[0])
  return { root: workspaceRoot, name: path.basename(workspaceRoot), tree: await walk(workspaceRoot) }
}
async function createManagedWorkspace() {
  const root = path.join(app.getPath('appData'), 'Workmate', 'workspaces', randomUUID(), 'workspace')
  await mkdir(root, { recursive: true })
  workspaceRoot = root
  return { root, name: path.basename(root), tree: await walk(root) }
}
async function loadSettings() {
  try { return { ...defaults, ...JSON.parse(await readFile(configPath(), 'utf8')) } } catch { return { ...defaults } }
}
async function saveSettings(settings) {
  await mkdir(path.dirname(configPath()), { recursive: true })
  await writeFile(configPath(), JSON.stringify(settings), 'utf8')
}
async function getSecret() {
  const settings = await loadSettings()
  if (!settings.apiKey) return ''
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取 API 密钥')
  return safeStorage.decryptString(Buffer.from(settings.apiKey, 'base64'))
}
async function getDoubaoSearchSecret() {
  const settings = await loadSettings()
  if (!settings.doubaoSearchKey) return ''
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取豆包搜索 API 密钥')
  return safeStorage.decryptString(Buffer.from(settings.doubaoSearchKey, 'base64'))
}
async function settingsStatus() {
  const settings = await loadSettings()
  return { model: settings.model, autoWrite: settings.autoWrite, confirmBeforeWrite: settings.confirmBeforeWrite === true, allowWorkspaceCommands: settings.allowWorkspaceCommands === true, apiKeyConfigured: Boolean(settings.apiKey), doubaoSearchKeyConfigured: Boolean(settings.doubaoSearchKey), encryptionAvailable: safeStorage.isEncryptionAvailable(), workspaceOpen: Boolean(workspaceRoot) }
}
async function saveAiSettings(_, input) {
  const current = await loadSettings()
  if (input?.model !== undefined && input.model !== 'deepseek-chat' && input.model !== 'deepseek-reasoner') throw new Error('不支持的 DeepSeek 模型')
  const next = { ...current, model: input?.model ?? current.model, autoWrite: input?.autoWrite !== false, confirmBeforeWrite: typeof input?.confirmBeforeWrite === 'boolean' ? input.confirmBeforeWrite : current.confirmBeforeWrite === true, allowWorkspaceCommands: typeof input?.allowWorkspaceCommands === 'boolean' ? input.allowWorkspaceCommands : current.allowWorkspaceCommands === true }
  if (input?.clearKey) next.apiKey = ''
  if (input?.clearDoubaoSearchKey) next.doubaoSearchKey = ''
  if (typeof input?.apiKey === 'string' && input.apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API 密钥')
    next.apiKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64')
  }
  if (typeof input?.doubaoSearchKey === 'string' && input.doubaoSearchKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存豆包搜索 API 密钥')
    next.doubaoSearchKey = safeStorage.encryptString(input.doubaoSearchKey.trim()).toString('base64')
  }
  await saveSettings(next)
  return settingsStatus()
}
const tools = [
  { type: 'function', function: { name: 'list_files', description: '列出当前已打开工作区内的文件树。', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区内目录的绝对路径；省略表示根目录' } } } } },
  { type: 'function', function: { name: 'read_file', description: '读取当前工作区内一个 UTF-8 文本文件。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要读取文件的绝对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '自动修改或创建当前工作区内的 UTF-8 文本文件。仅在用户要求修改项目且自动写入已启用时使用。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要写入文件的绝对路径' }, content: { type: 'string', description: '完整替换后的文件内容' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'create_directory', description: '在当前工作区内创建目录，可递归创建不存在的父目录。仅在用户明确要求创建项目目录且自动写入已启用时使用。', parameters: { type: 'object', properties: { path: { type: 'string', description: '要创建目录的绝对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'submit_plan', description: '为需要分析、修改或验证的项目任务提交执行计划。仅在开始阶段使用一次，提供 2 到 6 个简短步骤；简单问答无需使用。', parameters: { type: 'object', properties: { steps: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'object', properties: { title: { type: 'string', description: '不超过 24 个字符的步骤标题' }, detail: { type: 'string', description: '不超过 80 个字符的步骤说明' } }, required: ['title', 'detail'] } } }, required: ['steps'] } } },
  { type: 'function', function: { name: 'search_workspace', description: '在当前工作区的文本文件中搜索关键词，返回匹配文件、行号和行内容。会跳过 node_modules、.git、构建产物、二进制和超过 5 MB 的文件。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词，最多 160 个字符' }, max_results: { type: 'integer', description: '返回结果数，范围 1 到 50，默认 20' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'git_status', description: '读取当前工作区的 Git 分支和文件状态。只读，不会修改 Git 仓库。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'git_diff', description: '读取当前工作区或指定文件的 Git 未暂存差异。只读，不会修改 Git 仓库。', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区内文件绝对路径；省略表示全部未暂存差异' } } } } },
  { type: 'function', function: { name: 'run_verification', description: '在当前工作区运行 npm 验证脚本。仅支持 build、test 或 lint；仅在设置允许 AI 运行验证命令且 package.json 中存在对应脚本时使用。执行修改后应优先运行与项目匹配的验证。', parameters: { type: 'object', properties: { script: { type: 'string', enum: ['build', 'test', 'lint'], description: '要运行的 package.json npm 脚本' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'web_search', description: '使用豆包搜索 Global 版查询近期或实时网络信息。结果应在回答中以 Markdown 链接注明来源。', parameters: { type: 'object', properties: { query: { type: 'string', description: '简洁的搜索关键词，最多 100 个字符' }, max_results: { type: 'integer', description: '返回结果数，范围 1 到 20，默认 10' } }, required: ['query'] } } }
]
function normalizePlanSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) throw new Error('任务计划必须包含 2 到 6 个步骤')
  const steps = rawSteps.slice(0, 6).map(step => ({ title: String(step?.title ?? '').trim().slice(0, 24), detail: String(step?.detail ?? '').trim().slice(0, 80) })).filter(step => step.title)
  if (steps.length < 2) throw new Error('任务计划至少需要 2 个有效步骤')
  return steps.map(step => ({ ...step, detail: step.detail || '等待执行' }))
}
async function readExistingTextFile(filePath) {
  const targetPath = withinWorkspace(filePath)
  try { await validateTextFile(targetPath); const content = await readFile(targetPath, 'utf8'); if (content.includes('\0')) throw new Error('不支持修改二进制文件'); return { content, exists: true } } catch (error) { if (error?.code === 'ENOENT') return { content: '', exists: false }; throw error }
}
function buildWritePreview(before, after, exists) {
  const oldLines = before.split(/\r?\n/)
  const newLines = after.split(/\r?\n/)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let oldSuffix = oldLines.length - 1; let newSuffix = newLines.length - 1
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) { oldSuffix -= 1; newSuffix -= 1 }
  const removed = Math.max(0, oldSuffix - prefix + 1); const added = Math.max(0, newSuffix - prefix + 1)
  const preview = [`${exists ? '修改' : '新建'}文件：${newLines.length} 行，${Buffer.byteLength(after, 'utf8')} 字节`, `变更：新增 ${added} 行，删除 ${removed} 行`]
  for (const line of oldLines.slice(prefix, oldSuffix + 1).slice(0, 4)) preview.push(`- ${line.slice(0, 180)}`)
  for (const line of newLines.slice(prefix, newSuffix + 1).slice(0, 4)) preview.push(`+ ${line.slice(0, 180)}`)
  if (removed > 4 || added > 4) preview.push('… 其余变更未显示')
  return preview.join('\n')
}
async function confirmWrite(event, filePath, before, after, exists) {
  const window = BrowserWindow.fromWebContents(event.sender)
  const relativePath = path.relative(workspaceRoot, withinWorkspace(filePath))
  const result = await dialog.showMessageBox(window ?? undefined, { type: 'question', buttons: ['允许写入', '拒绝'], defaultId: 0, cancelId: 1, title: '允许 AI 写入文件？', message: relativePath, detail: buildWritePreview(before, after, exists), noLink: true })
  return result.response === 0
}
async function runVerificationScript(script, reportProgress) {
  verificationScript(script, allowedVerificationScripts)
  const packagePath = path.join(workspaceRoot, 'package.json')
  let packageJson
  try { packageJson = JSON.parse(await readFile(packagePath, 'utf8')) } catch { throw new Error('当前工作区缺少可读取的 package.json') }
  if (typeof packageJson?.scripts?.[script] !== 'string') throw new Error(`package.json 未定义 npm run ${script} 脚本`)
  reportProgress(`正在运行 npm run ${script}…`)
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve, reject) => {
    let output = ''
    let outputTruncated = false
    const appendOutput = chunk => { const text = String(chunk); const remaining = maxVerificationOutputBytes - Buffer.byteLength(output, 'utf8'); if (remaining <= 0) { outputTruncated = true; return }; const clipped = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8'); output += clipped; if (Buffer.byteLength(clipped, 'utf8') < Buffer.byteLength(text, 'utf8')) outputTruncated = true }
    const child = spawn(npmCommand, ['run', script], { cwd: workspaceRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`npm run ${script} 超过 ${verificationTimeoutMs / 1000} 秒已停止\n${output}`.trim())) }, verificationTimeoutMs)
    child.stdout.on('data', appendOutput)
    child.stderr.on('data', appendOutput)
    child.on('error', error => { clearTimeout(timeout); reject(new Error(`无法启动 npm run ${script}：${error.message}`)) })
    child.on('close', code => { clearTimeout(timeout); const summary = `${output}${outputTruncated ? '\n[输出已截断]' : ''}`.trim(); if (code === 0) resolve(JSON.stringify({ success: true, script, output: summary || '命令已成功完成' })); else reject(new Error(`npm run ${script} 失败（退出码 ${code ?? '未知'}）\n${summary}`.trim())) })
  })
}
async function executeTool(event, name, args, autoWrite, confirmBeforeWrite, allowWorkspaceCommands, writes, standalone, reportProgress = () => {}, emitActivity = () => {}) {
  if (standalone && name !== 'web_search') throw new Error('独立会话不允许访问本地工作区')
  if (!standalone && name === 'web_search') throw new Error('项目会话不允许联网搜索')
  if (name === 'submit_plan') {
    const steps = normalizePlanSteps(args.steps)
    steps.forEach((step, index) => emitActivity({ id: `plan-${index}`, title: step.title, detail: step.detail, status: 'pending', kind: 'plan' }))
    return JSON.stringify({ success: true, steps: steps.length })
  }
  if (name === 'web_search') {
    reportProgress('正在查询豆包搜索…')
    const apiKey = await getDoubaoSearchSecret()
    if (!apiKey) throw new Error('请先在设置中保存豆包搜索 Global API 密钥以启用联网搜索')
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : ''
    if (!query) throw new Error('搜索关键词不能为空')
    const maxResults = Math.min(Math.max(Number(args.max_results) || 10, 1), 20)
    const response = await net.fetch('https://open.feedcoopapi.com/search_api/global_search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ Query: query, SearchType: 'web', DocCount: maxResults, MaxSnippetLength: 1000 }) })
    const data = await response.json()
    const metadataError = data?.ResponseMetadata?.Error
    const result = data?.Result
    if (!response.ok || metadataError || !result || result.ErrorCode) {
      const detail = metadataError?.Message ?? result?.ErrorMsg
      const requestId = data?.ResponseMetadata?.RequestId
      throw new Error(`${typeof detail === 'string' && detail ? detail : `豆包搜索请求失败（${response.status}）`}${requestId ? `，请求 ID：${requestId}` : ''}`)
    }
    const results = (result.Documents ?? []).slice(0, maxResults).map(item => ({
      title: String(item.Title ?? '').slice(0, 300),
      url: String(item.Url ?? '').slice(0, 2000),
      published_date: String(item.DocumentInfo?.PublishTime ?? '').slice(0, 80),
      content: (item.Snippet ?? []).filter(snippet => snippet?.Type === 'text').map(snippet => String(snippet.Text ?? '')).join('\n').slice(0, 1200),
      source: String(item.HostInfo?.Hostname ?? '').slice(0, 200),
      authority: String(item.HostInfo?.AuthorityLevel ?? '').slice(0, 40)
    }))
    reportProgress(`已获得 ${results.length} 条搜索结果，正在整理回答…`)
    return JSON.stringify({ total_results: Number(result.TotalDocCount) || results.length, results }).slice(0, 18000)
  }
  if (name === 'list_files') { reportProgress('正在读取工作区结构…'); const folder = args.path ? withinWorkspace(args.path) : workspaceRoot; const info = await stat(folder); if (!info.isDirectory()) throw new Error('path 必须是目录'); return JSON.stringify(await walk(folder, 0, 4)) }
  if (name === 'search_workspace') { reportProgress('正在搜索工作区代码…'); return JSON.stringify({ results: await searchWorkspace(args.query, args.max_results) }).slice(0, maxSearchOutputBytes) }
  if (name === 'git_status') { reportProgress('正在读取 Git 状态…'); return JSON.stringify(await gitStatus()) }
  if (name === 'git_diff') { reportProgress('正在读取 Git 差异…'); return await gitDiff(args.path) }
  if (name === 'read_file') { reportProgress('正在读取项目文件…'); return await readTextFile(args.path) }
  if (name === 'write_file') { reportProgress('正在准备写入项目文件…'); if (!autoWrite) throw new Error('自动写入已在设置中关闭'); if (typeof args.path !== 'string' || typeof args.content !== 'string') throw new Error('写入需要有效的 path 和 content'); const current = await readExistingTextFile(args.path); if (current.content === args.content) return JSON.stringify({ success: true, unchanged: true }); if (confirmBeforeWrite) { reportProgress('正在等待确认文件变更…'); if (!await confirmWrite(event, args.path, current.content, args.content, current.exists)) throw new Error('用户拒绝了本次文件写入') }; reportProgress('正在写入项目文件…'); await writeTextFile(args.path, args.content); writes.push(path.relative(workspaceRoot, withinWorkspace(args.path))); return JSON.stringify({ success: true }) }
  if (name === 'run_verification') {
    if (!allowWorkspaceCommands) throw new Error('AI 运行验证命令已在设置中关闭')
    const script = typeof args.script === 'string' ? args.script : ''
    return await runVerificationScript(script, reportProgress)
  }
  if (name === 'create_directory') {
    reportProgress('正在创建项目目录…')
    if (!autoWrite) throw new Error('自动写入已在设置中关闭')
    if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('目录路径不能为空')
    const targetPath = withinWorkspace(args.path)
    const relativePath = path.relative(workspaceRoot, targetPath)
    if (!relativePath) throw new Error('不能创建工作区根目录')
    try {
      const info = await stat(targetPath)
      if (!info.isDirectory()) throw new Error('目标路径已存在且不是目录')
      return JSON.stringify({ success: true, path: relativePath, existed: true })
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
    }
    await mkdir(targetPath, { recursive: true })
    writes.push(relativePath)
    return JSON.stringify({ success: true, path: relativePath })
  }
  throw new Error(`不支持的工具：${name}`)
}
async function readDeepSeekStream(response, onText) {
  if (!response.body) throw new Error('DeepSeek 未返回流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const toolCalls = new Map()
  let pending = ''
  let content = ''
  let usage = null
  const handlePayload = payload => {
    if (!payload || payload === '[DONE]') return
    const data = JSON.parse(payload)
    usage = data.usage ?? usage
    for (const choice of data.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) { content += delta.content; onText(delta.content) }
      for (const part of delta.tool_calls ?? []) {
        const index = Number(part.index) || 0
        const call = toolCalls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (part.id) call.id = part.id
        if (part.type) call.type = part.type
        if (part.function?.name) call.function.name += part.function.name
        if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments
        toolCalls.set(index, call)
      }
    }
  }
  while (true) {
    const { value, done } = await reader.read()
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const events = pending.split(/\r?\n\r?\n/)
    pending = events.pop() ?? ''
    for (const event of events) {
      const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (payload) handlePayload(payload)
    }
    if (done) break
  }
  const payload = pending.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  if (payload) handlePayload(payload)
  return { content, tool_calls: [...toolCalls.values()], usage }
}
async function callDeepSeek(event, input) {
  const standalone = input?.sessionType === 'standalone'
  const sessionKey = typeof input?.sessionKey === 'string' ? input.sessionKey.slice(0, 160) : ''
  const reportProgress = message => { if (sessionKey && !event.sender.isDestroyed()) event.sender.send('ai:progress', { sessionKey, message }) }
  const emitActivity = activity => { if (sessionKey && !event.sender.isDestroyed()) event.sender.send('ai:activity', { sessionKey, ...activity }) }
  const emitText = content => { if (sessionKey && !event.sender.isDestroyed()) event.sender.send('ai:stream', { sessionKey, content }) }
  if (!standalone && !workspaceRoot) throw new Error('请先打开本地项目，AI 才能读取或修改文件')
  const apiKey = await getSecret()
  if (!apiKey) throw new Error('请先在设置中保存 DeepSeek API 密钥')
  const settings = await loadSettings()
  const messages = Array.isArray(input?.messages) ? input.messages.slice(-16) : []
  const system = standalone
    ? { role: 'system', content: '你是 Workmate 的中文助手，正在进行独立对话，未关联本地工作区。可以使用 web_search 通过豆包搜索 Global 版查询实时网络信息，但绝不能声称能够看到、读取或修改本地文件。回答实时信息时应基于搜索结果，给出简洁总结并以 Markdown 链接列出来源。对于“今日新闻 Top 30”等需要较多实时信息的请求，按不同主题或地区发起至少三次不重复的简洁搜索，每次最多 20 条，再去重汇总；若结果不足，应如实说明。' }
    : { role: 'system', content: `你是 Workmate 的中文编程助手。当前工作区根目录为 ${workspaceRoot}。回答开发任务时，先按需使用 list_files、search_workspace 和 read_file 了解项目。对于需要分析、修改、修复、创建或验证的任务，必须在调用任何其他工具前先调用一次 submit_plan，提交 2 到 6 个清晰步骤；简单问答无需提交计划。需要了解变更时使用只读的 git_status 或 git_diff。用户明确要求创建目录、修改、修复或实现时，在 autoWrite=true 的情况下使用 create_directory 或 write_file 写入完整文件内容；不得访问工作区外路径、不得删除或重命名文件与目录。仅当设置允许 AI 运行验证命令时，才可调用 run_verification 执行 package.json 中存在的 npm run build、npm run test 或 npm run lint；不得执行任何其他命令。完成后简短说明读取、创建、写入和验证过的路径或命令。` }
  const conversation = [system, ...messages]
  const writes = []
  let usage = null
  let planSteps = []
  let activePlanStep = 0
  const emitPlanStatus = (index, status, detail) => {
    const planStep = planSteps[index]
    if (!planStep) return
    emitActivity({ id: `plan-${index}`, title: planStep.title, detail: detail ?? planStep.detail, status, kind: 'plan' })
  }
  for (let step = 0; step < maxToolIterations; step += 1) {
    const modelActivityId = `model-${step}`
    emitActivity({ id: modelActivityId, title: step === 0 ? '分析任务' : '整理工具结果', detail: step === 0 ? '正在判断完成任务需要的操作' : '正在结合已获得的信息继续处理', status: 'running' })
    reportProgress(step === 0 ? '正在请求 DeepSeek 分析任务…' : '正在根据检索结果整理回答…')
    const body = { model: settings.model, messages: conversation, temperature: 0.2, stream: true }
    if (standalone) { body.tools = tools.filter(tool => tool.function.name === 'web_search'); body.tool_choice = 'auto' } else { body.tools = tools.filter(tool => tool.function.name !== 'web_search' && (settings.allowWorkspaceCommands === true || tool.function.name !== 'run_verification')); body.tool_choice = 'auto' }
    const response = await net.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) })
    if (!response.ok) { const data = await response.json(); throw new Error(data?.error?.message || `DeepSeek 请求失败（${response.status}）`) }
    const message = await readDeepSeekStream(response, emitText)
    usage = message.usage ?? usage
    conversation.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls })
    emitActivity({ id: modelActivityId, title: step === 0 ? '分析任务' : '整理工具结果', detail: message.tool_calls?.length ? '已确定下一步需要调用工具' : '已生成最终答复', status: 'done' })
    if (!message.tool_calls?.length) { if (planSteps.length > activePlanStep) { for (let index = activePlanStep; index < planSteps.length; index += 1) emitPlanStatus(index, 'done', index === planSteps.length - 1 ? '已完成并生成最终答复' : '已完成') }; reportProgress('正在完成回复…'); return { text: message.content || '任务已完成。', writes, usage, model: settings.model } }
    if (message.content) emitText('\n\n')
    for (const call of message.tool_calls) {
      let result
      let args = {}
      let isPlanSubmission = false
      const toolId = `tool-${step}-${call.id || call.function.name}`
      const toolTitle = { submit_plan: '提交任务计划', web_search: '联网搜索', list_files: '读取目录', search_workspace: '搜索工作区', git_status: '读取 Git 状态', git_diff: '读取 Git 差异', read_file: '读取文件', write_file: '写入文件', create_directory: '创建目录', run_verification: '运行验证' }[call.function.name] || '调用工具'
      try {
        args = JSON.parse(call.function.arguments || '{}')
        isPlanSubmission = call.function.name === 'submit_plan'
        if (!isPlanSubmission && planSteps[activePlanStep]) emitPlanStatus(activePlanStep, 'running', '正在执行')
        const target = typeof args.path === 'string' && workspaceRoot ? path.relative(workspaceRoot, withinWorkspace(args.path)) : ''
        const detail = target ? `目标：${target}` : call.function.name === 'submit_plan' ? '正在整理任务步骤' : call.function.name === 'web_search' ? '正在查询互联网公开信息' : call.function.name === 'search_workspace' ? `关键词：${args.query ?? ''}` : call.function.name === 'git_status' ? '正在读取工作区状态' : call.function.name === 'git_diff' ? '正在读取未暂存变更' : call.function.name === 'run_verification' ? `正在运行 npm run ${args.script ?? ''}` : '正在执行项目操作'
        emitActivity({ id: toolId, title: toolTitle, detail, status: 'running' })
        result = await executeTool(event, call.function.name, args, settings.autoWrite, settings.confirmBeforeWrite === true, settings.allowWorkspaceCommands === true, writes, standalone, reportProgress, emitActivity)
        if (isPlanSubmission) { planSteps = normalizePlanSteps(args.steps); activePlanStep = 0 } else if (planSteps[activePlanStep]) { emitPlanStatus(activePlanStep, 'done', '已完成'); activePlanStep += 1 }
        const doneDetail = call.function.name === 'submit_plan' ? '已显示任务计划' : call.function.name === 'web_search' ? '已获取搜索结果，交给模型整理' : call.function.name === 'search_workspace' ? '已获得工作区匹配项' : call.function.name === 'git_status' ? '已获得 Git 状态' : call.function.name === 'git_diff' ? '已获得 Git 差异' : call.function.name === 'run_verification' ? `npm run ${args.script ?? ''} 已通过` : target ? `已完成：${target}` : '已完成'
        emitActivity({ id: toolId, title: toolTitle, detail: doneDetail, status: 'done' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!isPlanSubmission && planSteps[activePlanStep]) { emitPlanStatus(activePlanStep, 'error', `执行失败：${message.slice(0, 80)}`); activePlanStep += 1 }
        emitActivity({ id: toolId, title: toolTitle, detail: `执行失败：${message.slice(0, 160)}`, status: 'error' })
        result = `工具执行失败：${message}`
      }
      conversation.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result.slice(0, 120000) : JSON.stringify(result) })
    }
  }
  return { text: '已达到工具调用次数上限，请检查本次变更后继续。', writes, usage, model: settings.model }
}
function createWindow() {
  const window = new BrowserWindow({ width: 1480, height: 920, minWidth: 1100, minHeight: 680, title: 'Workmate v0.1.5', autoHideMenuBar: true, backgroundColor: '#edf1f7', webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  window.removeMenu(); window.setMenuBarVisibility(false)
  window.webContents.on('did-fail-load', (_, code, description, url) => console.error(`Renderer load failed (${code}) ${url}: ${description}`))
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) window.loadURL(devUrl); else window.loadURL('workmate://app/index.html')
}
ipcMain.handle('workspace:choose', chooseWorkspace)
ipcMain.handle('workspace:create-managed', createManagedWorkspace)
ipcMain.handle('workspace:refresh-tree', async () => { if (!workspaceRoot) throw new Error('请先选择工作区'); return walk(workspaceRoot) })
ipcMain.handle('workspace:read', (_, filePath) => readTextFile(filePath))
ipcMain.handle('workspace:write', (_, filePath, content) => writeTextFile(filePath, content))
ipcMain.handle('workspace:search', (_, query, maxResults) => searchWorkspace(query, maxResults))
ipcMain.handle('workspace:git-status', () => gitStatus())
ipcMain.handle('workspace:git-diff', (_, filePath) => gitDiff(filePath))
ipcMain.handle('ai:settings-status', settingsStatus)
ipcMain.handle('ai:save-settings', saveAiSettings)
ipcMain.handle('ai:chat', callDeepSeek)
app.whenReady().then(async () => {
  protocol.handle('workmate', request => { const url = new URL(request.url); const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); const filePath = path.resolve(rendererRoot, `.${requestPath}`); const relative = path.relative(rendererRoot, filePath); return relative.startsWith('..') || path.isAbsolute(relative) ? new Response('Not found', { status: 404 }) : net.fetch(pathToFileURL(filePath).toString()) })
  Menu.setApplicationMenu(null); createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
