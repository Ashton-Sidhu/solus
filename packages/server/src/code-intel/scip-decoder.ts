// Decodes a SCIP index (https://github.com/sourcegraph/scip/blob/main/scip.proto)
// straight from protobuf wire format. Only the fields Solus reads are decoded;
// every other field is skipped by wire type, so newer producers stay readable.
// Hand-rolled on purpose: the schema is small and stable, and a protobuf
// runtime plus a vendored .proto would be the larger dependency.

export interface ScipRange {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

/** Bit flags on `Occurrence.symbol_roles`. */
export const SCIP_ROLE_DEFINITION = 0x1
export const SCIP_ROLE_IMPORT = 0x2

export interface ScipOccurrence {
  range: ScipRange
  symbol: string
  symbolRoles: number
}

export interface ScipRelationship {
  symbol: string
  isReference: boolean
  isImplementation: boolean
  isTypeDefinition: boolean
  isDefinition: boolean
}

export interface ScipSymbolInformation {
  symbol: string
  documentation: string[]
  relationships: ScipRelationship[]
  /** `SymbolInformation.Kind` enum value; 0 when the producer left it unset. */
  kind: number
  displayName: string
  /** `signature_documentation.text`, when the producer emitted one. */
  signature: string
  enclosingSymbol: string
}

export interface ScipDocument {
  relativePath: string
  language: string
  occurrences: ScipOccurrence[]
  symbols: ScipSymbolInformation[]
  /** `PositionEncoding` enum value; 0 means unspecified (UTF-8 in practice). */
  positionEncoding: number
}

export interface ScipIndex {
  projectRoot: string
  toolName: string
  toolVersion: string
  documents: ScipDocument[]
  externalSymbols: ScipSymbolInformation[]
}

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

const utf8 = new TextDecoder()

class WireReader {
  pos = 0
  constructor(readonly bytes: Uint8Array, readonly end: number = bytes.length) {}

  get done(): boolean {
    return this.pos >= this.end
  }

  varint(): number {
    let result = 0
    let shift = 0
    while (true) {
      if (this.pos >= this.end) throw new Error('scip: truncated varint')
      const byte = this.bytes[this.pos++]!
      // Past 2^53 the shift would lose precision; SCIP never encodes such values.
      if (shift < 53) result += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return result
      shift += 7
    }
  }

  /** Reads a length-delimited payload and returns a reader scoped to it. */
  message(): WireReader {
    const length = this.varint()
    const start = this.pos
    if (start + length > this.end) throw new Error('scip: truncated message')
    this.pos = start + length
    return new WireReader(this.bytes, start + length).seek(start)
  }

  string(): string {
    const length = this.varint()
    const start = this.pos
    if (start + length > this.end) throw new Error('scip: truncated string')
    this.pos = start + length
    return utf8.decode(this.bytes.subarray(start, this.pos))
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint()
        return
      case WIRE_FIXED64:
        this.pos += 8
        return
      case WIRE_LENGTH: {
        // Read the length first: `pos += varint()` would capture pos before
        // the varint advanced it.
        const length = this.varint()
        this.pos += length
        return
      }
      case WIRE_FIXED32:
        this.pos += 4
        return
      default:
        throw new Error(`scip: unsupported wire type ${wireType}`)
    }
  }

  private seek(pos: number): this {
    this.pos = pos
    return this
  }
}

/** Walks every field in a message, handing (fieldNumber, wireType) to `visit`.
 *  `visit` must consume the field's payload or return false to have it skipped. */
function forEachField(reader: WireReader, visit: (field: number, wireType: number) => boolean): void {
  while (!reader.done) {
    const tag = reader.varint()
    const field = Math.floor(tag / 8)
    const wireType = tag % 8
    if (!visit(field, wireType)) reader.skip(wireType)
  }
}

/** Packed (or, for old producers, unpacked) repeated int32. */
function readInt32List(reader: WireReader, wireType: number, into: number[]): void {
  if (wireType === WIRE_LENGTH) {
    const packed = reader.message()
    while (!packed.done) into.push(packed.varint())
  } else {
    into.push(reader.varint())
  }
}

function rangeFromList(values: number[]): ScipRange | null {
  if (values.length === 3) {
    return { startLine: values[0]!, startCharacter: values[1]!, endLine: values[0]!, endCharacter: values[2]! }
  }
  if (values.length === 4) {
    return { startLine: values[0]!, startCharacter: values[1]!, endLine: values[2]!, endCharacter: values[3]! }
  }
  return null
}

function readSingleLineRange(reader: WireReader): ScipRange {
  const range: ScipRange = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 }
  forEachField(reader, (field) => {
    if (field === 1) {
      range.startLine = range.endLine = reader.varint()
      return true
    }
    if (field === 2) {
      range.startCharacter = reader.varint()
      return true
    }
    if (field === 3) {
      range.endCharacter = reader.varint()
      return true
    }
    return false
  })
  return range
}

