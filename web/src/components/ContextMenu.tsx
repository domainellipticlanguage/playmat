import { useEffect } from 'react';
import { useUI } from '../uiStore';

/** One host at the app root; open via useUI.openCtxMenu. */
export function ContextMenuHost() {
  const menu = useUI((s) => s.ctxMenu);
  const close = () => useUI.getState().openCtxMenu(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ctx-menu')) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - 200);
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 30 - 20);
  return (
    <div className="ctx-menu fade-pop" style={{ left: x, top: y }}>
      {menu.items.map((item, i) =>
        item.sep ? (
          <div key={i} className="sep" />
        ) : (
          <div
            key={i}
            className="item"
            onClick={() => {
              close();
              item.action?.();
            }}
          >
            {item.label}
          </div>
        )
      )}
    </div>
  );
}
