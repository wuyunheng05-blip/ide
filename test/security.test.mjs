import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { searchQuery, verificationScript, withinRoot } from '../electron/security.mjs'

const root = path.resolve('fixture-workspace')

test('withinRoot accepts files in the workspace', () => {
  assert.equal(withinRoot(root, path.join(root, 'src', 'App.tsx')), path.join(root, 'src', 'App.tsx'))
})

test('withinRoot rejects paths outside the workspace', () => {
  assert.throws(() => withinRoot(root, path.resolve(root, '..', 'secret.txt')), /工作区外/)
})

test('searchQuery trims, limits, and requires text', () => {
  assert.equal(searchQuery('  Workmate  '), 'Workmate')
  assert.equal(searchQuery('a'.repeat(200)).length, 160)
  assert.throws(() => searchQuery('  '), /不能为空/)
})

test('verificationScript only accepts the static whitelist', () => {
  const allowed = new Set(['build', 'test', 'lint'])
  assert.equal(verificationScript('build', allowed), 'build')
  assert.throws(() => verificationScript('install', allowed), /仅允许/)
})
