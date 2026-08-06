export function formatCnyFen(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('金额必须是非负安全整数分')
  const amount = BigInt(value)
  const yuan = amount / 100n
  const fen = amount % 100n
  return `¥${yuan.toLocaleString('zh-CN')}.${fen.toString().padStart(2, '0')}`
}
