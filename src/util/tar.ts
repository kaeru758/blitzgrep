export interface TarEntry {
  path: string;
  data: Buffer;
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  let s = buf.toString('ascii', offset, offset + length);
  const nul = s.indexOf('\0');
  if (nul >= 0) {
    s = s.slice(0, nul);
  }
  s = s.trim();
  if (!s) {
    return 0;
  }
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul >= 0 ? nul : slice.length);
}

/**
 * 最小限の tar リーダー。GitHub の tarball (git archive 由来) を読むのに必要な範囲だけを扱う:
 * 通常ファイル・ustar prefix・GNU の長い名前 (typeflag 'L')・pax 拡張ヘッダ (typeflag 'x')。
 * `onEntry` が false を返したら解析を打ち切る。
 */
export function extractTar(buf: Buffer, onEntry: (entry: TarEntry) => boolean): void {
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    // 終端は 0 で埋まったブロック 2 つ。
    if (header.every((b) => b === 0)) {
      return;
    }
    offset += 512;

    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset;
    const dataEnd = Math.min(dataStart + size, buf.length);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      // GNU long name: このブロックのデータが次のエントリのパス。
      longName = buf.toString('utf8', dataStart, dataEnd).replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'X') {
      paxPath = parsePaxPath(buf.toString('utf8', dataStart, dataEnd));
      continue;
    }
    if (typeflag === 'g') {
      continue; // グローバル拡張ヘッダは無視
    }

    let path = longName ?? paxPath;
    if (!path) {
      const name = readString(header, 0, 100);
      const prefix = readString(header, 345, 155);
      path = prefix ? `${prefix}/${name}` : name;
    }
    longName = undefined;
    paxPath = undefined;

    // 通常ファイルのみ。'0' / '\0' が該当。
    if (typeflag !== '0' && typeflag !== '\0' && header[156] !== 0) {
      continue;
    }
    if (path.endsWith('/')) {
      continue;
    }
    if (!onEntry({ path, data: buf.subarray(dataStart, dataEnd) })) {
      return;
    }
  }
}

function parsePaxPath(record: string): string | undefined {
  // 形式: "<len> key=value\n" の連続
  const re = /(\d+) ([^=]+)=([^\n]*)\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(record)) !== null) {
    if (m[2] === 'path') {
      return m[3];
    }
  }
  return undefined;
}

/** GitHub の tarball は全エントリが "<owner>-<repo>-<sha>/" 配下にある。その 1 段を剥がす。 */
export function stripLeadingComponent(path: string): string {
  const i = path.indexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}
