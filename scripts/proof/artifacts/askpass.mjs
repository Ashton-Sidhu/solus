#!/usr/bin/env node
const prompt = process.argv[2] ?? ''
const origin = process.env.ARTIFACTS_GIT_ORIGIN
const address = prompt.match(/'(https:\/\/[^']+)'/)?.[1]
if (!origin || !address || new URL(address).origin !== origin) process.exit(1)
if (/username/i.test(prompt)) process.stdout.write('x\n')
else if (/password/i.test(prompt) && process.env.ARTIFACTS_GIT_TOKEN) process.stdout.write(`${process.env.ARTIFACTS_GIT_TOKEN.split('?expires=')[0]}\n`)
else process.exit(1)
