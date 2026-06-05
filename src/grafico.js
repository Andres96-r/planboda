/* =========================================================================
   grafico.js · Cálculo puro de la proyección de flujo de caja acumulado.
   - NO depende de React ni de Firebase: recibe `data` y devuelve los puntos.
   - Se llama desde App.jsx de forma memoizada (useMemo), así solo se
     recalcula cuando cambian ingresos/ahorros/gastos, no en cada render.
   - Ingresos: ahorros + ingresos (pestaña Ahorros), con sus fechas.
   - Gastos: TODOS los egresos -> pagos ya hechos (fecha real) + cuotas y
     vencimientos futuros (fecha de vencimiento) + saldos pendientes
     (a su fecha límite, o a la fecha de la boda si no tienen).
   ========================================================================= */

export const BODA_ISO = "2026-11-14";

const dias = (a, b) =>
  Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);

export function calcProyeccionFlujo(data, bodaISO = BODA_ISO) {
  // 1) Entradas (ingresos): ahorros + ingresos
  const ingresos = [];
  (data.ahorros || []).forEach((a) => {
    const m = +a.monto || 0;
    if (m && a.fecha) ingresos.push({ fecha: a.fecha, monto: m });
  });
  (data.ingresos || []).forEach((i) => {
    const m = +i.monto || 0;
    if (m && i.fecha) ingresos.push({ fecha: i.fecha, monto: m });
  });

  // 2) Salidas (gastos): todos los egresos
  const gastos = [];
  (data.categorias || []).forEach((cat) => {
    (cat.items || []).forEach((it) => {
      if (it.modalidad === "cuotas") {
        (it.cuotas || []).forEach((q) => {
          const m = +q.monto || 0;
          const f = q.pagada ? q.fechaPago || q.fechaVencimiento : q.fechaVencimiento;
          if (m && f) gastos.push({ fecha: f, monto: m });
        });
      } else {
        (it.pagos || []).forEach((p) => {
          const m = +p.monto || 0;
          if (m && p.fecha) gastos.push({ fecha: p.fecha, monto: m });
        });
        const costo = +it.presupuesto || 0;
        const pagado = (it.pagos || []).reduce((s, p) => s + (+p.monto || 0), 0);
        const pendiente = Math.max(0, costo - pagado);
        if (pendiente > 0) gastos.push({ fecha: it.fechaLimite || bodaISO, monto: pendiente });
      }
    });
  });

  if (ingresos.length === 0 && gastos.length === 0) return { hayDatos: false };

  // 3) Rango del eje horizontal
  const todas = [...ingresos, ...gastos].map((e) => e.fecha);
  const minFecha = todas.reduce((a, b) => (a < b ? a : b));
  let maxFecha = todas.reduce((a, b) => (a > b ? a : b));
  if (maxFecha < bodaISO) maxFecha = bodaISO;

  // 4) Acumulados en cada fecha con evento
  const sumaHasta = (arr, f) => arr.reduce((s, e) => s + (e.fecha <= f ? e.monto : 0), 0);
  const fechasUnicas = Array.from(new Set([...todas, bodaISO])).sort();
  const puntos = fechasUnicas.map((f) => {
    const ingreso = sumaHasta(ingresos, f);
    const gasto = sumaHasta(gastos, f);
    return { fecha: f, ingreso, gasto, balance: ingreso - gasto };
  });

  // 5) Primer día donde el gasto acumulado supera al ingreso acumulado
  let cruce = null;
  for (const p of puntos) {
    if (p.gasto > p.ingreso) {
      cruce = { fecha: p.fecha, faltante: p.gasto - p.ingreso };
      break;
    }
  }

  return {
    hayDatos: true,
    puntos,
    minFecha,
    maxFecha,
    bodaISO,
    cruce,
    totalIngreso: sumaHasta(ingresos, maxFecha),
    totalGasto: sumaHasta(gastos, maxFecha),
    diasTotales: Math.max(1, dias(maxFecha, minFecha)),
  };
}
