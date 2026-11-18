#!/usr/bin/env node

const args = process.argv.slice(2)

if (args.includes('--fail')) {
  process.stderr.write('simulated failure')
  process.exit(7)
}

if (args.includes('--outdated')) {
  process.stderr.write('Error: unknown command "outline" for "getnote note"')
  process.exit(1)
}

let stdin = null
if (args.includes('--stdin')) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  stdin = Buffer.concat(chunks).toString('utf8')
}

process.stdout.write(JSON.stringify(stdin === null ? { args } : { args, stdin }))
