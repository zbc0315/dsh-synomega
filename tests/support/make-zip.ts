/**
 * A minimal zip writer, so tests can build the archives they need.
 *
 * Only what `src/zip.ts` claims to read is emitted: stored and deflated
 * entries, one disk, no ZIP64. Writing them here keeps the hostile cases
 * (an entry that climbs out of the root, a flipped byte) expressible.
 */

import { crc32, deflateRawSync } from 'node:zlib'

export interface Member { name: string, body: string, store?: boolean }

/** Write a minimal but standards-shaped zip. */
export function makeZip(members: readonly Member[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const member of members) {
    const raw = Buffer.from(member.body, 'utf8')
    const data = member.store === true ? raw : deflateRawSync(raw)
    const name = Buffer.from(member.name, 'utf8')
    const sum = crc32(raw)
    const method = member.store === true ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }

  const body = Buffer.concat(locals)
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

