import { SCENERY } from './scenery';

export default function SceneryPicker({ current, onChange, onSitDown, onLookAround }) {
  const btn = {
    background: 'transparent',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.15)',
    padding: '8px 14px',
    borderRadius: 999,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  };
  return (
    <div style={{
      position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', gap: 8, background: 'rgba(0,0,0,0.55)', padding: '10px 14px',
      borderRadius: 999, backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.08)',
    }}>
      {SCENERY.map((s) => (
        <button key={s.id} onClick={() => onChange(s)}
                style={{ ...btn, background: current.id === s.id ? s.tint : 'transparent' }}>
          {s.label}
        </button>
      ))}
      <div style={{ width: 1, background: 'rgba(255,255,255,0.15)', margin: '0 6px' }} />
      <button onClick={onSitDown} style={btn}>Sit at desk</button>
      <button onClick={onLookAround} style={btn}>Look around</button>
    </div>
  );
}
