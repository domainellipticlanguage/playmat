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
  // Flyouts open downward by default; low on the screen (pile menus live at
  // the bottom edge) they'd clip, so anchor them to grow upward instead.
  const subStyle: React.CSSProperties | undefined =
    y > window.innerHeight * 0.55 ? { top: 'auto', bottom: -5 } : undefined;
  return (
    <div className="ctx-menu fade-pop" style={{ left: x, top: y }}>
      {menu.items.map((item, i) =>
        item.sep ? (
          <div key={i} className="sep" />
        ) : item.children ? (
          // Flyout submenu, opened by CSS :hover on the parent row.
          <div key={i} className="item has-sub">
            {item.label}
            <span className="sub-arrow">▸</span>
            <div className="ctx-menu sub" style={subStyle}>
              {item.children.map((c, j) => (
                <div
                  key={j}
                  className="item"
                  onClick={() => {
                    close();
                    c.action?.();
                  }}
                >
                  {c.label}
                </div>
              ))}
            </div>
          </div>
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
