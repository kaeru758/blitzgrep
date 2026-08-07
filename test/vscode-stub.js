// テスト用の最小 vscode スタブ。拡張機能ホスト無しで実プロバイダを動かすために使う。
const fs = require('node:fs');
const path = require('node:path');

const overrides = {};

/**
 * インストール済み VS Code の appRoot を探す。
 * 新しめの Windows 版はコミットハッシュのディレクトリ配下にあり、更新のたびに名前が変わるので走査する。
 */
let appRootCache;
function detectAppRoot() {
  if (appRootCache !== undefined) {
    return appRootCache;
  }
  if (process.env.BLITZ_TEST_APPROOT) {
    appRootCache = process.env.BLITZ_TEST_APPROOT;
    return appRootCache;
  }
  const bases =
    process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'),
          path.join(process.env.ProgramFiles || '', 'Microsoft VS Code'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/Resources']
        : ['/usr/share/code'];

  const candidates = [];
  for (const base of bases) {
    if (!base) continue;
    candidates.push(path.join(base, 'resources', 'app'));
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        candidates.push(path.join(base, e.name, 'resources', 'app'));
      }
    }
  }
  appRootCache =
    candidates.find((c) => {
      try {
        return fs.statSync(path.join(c, 'node_modules.asar.unpacked')).isDirectory();
      } catch {
        return false;
      }
    }) || '';
  return appRootCache;
}

class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  get event() {
    return (fn) => {
      this.listeners.push(fn);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
    };
  }
  fire(value) {
    for (const l of [...this.listeners]) {
      l(value);
    }
  }
  dispose() {
    this.listeners = [];
  }
}

class CancellationTokenSource {
  constructor() {
    this.emitter = new EventEmitter();
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this.emitter.event,
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this.emitter.fire(undefined);
  }
  dispose() {
    this.emitter.dispose();
  }
}

const Uri = {
  file(p) {
    return makeUri({ scheme: 'file', path: p.replace(/\\/g, '/'), fsPath: p });
  },
  parse(s) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(s);
    if (!m) {
      return makeUri({ scheme: 'file', path: s, fsPath: s });
    }
    return makeUri({ scheme: m[1], authority: m[2] || '', path: m[3] || '', query: m[4] || '', fsPath: m[3] });
  },
  from(parts) {
    return makeUri({ ...parts, fsPath: parts.path });
  },
  joinPath(base, ...segs) {
    return makeUri({ ...base, path: [base.path, ...segs].join('/') });
  },
};

function makeUri(parts) {
  const u = {
    scheme: parts.scheme || 'file',
    authority: parts.authority || '',
    path: parts.path || '',
    query: parts.query || '',
    fragment: parts.fragment || '',
    fsPath: parts.fsPath ?? (parts.path || '').replace(/\//g, path.sep),
    with(change) {
      return makeUri({ ...this, ...change });
    },
    toString() {
      const auth = this.authority ? `//${this.authority}` : '';
      const q = this.query ? `?${this.query}` : '';
      return `${this.scheme}:${auth}${this.path}${q}`;
    },
  };
  return u;
}

module.exports = {
  __setConfig(section, values) {
    overrides[section] = { ...(overrides[section] || {}), ...values };
  },
  EventEmitter,
  CancellationTokenSource,
  Uri,
  env: {
    get appRoot() {
      return detectAppRoot();
    },
  },
  workspace: {
    isTrusted: true,
    getConfiguration(section) {
      return {
        get(key, def) {
          const bag = overrides[section] || {};
          return key in bag ? bag[key] : def;
        },
      };
    },
  },
  window: {
    createOutputChannel() {
      const quiet = process.env.BLITZ_TEST_VERBOSE !== '1';
      const write = (level) => (msg) => {
        if (!quiet) {
          console.log(`[${level}] ${msg}`);
        }
      };
      return {
        info: write('info'),
        warn: write('warn'),
        error: write('error'),
        debug: write('debug'),
        show() {},
        dispose() {},
      };
    },
  },
};
