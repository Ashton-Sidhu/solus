/*
 * QR Code generator adapted from Project Nayuki's TypeScript qrcodegen.
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

type Bit = number;
type Byte = number;
type Int = number;

export interface PairQrSvgPath {
  modules: number
  size: number
  viewBox: string
  path: string
}

const BYTE_MODE_BITS = 0x4;
const MEDIUM_FORMAT_BITS = 0;
const QUIET_ZONE = 4;

export function pairQrSvgPath(value: string): PairQrSvgPath {
  const qr = QrCode.encodeBytes(Array.from(new TextEncoder().encode(value)));
  const size = qr.size + QUIET_ZONE * 2;
  const commands: string[] = [];

  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) commands.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
    }
  }

  return {
    modules: qr.size,
    size,
    viewBox: `0 0 ${size} ${size}`,
    path: commands.join(" "),
  };
}

class QrCode {
  public readonly version: Int;
  public readonly size: Int;
  public readonly mask: Int;

  private readonly modules: Array<Array<boolean>> = [];
  private readonly isFunction: Array<Array<boolean>> = [];

  public static encodeBytes(data: Readonly<Array<Byte>>): QrCode {
    let version: Int;
    let dataUsedBits = 0;

    for (version = QrCode.MIN_VERSION; ; version++) {
      const charCountBits = byteModeCharCountBits(version);
      const usedBits = data.length >= 1 << charCountBits
        ? Infinity
        : 4 + charCountBits + data.length * 8;
      if (usedBits <= QrCode.getNumDataCodewords(version) * 8) {
        dataUsedBits = usedBits;
        break;
      }
      if (version >= QrCode.MAX_VERSION) throw new RangeError("Data too long");
    }

    const bb: Bit[] = [];
    appendBits(BYTE_MODE_BITS, 4, bb);
    appendBits(data.length, byteModeCharCountBits(version), bb);
    for (const b of data) appendBits(b, 8, bb);
    assert(bb.length == dataUsedBits);

    const dataCapacityBits = QrCode.getNumDataCodewords(version) * 8;
    appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
    appendBits(0, (8 - (bb.length % 8)) % 8, bb);
    assert(bb.length % 8 == 0);

    for (let padByte = 0xec; bb.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
      appendBits(padByte, 8, bb);
    }

    const dataCodewords: Byte[] = [];
    while (dataCodewords.length * 8 < bb.length) dataCodewords.push(0);
    bb.forEach((b, i) => (dataCodewords[i >>> 3]! |= b << (7 - (i & 7))));

    return new QrCode(version, dataCodewords, -1);
  }

  private constructor(version: Int, dataCodewords: Readonly<Array<Byte>>, msk: Int) {
    this.version = version;
    if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION) {
      throw new RangeError("Version value out of range");
    }
    if (msk < -1 || msk > 7) throw new RangeError("Mask value out of range");
    this.size = version * 4 + 17;

    const row: boolean[] = [];
    for (let i = 0; i < this.size; i++) row.push(false);
    for (let i = 0; i < this.size; i++) {
      this.modules.push(row.slice());
      this.isFunction.push(row.slice());
    }

    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(dataCodewords));

    if (msk == -1) {
      let minPenalty = 1_000_000_000;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          msk = i;
          minPenalty = penalty;
        }
        this.applyMask(i);
      }
    }

    assert(0 <= msk && msk <= 7);
    this.mask = msk;
    this.applyMask(msk);
    this.drawFormatBits(msk);
    this.isFunction = [];
  }

  public getModule(x: Int, y: Int): boolean {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y]![x]!;
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 == 0);
      this.setFunctionModule(i, 6, i % 2 == 0);
    }

    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    const alignPatPos = this.getAlignmentPatternPositions();
    const numAlign = alignPatPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if (!((i == 0 && j == 0) || (i == 0 && j == numAlign - 1) || (i == numAlign - 1 && j == 0))) {
          this.drawAlignmentPattern(alignPatPos[i]!, alignPatPos[j]!);
        }
      }
    }

    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFormatBits(mask: Int): void {
    const data = (MEDIUM_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    assert(bits >>> 15 == 0);

    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true);
  }

  private drawVersion(): void {
    if (this.version < 7) return;

    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    assert(bits >>> 18 == 0);

    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, color);
      this.setFunctionModule(b, a, color);
    }
  }

  private drawFinderPattern(x: Int, y: Int): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) {
          this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
        }
      }
    }
  }

  private drawAlignmentPattern(x: Int, y: Int): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
      }
    }
  }

  private setFunctionModule(x: Int, y: Int, isDark: boolean): void {
    this.modules[y]![x] = isDark;
    this.isFunction[y]![x] = true;
  }

  private addEccAndInterleave(data: Readonly<Array<Byte>>): Byte[] {
    if (data.length != QrCode.getNumDataCodewords(this.version)) throw new RangeError("Invalid argument");

    const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[this.version]!;
    const blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[this.version]!;
    const rawCodewords = Math.floor(QrCode.getNumRawDataModules(this.version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const blocks: Byte[][] = [];
    const rsDiv = QrCode.reedSolomonComputeDivisor(blockEccLen);

    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = QrCode.reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    const result: Byte[] = [];
    for (let i = 0; i < blocks[0]!.length; i++) {
      blocks.forEach((block, j) => {
        if (i != shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
      });
    }
    assert(result.length == rawCodewords);
    return result;
  }

  private drawCodewords(data: Readonly<Array<Byte>>): void {
    if (data.length != Math.floor(QrCode.getNumRawDataModules(this.version) / 8)) {
      throw new RangeError("Invalid argument");
    }

    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) == 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x]! && i < data.length * 8) {
            this.modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
    assert(i == data.length * 8);
  }

  private applyMask(mask: Int): void {
    if (mask < 0 || mask > 7) throw new RangeError("Mask value out of range");

    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 == 0;
            break;
          case 1:
            invert = y % 2 == 0;
            break;
          case 2:
            invert = x % 3 == 0;
            break;
          case 3:
            invert = (x + y) % 3 == 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) == 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 == 0;
            break;
          case 7:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 == 0;
            break;
          default:
            throw new Error("Unreachable");
        }
        if (!this.isFunction[y]![x]! && invert) this.modules[y]![x] = !this.modules[y]![x]!;
      }
    }
  }

  private getPenaltyScore(): Int {
    let result = 0;

    for (let y = 0; y < this.size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y]![x] === runColor) {
          runX++;
          if (runX == 5) result += QrCode.PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
          runColor = this.modules[y]![x]!;
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * QrCode.PENALTY_N3;
    }

    for (let x = 0; x < this.size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.size; y++) {
        if (this.modules[y]![x] === runColor) {
          runY++;
          if (runY == 5) result += QrCode.PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * QrCode.PENALTY_N3;
          runColor = this.modules[y]![x]!;
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * QrCode.PENALTY_N3;
    }

    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color = this.modules[y]![x]!;
        if (
          color == this.modules[y]![x + 1]! &&
          color == this.modules[y + 1]![x]! &&
          color == this.modules[y + 1]![x + 1]!
        ) {
          result += QrCode.PENALTY_N2;
        }
      }
    }

    let dark = 0;
    for (const row of this.modules) dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    assert(0 <= k && k <= 9);
    result += k * QrCode.PENALTY_N4;
    return result;
  }

  private getAlignmentPatternPositions(): Int[] {
    if (this.version == 1) return [];

    const numAlign = Math.floor(this.version / 7) + 2;
    const step = this.version == 32
      ? 26
      : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  private static getNumRawDataModules(ver: Int): Int {
    if (ver < QrCode.MIN_VERSION || ver > QrCode.MAX_VERSION) throw new RangeError("Version number out of range");

    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    assert(208 <= result && result <= 29648);
    return result;
  }

  private static getNumDataCodewords(ver: Int): Int {
    return (
      Math.floor(QrCode.getNumRawDataModules(ver) / 8) -
      QrCode.ECC_CODEWORDS_PER_BLOCK[ver]! * QrCode.NUM_ERROR_CORRECTION_BLOCKS[ver]!
    );
  }

  private static reedSolomonComputeDivisor(degree: Int): Byte[] {
    if (degree < 1 || degree > 255) throw new RangeError("Degree out of range");

    const result: Byte[] = [];
    for (let i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);

    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = QrCode.reedSolomonMultiply(result[j]!, root);
        if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
      }
      root = QrCode.reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  private static reedSolomonComputeRemainder(
    data: Readonly<Array<Byte>>,
    divisor: Readonly<Array<Byte>>,
  ): Byte[] {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ (result.shift() as Byte);
      result.push(0);
      divisor.forEach((coef, i) => (result[i]! ^= QrCode.reedSolomonMultiply(coef, factor)));
    }
    return result;
  }

  private static reedSolomonMultiply(x: Byte, y: Byte): Byte {
    if (x >>> 8 != 0 || y >>> 8 != 0) throw new RangeError("Byte out of range");

    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    assert(z >>> 8 == 0);
    return z as Byte;
  }

  private finderPenaltyCountPatterns(runHistory: Readonly<Array<Int>>): Int {
    const n = runHistory[1]!;
    assert(n <= this.size * 3);
    const core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n;
    return (
      (core && runHistory[0]! >= n * 4 && runHistory[6]! >= n ? 1 : 0) +
      (core && runHistory[6]! >= n * 4 && runHistory[0]! >= n ? 1 : 0)
    );
  }

  private finderPenaltyTerminateAndCount(
    currentRunColor: boolean,
    currentRunLength: Int,
    runHistory: Int[],
  ): Int {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size;
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  private finderPenaltyAddHistory(currentRunLength: Int, runHistory: Int[]): void {
    if (runHistory[0] === 0) currentRunLength += this.size;
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }

  private static readonly MIN_VERSION = 1;
  private static readonly MAX_VERSION = 40;
  private static readonly PENALTY_N1 = 3;
  private static readonly PENALTY_N2 = 3;
  private static readonly PENALTY_N3 = 40;
  private static readonly PENALTY_N4 = 10;

  private static readonly ECC_CODEWORDS_PER_BLOCK = [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ];

  private static readonly NUM_ERROR_CORRECTION_BLOCKS = [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ];
}

function byteModeCharCountBits(version: Int): Int {
  return version <= 9 ? 8 : 16;
}

function appendBits(val: Int, len: Int, bb: Bit[]): void {
  if (len < 0 || len > 31 || val >>> len != 0) throw new RangeError("Value out of range");
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

function getBit(x: Int, i: Int): boolean {
  return ((x >>> i) & 1) != 0;
}

function assert(cond: boolean): void {
  if (!cond) throw new Error("Assertion error");
}
