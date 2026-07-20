#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const VERSION = /^\d+\.\d+\.\d+$/
const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ALLOWED_TOP = ['schemaVersion', 'state', 'canonical', 'fork', 'omp', 'bun', 'release']
const ALLOWED_CANONICAL = ['repository', 'baseCommit']
const ALLOWED_FORK = ['repository', 'commit']
const ALLOWED_OMP = ['package', 'version']
const ALLOWED_BUN = ['version']
const ALLOWED_RELEASE = ['tag', 'artifact', 'sha256']

function fail(message) {
  console.error(`provenance: ${message}`)
  process.exit(1)
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object`)
}
function exactKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length) fail(`${name} has unexpected field(s): ${unexpected.join(', ')}`)
  for (const key of allowed) if (!(key in value)) fail(`${name}.${key} is required`)
}

const manifestFlag = process.argv.indexOf('--manifest')
if (manifestFlag !== -1 && !process.argv[manifestFlag + 1]) fail('--manifest requires a path')
const manifestPath = manifestFlag === -1 ? 'pi-per-provenance.json' : process.argv[manifestFlag + 1]
const requireAncestry = process.argv.includes('--require-ancestry')
const requireRelease = process.argv.includes('--require-release')

let manifest
try {
  manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'))
} catch (error) {
  fail(`cannot parse ${manifestPath}: ${error.message}`)
}

object(manifest, 'manifest')
exactKeys(manifest, ALLOWED_TOP, 'manifest')
if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
if (manifest.state !== 'draft' && manifest.state !== 'release')
  fail('state must be "draft" or "release"')

object(manifest.canonical, 'canonical')
exactKeys(manifest.canonical, ALLOWED_CANONICAL, 'canonical')
if (manifest.canonical.repository !== 'can1357/oh-my-pi')
  fail('canonical.repository must be can1357/oh-my-pi')
if (!HEX40.test(manifest.canonical.baseCommit))
  fail('canonical.baseCommit must be a lowercase 40-hex commit')

object(manifest.fork, 'fork')
exactKeys(manifest.fork, ALLOWED_FORK, 'fork')
if (manifest.fork.repository !== 'clssck/oh-my-pi') fail('fork.repository must be clssck/oh-my-pi')
if (!HEX40.test(manifest.fork.commit)) fail('fork.commit must be a lowercase 40-hex commit')

object(manifest.omp, 'omp')
exactKeys(manifest.omp, ALLOWED_OMP, 'omp')
if (manifest.omp.package !== '@oh-my-pi/pi-coding-agent')
  fail('omp.package has the wrong package identity')
if (!VERSION.test(manifest.omp.version)) fail('omp.version must be an exact x.y.z version')

object(manifest.bun, 'bun')
exactKeys(manifest.bun, ALLOWED_BUN, 'bun')
if (!VERSION.test(manifest.bun.version)) fail('bun.version must be an exact x.y.z version')

if (manifest.release === null) {
  if (manifest.state === 'release' || requireRelease)
    fail('release metadata is required for a release')
} else {
  object(manifest.release, 'release')
  exactKeys(manifest.release, ALLOWED_RELEASE, 'release')
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.release.tag))
    fail('release.tag must be an immutable vX.Y.Z tag')
  if (!ARTIFACT.test(manifest.release.artifact)) fail('release.artifact must be a basename')
  if (!HEX64.test(manifest.release.sha256))
    fail('release.sha256 must be a lowercase 64-hex SHA-256')
  if (manifest.state !== 'release') fail('state must be "release" when release metadata is present')
}

const root = dirname(resolve(manifestPath))
let packageJson
try {
  packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
} catch (error) {
  fail(`cannot read repository package.json: ${error.message}`)
}
if (packageJson.packageManager !== `bun@${manifest.bun.version}`) {
  fail(
    `bun.version does not match package.json packageManager (${packageJson.packageManager ?? 'missing'})`,
  )
}
let ompPackage
try {
  ompPackage = JSON.parse(readFileSync(resolve(root, 'packages/coding-agent/package.json'), 'utf8'))
} catch (error) {
  fail(`cannot read OMP package metadata: ${error.message}`)
}
if (ompPackage.name !== manifest.omp.package)
  fail('omp.package does not match packages/coding-agent/package.json')
if (ompPackage.version !== manifest.omp.version)
  fail(`omp.version does not match OMP package (${ompPackage.version ?? 'missing'})`)

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}
if (requireAncestry) {
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (inside.status !== 0 || inside.stdout.trim() !== 'true')
    fail('Git metadata is required for --require-ancestry')
  const baseToFork = git([
    'merge-base',
    '--is-ancestor',
    manifest.canonical.baseCommit,
    manifest.fork.commit,
  ])
  if (baseToFork.status !== 0) fail('canonical.baseCommit is not an ancestor of fork.commit')
  const forkToHead = git(['merge-base', '--is-ancestor', manifest.fork.commit, 'HEAD'])
  if (forkToHead.status !== 0) fail('fork.commit is not reachable from HEAD')
}

console.log(`provenance: valid ${manifestPath} (${manifest.state})`)
