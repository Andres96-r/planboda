/* =========================================================================
   grafico.js · Cálculo puro del flujo de caja (ingresos vs gastos).
   - NO depende de React ni de Firebase: recibe `data` y devuelve datos listos.
   - Se llama memoizado desde App.jsx, así solo recalcula al cambiar los datos.
   - `recolectarEventos`: convierte categorías/cuotas/pagos/ahorros/ingresos
     en dos listas planas de eventos con fecha y monto. Reutilizado por el
     dashboard (barras mensuales) y por la gráfica completa.
   - Ingresos: ahorros + ingresos (pestaña Ahorros).
   - Gastos: TODOS los egresos -> pagos hechos (fecha real) + cuotas
     (vencimiento o pago) + saldos pendientes (fecha límite, o boda si no tienen).
   ========================================================================= */

export const BODA_ISO = "2026-11-14";

const dias = (a, b) =>
  Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);

export function recolectarEventos(data, bodaISO = BODA_ISO) {
  const ingresos = [];
  const gastos = [];

  (data.ahorros || []).forEach((a) => {
    const m = +a.monto || 0;
    if (m && a.fecha) ingresos.push({ fecha: a.fecha, monto: m, nombre: a.descripcion || "Ahorro" });
  });
  (data.ingresos || []).forEach((i) => {
    const m = +i.monto || 0;
    if (m && i.fecha) ingresos.push({ fecha: i.fecha, monto: m, nombre: i.descripcion || "Ingreso" });
  });

  (data.categorias || []).forEach((cat) => {
    (cat.items || []).forEach((it) => {
      if (it.modalidad === "cuotas") {
        (it.cuotas || []).forEach((q) => {
          const m = +q.monto || 0;
          const pagada = !!q.pagada;
          const f = pagada ? q.fechaPago || q.fechaVencimiento : q.fechaVencimiento;
          if (m && f) gastos.push({ fecha: f, monto: m, nombre: `${it.nombre} · cuota`, cat: cat.nombre, pendiente: !pagada });
        });
      } else {
        (it.pagos || []).forEach((p) => {
          const m = +p.monto || 0;
          if (m && p.fecha) gastos.push({ fecha: p.fecha, monto: m, nombre: it.nombre, cat: cat.nombre, pendiente: false });
        });
        const costo = +it.presupuesto || 0;
        const pagado = (it.pagos || []).reduce((s, p) => s + (+p.monto || 0), 0);
        const pendiente = Math.max(0, costo - pagado);
        if (pendiente > 0) gastos.push({ fecha: it.fechaLimite || bodaISO, monto: pendiente, nombre: it.nombre, cat: cat.nombre, pendiente: true });
      }
    });
  });

  return { ingresos, gastos };
}

// Suma de todos los montos con fecha <= f (acumulado a esa fecha)
export const acumuladoHasta = (arr, f) => arr.reduce((s, e) => s + (e.fecha <= f ? e.monto : 0), 0);

export function calcProyeccionFlujo(data, opts = {}) {
  const bodaISO = opts.bodaISO || BODA_ISO;
  const { ingresos, gastos } = recolectarEventos(data, bodaISO);

  if (ingresos.length === 0 && gastos.length === 0) return { hayDatos: false };

  const todas = [...ingresos, ...gastos].map((e) => e.fecha);
  const minEvento = todas.reduce((a, b) => (a < b ? a : b));
  const minFecha = opts.desdeISO || minEvento; // arranca donde pidamos (ej. 1 de junio)
  const maxFecha = bodaISO;

  // Puntos dentro del rango [minFecha, maxFecha]; el acumulado incluye lo anterior
  const fechasRango = Array.from(
    new Set([minFecha, maxFecha, ...todas.filter((f) => f >= minFecha && f <= maxFecha)])
  ).sort();
  const puntos = fechasRango.map((f) => {
    const ingreso = acumuladoHasta(ingresos, f);
    const gasto = acumuladoHasta(gastos, f);
    return { fecha: f, ingreso, gasto, balance: ingreso - gasto };
  });

  let cruce = null;
  for (const p of puntos) {
    if (p.gasto > p.ingreso) { cruce = { fecha: p.fecha, faltante: p.gasto - p.ingreso }; break; }
  }

  return {
    hayDatos: true,
    puntos,
    minFecha,
    maxFecha,
    bodaISO,
    cruce,
    totalIngreso: acumuladoHasta(ingresos, maxFecha),
    totalGasto: acumuladoHasta(gastos, maxFecha),
    diasTotales: Math.max(1, dias(maxFecha, minFecha)),
  };
}
