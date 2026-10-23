/* Confirmed readings are authoritative. A cached garage document is not an
   odometer reading and must never roll back an anchor accepted from LINE/OBD. */
export async function confirmedMileage(env, uid) {
  const rows = await env.DB.prepare(`
    SELECT c.id AS carId, a.km, a.observed_at AS observedAt, a.source, a.t AS updatedAt
    FROM cars c JOIN odo_anchor a ON a.id = (
      SELECT id FROM odo_anchor WHERE uid = ? AND car_id = c.id
      ORDER BY observed_at DESC, t DESC, id DESC LIMIT 1
    ) AND a.uid = c.uid
    WHERE c.uid = ? ORDER BY c.created_at DESC LIMIT 100
  `).bind(uid, uid).all();
  return rows.results || [];
}

export function applyConfirmedMileage(garage, readings) {
  if (!Array.isArray(garage)) return garage;
  const byId = new Map(readings.map(r => [String(r.carId), r]));
  return garage.map(car => {
    const reading = car && byId.get(String(car.id));
    if (!reading) return car;
    return { ...car, mileage: typeof car.mileage === 'number' ? reading.km : String(reading.km) };
  });
}