function readMultiLineRange(reader: WireReader): ScipRange {
  const range: ScipRange = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 }
  forEachField(reader, (field) => {
    if (field === 1) range.startLine = reader.varint()
    else if (field === 2) range.startCharacter = reader.varint()
    else if (field === 3) range.endLine = reader.varint()
    else if (field === 4) range.endCharacter = reader.varint()
    else return false
    return true
  })
  return range
}

function readOccurrence(reader: WireReader): ScipOccurrence | null {
  const legacyRange: number[] = []
  let typedRange: ScipRange | null = null
  let symbol = ''
  let symbolRoles = 0
  forEachField(reader, (field, wireType) => {
    switch (field) {
      case 1:
        readInt32List(reader, wireType, legacyRange)
        return true
      case 2:
        symbol = reader.string()
        return true
      case 3:
        symbolRoles = reader.varint()
        return true
      case 8:
        typedRange = readSingleLineRange(reader.message())
        return true
      case 9:
        typedRange = readMultiLineRange(reader.message())
        return true
      default:
        return false
    }
  })
  const range = typedRange ?? rangeFromList(legacyRange)
  if (!range || !symbol) return null
  return { range, symbol, symbolRoles }
}

function readRelationship(reader: WireReader): ScipRelationship {
  const relationship: ScipRelationship = {
    symbol: '',
    isReference: false,
    isImplementation: false,
    isTypeDefinition: false,
    isDefinition: false,
  }
  forEachField(reader, (field) => {
    switch (field) {
      case 1:
        relationship.symbol = reader.string()
        return true
      case 2:
        relationship.isReference = reader.varint() !== 0
        return true
      case 3:
        relationship.isImplementation = reader.varint() !== 0
        return true
      case 4:
        relationship.isTypeDefinition = reader.varint() !== 0
        return true
      case 5:
        relationship.isDefinition = reader.varint() !== 0
        return true
      default:
        return false
    }
  })
  return relationship
}

function readSignatureText(reader: WireReader): string {
  let text = ''
  forEachField(reader, (field) => {
    if (field !== 5) return false
    text = reader.string()
    return true
  })
  return text
}

function readSymbolInformation(reader: WireReader): ScipSymbolInformation {
  const info: ScipSymbolInformation = {
    symbol: '',
    documentation: [],
    relationships: [],
    kind: 0,
    displayName: '',
    signature: '',
    enclosingSymbol: '',
  }
  forEachField(reader, (field) => {
    switch (field) {
      case 1:
        info.symbol = reader.string()
        return true
      case 3:
        info.documentation.push(reader.string())
        return true
      case 4:
        info.relationships.push(readRelationship(reader.message()))
        return true
      case 5:
        info.kind = reader.varint()
        return true
      case 6:
        info.displayName = reader.string()
        return true
      case 7:
        info.signature = readSignatureText(reader.message())
        return true
      case 8:
        info.enclosingSymbol = reader.string()
        return true
      default:
        return false
    }
  })
  return info
}

function readDocument(reader: WireReader): ScipDocument {
  const document: ScipDocument = {
    relativePath: '',
    language: '',
    occurrences: [],
    symbols: [],
    positionEncoding: 0,
  }
  forEachField(reader, (field) => {
    switch (field) {
      case 1:
        document.relativePath = reader.string()
        return true
      case 2: {
        const occurrence = readOccurrence(reader.message())
        if (occurrence) document.occurrences.push(occurrence)
        return true
      }
      case 3:
        document.symbols.push(readSymbolInformation(reader.message()))
        return true
      case 4:
        document.language = reader.string()
        return true
      case 6:
        document.positionEncoding = reader.varint()
        return true
      default:
        return false
    }
  })
  return document
}

function readToolInfo(reader: WireReader, index: ScipIndex): void {
  forEachField(reader, (field) => {
    if (field === 1) index.toolName = reader.string()
    else if (field === 2) index.toolVersion = reader.string()
    else return false
    return true
  })
}

function readMetadata(reader: WireReader, index: ScipIndex): void {
  forEachField(reader, (field) => {
    if (field === 2) {
      readToolInfo(reader.message(), index)
      return true
    }
    if (field === 3) {
      index.projectRoot = reader.string()
      return true
    }
    return false
  })
}

export function decodeScipIndex(bytes: Uint8Array): ScipIndex {
  const index: ScipIndex = {
    projectRoot: '',
    toolName: '',
    toolVersion: '',
    documents: [],
    externalSymbols: [],
  }
  const reader = new WireReader(bytes)
  forEachField(reader, (field) => {
    switch (field) {
      case 1:
        readMetadata(reader.message(), index)
        return true
      case 2:
        index.documents.push(readDocument(reader.message()))
        return true
      case 3:
        index.externalSymbols.push(readSymbolInformation(reader.message()))
        return true
      default:
        return false
    }
  })
  return index
}
