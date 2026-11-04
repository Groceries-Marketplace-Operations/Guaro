export default function PromoManagerPanel() {
  return <section className="card" style={{ padding: 18 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
      <div>
        <h2 style={{ margin: 0 }}>Gestor de promociones</h2>
        <p className="text-muted" style={{ margin: '6px 0 0' }}>Prepara archivos CSV o SFTP, revisa el JSON, envía por tienda y consulta los Task IDs.</p>
      </div>
      <a className="btn btn-ghost" href="/guaro/promo-manager/index.html" target="_blank" rel="noopener noreferrer">Abrir en pantalla completa</a>
    </div>
    <iframe
      title="Gestor de promociones de DiDi"
      src="/guaro/promo-manager/index.html"
      loading="lazy"
      style={{ width: '100%', height: 'min(78vh, 1000px)', minHeight: 650, border: '1px solid var(--border)', borderRadius: 10, background: '#fff' }}
    />
  </section>;
}
