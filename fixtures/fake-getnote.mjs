#!/usr/bin/env node

const args = process.argv.slice(2)

if (args.includes('--fail')) {
  process.stderr.write('simulated failure')
  process.exit(7)
}

process.stdout.write(JSON.stringify({ args }))
