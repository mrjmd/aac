export default function Loading() {
  return (
    <>
      <div className="ph">
        <div>
          <div className="eyebrow micro">Customer</div>
          <div className="sub">Pulling QuickBooks, texts, calls, email and the calendar…</div>
        </div>
      </div>
      <div className="tiles">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tile animate-pulse" style={{ height: 92 }} />
        ))}
      </div>
      <div className="card animate-pulse" style={{ height: 380 }} />
    </>
  );
}
