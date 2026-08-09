import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const repository = process.cwd()
let failed = false
const gitleaksImage =
  'ghcr.io/gitleaks/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9'
const trivyImage =
  'aquasec/trivy:0.73.0@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c'

function runCheck(check) {
  console.log(`Running ${check.name}...`)
  const result = spawnSync(check.command, check.args, { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
    console.error(`${check.name} failed with status ${result.status ?? 'unknown'}`)
  }
}

// The registry has not published a fixed image-size release for these two advisories.
// Both parser loops are fixed by patches/image-size@2.0.2.patch and exercised by
// tests/unit/dependency-security.test.ts. Trivy reports the CVE as the primary ID, so
// the image gate matches these exact GHSAs through each finding's VendorIDs instead.
const locallyPatchedExceptions = [
  {
    id: 'GHSA-w3rx-r6r6-pgpr',
    packageName: 'image-size',
    version: '2.0.2',
    reason:
      'Upstream has no patched release; the ICNS zero-length loop is fixed by patches/image-size@2.0.2.patch.',
  },
  {
    id: 'GHSA-5p2g-fcmc-qvqq',
    packageName: 'image-size',
    version: '2.0.2',
    reason:
      'Upstream has no patched release; the JXL/HEIF zero-length loops are fixed by patches/image-size@2.0.2.patch.',
  },
]

const exceptionIds = locallyPatchedExceptions.map(({ id }) => id)
if (
  new Set(exceptionIds).size !== exceptionIds.length ||
  exceptionIds.some((id) => !/^GHSA-[\da-z]+-[\da-z]+-[\da-z]+$/u.test(id)) ||
  locallyPatchedExceptions.some(({ packageName, reason, version }) =>
    [packageName, reason, version].some((value) => value.length === 0),
  )
) {
  throw new Error(
    'Security exceptions must use unique exact GHSA IDs and include a package, version, and reason',
  )
}

runCheck({
  command: 'pnpm',
  args: [
    'audit',
    '--prod',
    '--audit-level',
    'high',
    ...exceptionIds.flatMap((advisory) => ['--ignore', advisory]),
  ],
  name: 'dependency audit',
})

const gitFiles = spawnSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: repository },
)
if (gitFiles.status !== 0) {
  throw new Error('Unable to enumerate repository-visible files for secret scanning')
}

const temporaryPrefix = join(tmpdir(), 'wanmi-gitleaks-')
const scanRoot = mkdtempSync(temporaryPrefix)

try {
  for (const relativePath of gitFiles.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const source = resolve(repository, relativePath)
    const destination = resolve(scanRoot, relativePath)
    if (!source.startsWith(`${repository}${sep}`) || !destination.startsWith(`${scanRoot}${sep}`)) {
      throw new Error(`Refusing to scan path outside repository: ${relativePath}`)
    }
    if (!existsSync(source)) continue

    mkdirSync(dirname(destination), { recursive: true })
    const metadata = lstatSync(source)
    if (metadata.isFile()) copyFileSync(source, destination)
    if (metadata.isSymbolicLink()) writeFileSync(destination, readlinkSync(source))
  }

  runCheck({
    command: 'docker',
    args: [
      'run',
      '--rm',
      '-v',
      `${scanRoot}:/repo:ro`,
      gitleaksImage,
      'detect',
      '--no-banner',
      '--no-git',
      '--redact',
      '--verbose',
      '--config=/repo/.gitleaks.toml',
      '--source=/repo',
    ],
    name: 'working tree secret scan',
  })
} finally {
  if (!scanRoot.startsWith(temporaryPrefix)) {
    throw new Error('Refusing to remove unexpected secret-scan directory')
  }
  rmSync(scanRoot, { recursive: true })
}

runCheck({
  command: 'docker',
  args: [
    'run',
    '--rm',
    '-v',
    `${repository}:/repo:ro`,
    gitleaksImage,
    'detect',
    '--no-banner',
    '--redact',
    '--verbose',
    '--config=/repo/.gitleaks-history.toml',
    '--source=/repo',
  ],
  name: 'complete git history secret scan',
})

console.log('Running linux/amd64 image vulnerability scan...')
const trivyScan = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    'wanmi-trivy-cache:/root/.cache/trivy',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    trivyImage,
    'image',
    '--scanners',
    'vuln',
    '--severity',
    'HIGH,CRITICAL',
    '--format',
    'json',
    'wanmi-web:d0',
  ],
  { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
)

if (trivyScan.stderr) process.stderr.write(trivyScan.stderr)
if (trivyScan.status !== 0) {
  failed = true
  console.error(
    `linux/amd64 image vulnerability scan failed with status ${trivyScan.status ?? 'unknown'}`,
  )
} else {
  try {
    const report = JSON.parse(trivyScan.stdout)
    const findings = (report.Results ?? []).flatMap((result) => result.Vulnerabilities ?? [])
    const unapprovedFindings = []

    for (const finding of findings) {
      const vendorIds = Array.isArray(finding.VendorIDs) ? finding.VendorIDs : []
      const exception = locallyPatchedExceptions.find(
        ({ id, packageName, version }) =>
          vendorIds.includes(id) &&
          finding.PkgName === packageName &&
          finding.InstalledVersion === version,
      )

      if (!exception) {
        unapprovedFindings.push(finding)
        continue
      }

      console.log(
        `Allowed ${exception.id} for ${exception.packageName}@${exception.version}: ${exception.reason}`,
      )
    }

    if (unapprovedFindings.length > 0) {
      failed = true
      for (const finding of unapprovedFindings) {
        console.error(
          `Unapproved ${finding.Severity ?? 'UNKNOWN'} finding: ${finding.VulnerabilityID ?? 'unknown'} in ${finding.PkgName ?? 'unknown'}@${finding.InstalledVersion ?? 'unknown'}`,
        )
      }
    }
  } catch (error) {
    failed = true
    console.error(
      `Unable to evaluate the Trivy image report: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}

process.exit(failed ? 1 : 0)
