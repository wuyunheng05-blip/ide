import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const indexPath = path.join(here, '..', 'dist', 'index.html')
const html = await readFile(indexPath, 'utf8')
const relativeAssets = html.replaceAll('src="/assets/', 'src="./assets/').replaceAll('href="/assets/', 'href="./assets/')

if (relativeAssets.includes('src="/assets/') || relativeAssets.includes('href="/assets/')) {
  throw new Error('无法将构建资源转换为相对路径')
}
await writeFile(indexPath, relativeAssets, 'utf8')
console.log('已将生产资源路径转换为相对路径。')
