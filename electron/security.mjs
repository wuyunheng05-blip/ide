import path from 'node:path'

export function withinRoot(root, targetPath) {
  const resolved = path.resolve(targetPath)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('不允许访问工作区外的文件')
  return resolved
}

export function searchQuery(input) {
  const query = typeof input === 'string' ? input.trim().slice(0, 160) : ''
  if (!query) throw new Error('搜索关键词不能为空')
  return query
}

export function verificationScript(input, allowed) {
  const script = typeof input === 'string' ? input : ''
  if (!allowed.has(script)) throw new Error('仅允许运行 npm run build、npm run test 或 npm run lint')
  return script
}
