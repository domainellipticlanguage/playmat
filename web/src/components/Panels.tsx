import { useEffect, useRef, useState } from 'react';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import { faceAt, effectivePT, useCustomDisplay, zRotation } from '../cards';

/** Big readable card preview (README: hover → expanded card). Corner-pinned
 * with a small delay so it never chases or blocks the pointer. */
export function HoverPreview() {
  const hover = useUI((s) => s.hover);
  const dragging = useUI((s) => s.dragging);
  const [shown, setShown] = useState<typeof hover>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!hover || dragging) {
      setShown(null);
      return;
    }
    timer.current = setTimeout(() => setShown(hover), 280);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hover, dragging]);

  const customDisplay = useCustomDisplay(shown?.pool);
  if (!shown) return null;
  const face = shown.pool.sf ? faceAt(shown.pool, shown.rotIndex) : null;
  const img = shown.pool.custom ? customDisplay?.frontFaceImageUrl : face?.img;
  if (!img) return null;
  const sideways = Math.abs(zRotation(shown.pool, shown.rotIndex)) % 180 === 90;
  const pt = effectivePT(face, shown.counters ?? {});
  const hasCounterDelta = shown.counters && ((shown.counters['+1/+1'] ?? 0) || (shown.counters['-1/-1'] ?? 0));
  return (
    <div className={`hover-preview${sideways ? ' sideways' : ''}`}>
      <img src={img.replace('/normal/', '/large/')} alt={face?.name ?? 'card'} />
      {pt && hasCounterDelta ? <div className="oracle">Effective P/T: {pt.p}/{pt.t}</div> : null}
    </div>
  );
}

export function LogPanel({ onClose }: { onClose: () => void }) {
  const log = useGame((s) => s.log);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [log.length]);
  return (
    <div className="side-panel">
      <header>
        Event log
        <button className="small" onClick={onClose}>×</button>
      </header>
      <div className="log-list" ref={listRef}>
        {log.map((entry, i) => (
          <div key={i} className={entry.kind}>
            <time>
              {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
            {entry.text}
          </div>
        ))}
        {log.length === 0 && <div style={{ color: 'var(--ink-dim)' }}>Nothing yet.</div>}
      </div>
    </div>
  );
}

/** Animated die/coin result — driven by log events so every client sees it. */
export function DiceOverlay() {
  const log = useGame((s) => s.log);
  const lastRoll = useUI((s) => s.lastRoll);
  const seenTs = useRef(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const tail = log[log.length - 1];
    if (!tail || (tail.kind !== 'roll' && tail.kind !== 'coin')) return;
    if (tail.ts <= seenTs.current || Date.now() - tail.ts > 5000) return;
    seenTs.current = tail.ts;
    useUI.getState().showRoll({ die: tail.die, result: tail.result ?? '?', text: tail.text });
  }, [log]);

  useEffect(() => {
    if (!lastRoll) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(t);
  }, [lastRoll?.key]);

  if (!visible || !lastRoll) return null;
  const isCoin = lastRoll.die === undefined;
  return (
    <div className="dice-overlay" key={lastRoll.key}>
      <div className={`die${isCoin ? ' coin' : ''}`}>{isCoin ? (lastRoll.result === 'heads' ? 'HEADS' : 'TAILS') : lastRoll.result}</div>
      <div className="die-caption">{lastRoll.text}</div>
    </div>
  );
}
