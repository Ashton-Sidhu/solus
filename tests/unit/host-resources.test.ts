import { describe, expect, test } from 'bun:test'
import type { HostResources } from '@solus/contracts/host-resources'
import { cpuUtilizationBetween, darwinAvailableMemory, HostResourceReader, linuxAvailableMemory } from '../../packages/server/src/host/host-resources'

describe('machine load', () => {
  test('CPU use is the share of time that was not idle between two reads', () => {
    expect(cpuUtilizationBetween({ idle: 100, total: 200, count: 4 }, { idle: 125, total: 300, count: 4 })).toBe(0.75)
  })

  test('says it does not know, rather than a wrong number', () => {
    expect(cpuUtilizationBetween({ idle: 100, total: 200, count: 4 }, { idle: 125, total: 300, count: 8 })).toBeNull()
    expect(cpuUtilizationBetween({ idle: 100, total: 200, count: 4 }, { idle: 100, total: 200, count: 4 })).toBeNull()
  })

  test('Linux counts memory the kernel can give back as available', () => {
    expect(linuxAvailableMemory('MemTotal: 100 kB\nMemFree: 1 kB\nMemAvailable:    50 kB\n')).toBe(50 * 1024)
    expect(linuxAvailableMemory('MemTotal: 100 kB\n')).toBeNull()
  })

  test('macOS adds free, inactive, and speculative pages once', () => {
    const output = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:     10.\nPages inactive:    20.\nPages speculative:    5.\n'
    expect(darwinAvailableMemory(output)).toBe(35 * 16384)
    expect(darwinAvailableMemory('')).toBeNull()
  })
})

describe('HostResourceReader', () => {
  const resources: HostResources = { sampledAt: 1, cpuUtilization: 0.5, cpuCount: 4, availableMemoryBytes: 1, totalMemoryBytes: 2 }

  test('many clients in the same moment cost one read', async () => {
    let reads = 0
    let now = 0
    const reader = new HostResourceReader(async () => { reads += 1; return resources }, () => now)
    await Promise.all([reader.read(), reader.read(), reader.read()])
    await reader.read()
    expect(reads).toBe(1)
    now = 6_000
    await reader.read()
    expect(reads).toBe(2)
  })

  test('a failed read is not kept', async () => {
    let fail = true
    const reader = new HostResourceReader(async () => {
      if (fail) throw new Error('no')
      return resources
    })
    await expect(reader.read()).rejects.toThrow('no')
    fail = false
    expect(await reader.read()).toBe(resources)
  })
})
