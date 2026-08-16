export function securityPlanForArgs(args) {
  if (args.length === 0) {
    return Object.freeze({ dependencyAudit: true, imageScan: true, secretScan: true })
  }
  if (args.length === 1 && args[0] === '--secrets-only') {
    return Object.freeze({ dependencyAudit: false, imageScan: false, secretScan: true })
  }
  throw new Error(`Unsupported security arguments: ${args.join(' ')}`)
}
