const origin = process.env.SMOKE_ORIGIN ?? 'http://127.0.0.1:3100'

for (const path of ['/healthz', '/readyz']) {
  const response = await fetch(`${origin}${path}`)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
}

process.stdout.write('Smoke checks passed.\n')
