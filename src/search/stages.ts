import type { HitSink, SearchHit, SearchStage, StageStatus } from '../types';

/** 件数の更新は頻繁に来るので、この間隔まで間引いてから UI へ送る。 */
const EMIT_INTERVAL_MS = 80;

/**
 * 検索パイプラインの進行を貯めて UI へ流す。
 *
 * 走り始める前に全段を `plan` で登録しておくのが肝。
 * 「これから 3 つ走る」が先に見えていれば、途中の空白時間が待ちとして納得できる。
 */
export class StageTracker {
  private stages: SearchStage[] = [];
  private readonly startedAt = new Map<string, number>();
  private lastEmit = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onChange: (stages: SearchStage[]) => void) {}

  plan(stages: Array<Pick<SearchStage, 'key' | 'icon' | 'label'>>): void {
    this.stages = stages.map((s) => ({ ...s, status: 'pending', count: 0 }));
    this.emit(true);
  }

  begin(key: string): void {
    const stage = this.find(key);
    if (!stage) {
      return;
    }
    stage.status = 'running';
    this.startedAt.set(key, Date.now());
    this.emit(true);
  }

  note(key: string, note: string): void {
    const stage = this.find(key);
    if (!stage) {
      return;
    }
    stage.note = note;
    this.emit(true);
  }

  progress(key: string, fraction: number, note?: string): void {
    const stage = this.find(key);
    if (!stage) {
      return;
    }
    stage.progress = Math.max(0, Math.min(1, fraction));
    if (note !== undefined) {
      stage.note = note;
    }
    this.emit(false);
  }

  addCount(key: string, n: number): void {
    const stage = this.find(key);
    if (!stage || n === 0) {
      return;
    }
    stage.count += n;
    this.emit(false);
  }

  finish(key: string, status: Exclude<StageStatus, 'pending' | 'running'>, note?: string): void {
    const stage = this.find(key);
    if (!stage) {
      return;
    }
    stage.status = status;
    stage.progress = status === 'done' ? 1 : stage.progress;
    if (note !== undefined) {
      stage.note = note;
    }
    const started = this.startedAt.get(key);
    if (started !== undefined) {
      stage.durationMs = Date.now() - started;
    }
    this.emit(true);
  }

  /** 走らずに終わった段を畳む (打ち切り・エラーで途中終了したとき)。 */
  settleRemaining(status: Exclude<StageStatus, 'pending' | 'running'>, note?: string): void {
    let changed = false;
    for (const stage of this.stages) {
      if (stage.status === 'pending' || stage.status === 'running') {
        stage.status = status;
        if (note !== undefined && !stage.note) {
          stage.note = note;
        }
        changed = true;
      }
    }
    if (changed) {
      this.emit(true);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      // 間引きで保留していた更新を捨てると、最後の件数が届かないままになる。
      this.emit(true);
    }
  }

  private find(key: string): SearchStage | undefined {
    return this.stages.find((s) => s.key === key);
  }

  private emit(force: boolean): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const now = Date.now();
    if (!force && now - this.lastEmit < EMIT_INTERVAL_MS) {
      // 落とさずに遅らせる。最後の件数が届かないと「1 件足りない」表示になる。
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.emit(true);
      }, EMIT_INTERVAL_MS);
      return;
    }
    this.lastEmit = now;
    this.onChange(this.stages.map((s) => ({ ...s })));
  }
}

/** ヒットをその段の件数として数えながら、本体のシンクへ素通しする。 */
export function stageSink(inner: HitSink, tracker: StageTracker, key: string): HitSink & { count: number } {
  const wrapper = {
    count: 0,
    push(hits: SearchHit[]): boolean {
      wrapper.count += hits.length;
      tracker.addCount(key, hits.length);
      return inner.push(hits);
    },
    warn: (m: string) => inner.warn(m),
    error: (m: string) => inner.error(m),
  };
  return wrapper;
}
