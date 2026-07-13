export default function ComingSoonStub({ title, description }: { title: string; description: string }) {
  return (
    <div style={s.root}>
      <div style={s.icon}>🚧</div>
      <h1 style={s.heading}>{title}</h1>
      <p style={s.desc}>{description}</p>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: '80px 20px', textAlign: 'center' as const,
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  icon: { fontSize: '28px', marginBottom: '12px' },
  heading: { fontSize: '18px', fontWeight: 600, color: '#111827', margin: '0 0 6px' },
  desc: { fontSize: '13px', color: '#9CA3AF', maxWidth: '360px', margin: 0, lineHeight: '1.6' },
}