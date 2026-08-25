/**
 * Just enough ZIP to unpack one release archive.
 *
 * Ketcher ships its browser build as a `.zip`, and Node has no zip reader. The
 * alternatives were a dependency or shelling out to `unzip` — one more supply
 * chain, or a tool Windows does not have. The format's central directory is
 * small and stable, so reading it here is the smaller commitment: deflate
 * itself still comes from `node:zlib`, and every entry's CRC is verified.
 *
 * Deliberately not supported: ZIP64, encryption, and multi-disk archives. Each
 * is detected and reported rather than silently mis-read.
 */

import { crc32, inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

const inflateRawAsync = promisify(inflateRaw)

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/** The largest comment a zip may carry, and so how far back the EOCD can sit. */
const MAX_COMMENT = 0xffff

/** One entry as described by the central directory. */
export interface ZipEntry {
  /** Path inside the archive, as stored (forward slashes). */
  name: string
  /** 0 = stored, 8 = deflate; anything else is refused on read. */
  method: number
  compressedSize: number
  uncompressedSize: number
  crc: number
  /** Offset of this entry's local header. */
  offset: number
}

/** Read the central directory. Throws with a named reason on anything unsupported. */
export function readEntries(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive)

  const disk = archive.readUInt16LE(eocd + 4)
  const count = archive.readUInt16LE(eocd + 10)
  const size = archive.readUInt32LE(eocd + 12)
  const start = archive.readUInt32LE(eocd + 16)
  if (disk !== 0) throw new Error('zip: multi-disk archives are not supported')
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new Error('zip: ZIP64 archives are not supported')
  }

  const entries: ZipEntry[] = []
  let cursor = start
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length) throw new Error('zip: central directory runs past the end of the archive')
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('zip: corrupt central directory')

    const flags = archive.readUInt16LE(cursor + 8)
    if ((flags & 0x1) !== 0) throw new Error('zip: encrypted archives are not supported')

    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    entries.push({
      name: archive.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: archive.readUInt16LE(cursor + 10),
      crc: archive.readUInt32LE(cursor + 16),
      compressedSize: archive.readUInt32LE(cursor + 20),
      uncompressedSize: archive.readUInt32LE(cursor + 24),
      offset: archive.readUInt32LE(cursor + 42),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Decompress one entry and check it against its recorded CRC.
 * @param archive - the whole archive.
 * @param entry - an entry from {@link readEntries}.
 */
export async function readEntry(archive: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (entry.offset + 30 > archive.length) throw new Error(`zip: ${entry.name} points past the end of the archive`)
  if (archive.readUInt32LE(entry.offset) !== LOCAL_SIGNATURE) throw new Error(`zip: ${entry.name} has no local header`)

  // The local header repeats the name and extra fields, and its lengths are the
  // authoritative ones — the central directory's may differ.
  const nameLength = archive.readUInt16LE(entry.offset + 26)
  const extraLength = archive.readUInt16LE(entry.offset + 28)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > archive.length) throw new Error(`zip: ${entry.name} is truncated`)

  const raw = archive.subarray(start, end)
  let data: Buffer
  if (entry.method === 0) data = Buffer.from(raw)
  else if (entry.method === 8) data = await inflateRawAsync(raw)
  else throw new Error(`zip: ${entry.name} uses compression method ${entry.method}, which is not supported`)

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`zip: ${entry.name} decompressed to ${data.length} bytes, expected ${entry.uncompressedSize}`)
  }
  if (crc32(data) !== entry.crc) throw new Error(`zip: ${entry.name} failed its checksum`)
  return data
}

/**
 * Whether an entry name is safe to join onto an extraction root.
 *
 * An archive is untrusted input: a name may be absolute, may climb out with
 * `..`, or may carry a Windows drive letter or backslash separator. Anything
 * that is not a plain relative forward-slash path is refused rather than
 * sanitised, because a rewritten path is a silently different file.
 */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return false
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false
  if (/^[a-zA-Z]:/.test(name)) return false
  return !name.split('/').includes('..')
}

/** Locate the end-of-central-directory record by scanning backwards for it. */
function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - MAX_COMMENT - 22)
  for (let at = archive.length - 22; at >= earliest; at -= 1) {
    if (archive.readUInt32LE(at) === EOCD_SIGNATURE) return at
  }
  throw new Error('zip: not a zip archive (no end-of-central-directory record)')
}
