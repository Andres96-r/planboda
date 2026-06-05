import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  createContext,
  useContext,
} from "react";
import { db, auth } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { calcProyeccionFlujo, recolectarEventos, acumuladoHasta, BODA_ISO } from "./grafico";

const DOC_REF = doc(db, "planboda", "main");
const VACIO = {
  categorias: [],
  ahorros: [],
  ingresos: [],
  notas: [],
  wipe: { estado: "idle", solicitadoPor: null, fechaSolicitud: null },
  registro: [],
};

/* =========================================================================
   PlanBoda · App de presupuesto y ahorro para el casamiento
   3 paneles (navegación inferior): Resumen · Gastos · Ahorros
   - Categorías y subcategorías editables, con confirmación al guardar/eliminar
   - Subcategoría: costo, reservado, estado de pago e historial de pagos
   - Ahorros + ingresos futuros -> proyección vs costo total

   >>> v2 COMPARTIDA (vos + Cande): cambiá SHARED a true.
   ========================================================================= */
const APP_VERSION = "v10 · splash";

/* ----------------------------- Helpers ---------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
// Modo privacidad: cuando está activo, fmt() oculta todos los montos.
// Lo setea el componente raíz en cada render según el estado `ocultar`.
let OCULTAR_MONTOS = false;
const fmt = (n) =>
  OCULTAR_MONTOS
    ? "$ •••"
    : new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency: "ARS",
        maximumFractionDigits: 0,
      }).format(isFinite(n) ? n : 0);
const fmtFecha = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const diasEntre = (a, b) =>
  Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);

const addFecha = (iso, i, freq) => {
  const [y, m, d] = iso.split("-").map(Number);
  if (freq === "mensual") return new Date(y, m - 1 + i, d).toISOString().slice(0, 10);
  if (freq === "anual") return new Date(y + i, m - 1, d).toISOString().slice(0, 10);
  if (freq === "quincenal") {
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + i * 15);
    return dt.toISOString().slice(0, 10);
  }
  return iso;
};

const CATEGORIAS_SUGERIDAS = [
  { nombre: "Novia", emoji: "👰" },
  { nombre: "Novio", emoji: "🤵" },
  { nombre: "Ceremonia", emoji: "💍" },
  { nombre: "Salón y Catering", emoji: "🥂" },
  { nombre: "Fotografía y Video", emoji: "📸" },
  { nombre: "Música", emoji: "🎵" },
  { nombre: "Invitaciones", emoji: "✉️" },
  { nombre: "Luna de miel", emoji: "🌴" },
];

/* --------------------------- Cálculos por ítem -------------------------- */
function calcItem(item) {
  let pagado = 0,
    proxima = null,
    cuotasPend = 0,
    cuotasTot = 0;
  if (item.modalidad === "cuotas") {
    cuotasTot = item.cuotas.length;
    for (const c of item.cuotas) {
      if (c.pagada) pagado += Number(c.monto) || 0;
      else {
        cuotasPend++;
        if (!proxima || c.fechaVencimiento < proxima.fechaVencimiento) proxima = c;
      }
    }
  } else {
    pagado = item.pagos.reduce((s, p) => s + (Number(p.monto) || 0), 0);
  }
  const costo = Number(item.presupuesto) || 0;
  const pendiente = Math.max(0, costo - pagado);
  const completo = costo > 0 && pagado >= costo;
  const pct = costo > 0 ? Math.min(100, (pagado / costo) * 100) : pagado > 0 ? 100 : 0;
  return { costo, pagado, pendiente, completo, pct, proxima, cuotasPend, cuotasTot };
}

/* --------------------------- Generar cuotas ----------------------------- */
function generarCuotas(costo, cantidad, fechaInicio, previas = []) {
  const n = parseInt(cantidad) || 0;
  const c = Number(costo) || 0;
  if (n <= 0 || !fechaInicio) return [];
  const base = Math.floor(c / n);
  const [y, mo, d] = fechaInicio.split("-").map(Number);
  const arr = [];
  for (let i = 0; i < n; i++) {
    const f = new Date(y, mo - 1 + i, d);
    const prev = previas[i];
    arr.push({
      id: prev?.id || uid(),
      monto: i === n - 1 ? c - base * (n - 1) : base,
      fechaVencimiento: f.toISOString().slice(0, 10),
      pagada: prev?.pagada || false,
      fechaPago: prev?.pagada ? prev.fechaPago || null : null,
    });
  }
  return arr;
}

/* ----------------- Dashboard: próximos pagos e ingresos ---------------- */
const MESES_ABR = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const mesKey = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;

function calcDashboard(data, hoyISO, nMeses = 6) {
  const now = new Date(hoyISO + "T00:00:00");
  const { ingresos, gastos } = recolectarEventos(data, BODA_ISO);

  // Barras mensuales: acumulado desde el inicio hasta el último día de cada mes
  const meses = [];
  for (let i = 0; i < nMeses; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const finMesISO = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    const ingreso = acumuladoHasta(ingresos, finMesISO);
    const pago = acumuladoHasta(gastos, finMesISO);
    meses.push({ key: mesKey(d.getFullYear(), d.getMonth()), label: MESES_ABR[d.getMonth()], anio: d.getFullYear(), ingreso, pago, balance: ingreso - pago });
  }

  return { meses, ingresos, gastos };
}

/* ===================== Confirmación (contexto) ========================== */
const ConfirmCtx = createContext(() => Promise.resolve(true));
const useConfirm = () => useContext(ConfirmCtx);

/* ============================ Componente raíz =========================== */
export default function PlanBoda() {
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [splash, setSplash] = useState(true);
  const [tab, setTab] = useState("resumen");
  const [fechaRef, setFechaRef] = useState(todayISO());
  const [confirmState, setConfirmState] = useState(null);
  const [yo, setYo] = useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem("planboda:yo") : null));

  const elegirIdentidad = (nombre) => {
    try { localStorage.setItem("planboda:yo", nombre); } catch {}
    setYo(nombre);
  };

  const confirm = useCallback(
    (mensaje, tono = "normal") =>
      new Promise((resolve) => {
        setConfirmState({
          mensaje,
          tono,
          resolve: (v) => {
            setConfirmState(null);
            resolve(v);
          },
        });
      }),
    []
  );

  useEffect(() => {
    let unsub = null;
    const arrancar = () => {
      unsub = onSnapshot(
        DOC_REF,
        (snap) => {
          if (snap.exists()) setData({ ...VACIO, ...snap.data() });
          else { setDoc(DOC_REF, VACIO).catch(() => {}); setData(VACIO); }
          setCargando(false);
        },
        () => setCargando(false)
      );
    };
    const off = onAuthStateChanged(auth, (user) => {
      if (user) arrancar();
      else signInAnonymously(auth).catch(() => arrancar());
    });
    return () => { if (unsub) unsub(); off(); };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSplash(false), 3000);
    return () => clearTimeout(t);
  }, []);

  const [errorGuardado, setErrorGuardado] = useState(null);
  const [ocultar, setOcultar] = useState(false);
  const [carta, setCarta] = useState(false);
  const [pedirCodigo, setPedirCodigo] = useState(false);
  OCULTAR_MONTOS = ocultar; // se aplica en el render actual (afecta a fmt en los hijos)

  const toggleOcultar = () => {
    if (ocultar) setPedirCodigo(true); // para volver a mostrar se pide código
    else setOcultar(true); // ocultar es libre
  };
  const update = useCallback((fn) => {
    setData((prev) => {
      const next = fn(structuredClone(prev));
      setDoc(DOC_REF, next).catch((err) => {
        console.error("Error al guardar en Firebase:", err);
        setErrorGuardado("No se pudo guardar. Revisá tu conexión.");
        setTimeout(() => setErrorGuardado(null), 4000);
      });
      return next;
    });
  }, []);

  const totales = useMemo(() => {
    if (!data) return null;
    let costo = 0, pagado = 0, pendiente = 0;
    data.categorias.forEach((cat) =>
      cat.items.forEach((it) => {
        const c = calcItem(it);
        costo += c.costo;
        pagado += c.pagado;
        pendiente += c.pendiente;
      })
    );
    const ahorrado = data.ahorros.filter((a) => a.fecha <= fechaRef).reduce((s, a) => s + (+a.monto || 0), 0);
    const ingresosFut = data.ingresos.filter((i) => i.fecha > fechaRef).reduce((s, i) => s + (+i.monto || 0), 0);
    const proyectado = ahorrado + ingresosFut;
    const faltaAhorrar = Math.max(0, costo - proyectado);
    return { costo, pagado, pendiente, ahorrado, ingresosFut, proyectado, faltaAhorrar, saldoCaja: ahorrado - pagado };
  }, [data, fechaRef]);

  if (splash) return <Splash />;

  if (cargando || !data)
    return (
      <div style={st.shell}>
        <Fuentes />
        <p style={{ fontFamily: F.serif, color: C.wine, fontSize: 22 }}>Preparando todo… 💍</p>
      </div>
    );

  if (!yo)
    return (
      <div style={st.shell}>
        <Fuentes />
        <div style={st.bg} />
        <IdentidadPicker onElegir={elegirIdentidad} />
      </div>
    );

  return (
    <ConfirmCtx.Provider value={confirm}>
      <div style={st.shell}>
        <Fuentes />
        <div style={st.bg} />
        <div style={st.app}>
          <TopBar fechaRef={fechaRef} setFechaRef={setFechaRef} tab={tab} yo={yo} ocultar={ocultar} onToggleOcultar={toggleOcultar} onCarta={() => setCarta(true)} />
          {errorGuardado && (
            <div style={{ background: C.terra, color: "#fff", fontFamily: F.body, fontSize: 13, padding: "8px 16px", textAlign: "center", zIndex: 15 }}>
              ⚠️ {errorGuardado}
            </div>
          )}
          <main style={st.main}>
            {tab === "resumen" && <PanelResumen t={totales} data={data} />}
            {tab === "gastos" && <PanelGastos data={data} update={update} fechaRef={fechaRef} />}
            {tab === "ahorros" && <PanelAhorros data={data} update={update} t={totales} />}
            {tab === "notas" && <PanelNotas data={data} update={update} />}
            {tab === "limpiar" && <PanelLimpiar data={data} update={update} yo={yo} onCambiarIdentidad={() => setYo(null)} />}
          </main>
          <BottomNav tab={tab} setTab={setTab} />
        </div>
        {confirmState && <ConfirmModal {...confirmState} />}
        {carta && <CartaModal onClose={() => setCarta(false)} />}
        {pedirCodigo && (
          <CodigoModal
            onClose={() => setPedirCodigo(false)}
            onOk={() => { setOcultar(false); setPedirCodigo(false); }}
          />
        )}
      </div>
    </ConfirmCtx.Provider>
  );
}

/* ======================= Identidad (este celular) ====================== */
function IdentidadPicker({ onElegir }) {
  return (
    <div style={st.app}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: 28, textAlign: "center" }}>
        <div style={{ fontSize: 13, letterSpacing: 4, color: C.gold, fontFamily: F.body }}>PLANBODA</div>
        <h1 style={{ ...st.h1, fontSize: 40, margin: "6px 0 4px" }}>Ale &amp; Cande</h1>
        <p style={{ fontFamily: F.body, color: C.wineSoft, marginBottom: 24 }}>¿Quién está usando este celular?</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 280 }}>
          <button style={{ ...st.btn, padding: "14px 0", fontSize: 17 }} onClick={() => onElegir("Ale")}>🤵 Soy el novio (Ale)</button>
          <button style={{ ...st.btn, padding: "14px 0", fontSize: 17, background: C.rose }} onClick={() => onElegir("Cande")}>👰 Soy la novia (Cande)</button>
        </div>
        <p style={{ ...st.hint, marginTop: 20 }}>Se usa solo para la doble confirmación al limpiar la app. Lo podés cambiar después.</p>
      </div>
    </div>
  );
}

/* ========================== PANEL · LIMPIAR ============================ */
function PanelLimpiar({ data, update, yo, onCambiarIdentidad }) {
  const confirm = useConfirm();
  const wipe = data.wipe || { estado: "idle", solicitadoPor: null, fechaSolicitud: null };
  const registro = data.registro || [];
  const elOtro = yo === "Ale" ? "Cande" : "Ale";
  const ahora = () => new Date().toISOString();
  const fechaHora = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const solicitar = async () => {
    if (!(await confirm("¿Solicitar el BORRADO TOTAL de la app? Va a quedar pendiente hasta que lo confirme el otro celular.", "peligro"))) return;
    update((d) => {
      d.wipe = { estado: "pendiente", solicitadoPor: yo, fechaSolicitud: ahora() };
      d.registro = [{ id: uid(), tipo: "solicitud", quien: yo, fecha: ahora() }, ...(d.registro || [])];
      return d;
    });
  };
  const cancelar = async () => {
    if (!(await confirm("¿Cancelar la solicitud de borrado?"))) return;
    update((d) => {
      d.wipe = { estado: "idle", solicitadoPor: null, fechaSolicitud: null };
      d.registro = [{ id: uid(), tipo: "cancelada", quien: yo, fecha: ahora() }, ...(d.registro || [])];
      return d;
    });
  };
  const confirmarBorrado = async () => {
    if (!(await confirm(`Vas a BORRAR TODO lo cargado (lo pidió ${wipe.solicitadoPor}). Esta acción no se puede deshacer. ¿Confirmás?`, "peligro"))) return;
    update((d) => {
      const reg = [{ id: uid(), tipo: "ejecutada", quien: yo, fecha: ahora() }, ...(d.registro || [])];
      return { categorias: [], ahorros: [], ingresos: [], wipe: { estado: "idle", solicitadoPor: null, fechaSolicitud: null }, registro: reg };
    });
  };

  const etiqueta = { solicitud: "Solicitud de borrado", cancelada: "Solicitud cancelada", ejecutada: "Borrado ejecutado ✅" };

  return (
    <div>
      <section style={st.panel}>
        <h2 style={st.h2}>Limpiar app</h2>
        <p style={st.hint}>Borrar todo necesita doble confirmación: uno lo solicita y el otro celular lo confirma. Queda registro de cada acción.</p>

        <div style={{ marginTop: 14 }}>
          {wipe.estado === "idle" && (
            <button style={{ ...st.btnPeligro, width: "100%", padding: "13px 0" }} onClick={solicitar}>Solicitar limpieza total</button>
          )}

          {wipe.estado === "pendiente" && wipe.solicitadoPor === yo && (
            <div style={st.avisoBox}>
              <div style={{ fontWeight: 600, color: C.terra }}>Solicitud enviada ⏳</div>
              <p style={st.hint}>Pediste borrar todo el {fechaHora(wipe.fechaSolicitud)}. Falta que <strong>{elOtro}</strong> lo confirme desde su celular.</p>
              <button style={{ ...st.btnGhost, marginTop: 10 }} onClick={cancelar}>Cancelar solicitud</button>
            </div>
          )}

          {wipe.estado === "pendiente" && wipe.solicitadoPor !== yo && (
            <div style={st.avisoBox}>
              <div style={{ fontWeight: 600, color: C.terra }}>⚠️ {wipe.solicitadoPor} pidió borrar todo</div>
              <p style={st.hint}>Solicitado el {fechaHora(wipe.fechaSolicitud)}. Si están de acuerdo, confirmá el borrado total desde este celular.</p>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button style={{ ...st.btnPeligro, flex: 1 }} onClick={confirmarBorrado}>Confirmar y borrar todo</button>
                <button style={{ ...st.btnGhost, flex: 1 }} onClick={cancelar}>Rechazar</button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section style={{ ...st.panel, marginTop: 14 }}>
        <h2 style={st.h2}>Registro</h2>
        {registro.length === 0 ? (
          <p style={st.hint}>Todavía no hay acciones de limpieza.</p>
        ) : (
          registro.map((r) => (
            <div key={r.id} style={st.linea}>
              <span style={{ flex: 1, fontSize: 13 }}>{etiqueta[r.tipo] || r.tipo}</span>
              <span style={{ fontSize: 12, color: C.wineSoft }}>{r.quien} · {fechaHora(r.fecha)}</span>
            </div>
          ))
        )}
      </section>

      <div style={{ textAlign: "center", marginTop: 16 }}>
        <span style={{ fontSize: 12, color: C.wineSoft, fontFamily: F.body }}><strong style={{ color: C.wine }}>{yo === "Ale" ? "Soy el novio 🤵" : "Soy la novia 👰"}</strong></span>
        <button style={{ ...st.btnGhostSm, marginLeft: 8 }} onClick={onCambiarIdentidad}>Cambiar</button>
      </div>
    </div>
  );
}

/* ============================== TopBar ================================= */
function OjoIcon({ tachado }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.wine} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {tachado && <line x1="3" y1="3" x2="21" y2="21" stroke={C.terra} />}
    </svg>
  );
}

function TopBar({ fechaRef, setFechaRef, tab, yo, ocultar, onToggleOcultar, onCarta }) {
  const tituloResumen = yo === "Ale" ? "Ale (Novio 🤵)" : "Cande (Novia 👰)";
  const titulos = { resumen: tituloResumen, gastos: "Costos", ahorros: "Ahorros e ingresos", notas: "Notas", limpiar: "Limpiar app" };
  const mostrarCarta = yo === "Cande" && tab === "resumen";
  return (
    <header style={st.topbar}>
      {mostrarCarta && (
        <button style={st.cartaBtn} onClick={onCarta} title="Mensaje secreto" aria-label="Mensaje secreto">💌</button>
      )}

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 11, letterSpacing: 3, color: C.gold, fontFamily: F.body }}>ALE &amp; CANDE</div>
        <h1 style={st.h1}>{titulos[tab]}</h1>
      </div>
      <div style={st.fechaBox}>
        <span style={{ fontSize: 12, color: C.wineSoft }}>Resumen al</span>
        <input type="date" value={fechaRef} onChange={(e) => setFechaRef(e.target.value)} style={st.dateInput} />
        <button style={st.ojoBtn} onClick={onToggleOcultar} title={ocultar ? "Mostrar montos" : "Ocultar montos"} aria-label="Ocultar o mostrar montos">
          <OjoIcon tachado={ocultar} />
        </button>
      </div>
    </header>
  );
}

const CODIGO_MONTOS = "141126";
function CodigoModal({ onOk, onClose }) {
  const [codigo, setCodigo] = useState("");
  const [error, setError] = useState(false);
  const intentar = () => { if (codigo === CODIGO_MONTOS) onOk(); else setError(true); };
  return (
    <div style={{ ...st.overlay, zIndex: 85, alignItems: "center" }} onClick={onClose}>
      <div style={st.confirm} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 26, marginBottom: 6 }}>🔒</div>
        <p style={{ fontFamily: F.body, color: C.wine, fontSize: 15, margin: "0 0 14px" }}>Ingresá el código para mostrar los montos</p>
        <div style={{ position: "relative" }}>
          <input
            type="text"
            inputMode="numeric"
            value={codigo}
            autoFocus
            onChange={(e) => { setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") intentar(); }}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "text", border: "none" }}
            aria-label="Código"
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            {Array.from({ length: 6 }).map((_, i) => {
              const lleno = i < codigo.length;
              const activo = i === codigo.length;
              return (
                <div key={i} style={{ width: 34, height: 44, borderRadius: 10, background: "#fff", border: `2px solid ${error ? C.terra : activo ? C.rose : lleno ? C.wineSoft : C.line}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, lineHeight: 1, color: C.wine }}>
                  {lleno ? "•" : ""}
                </div>
              );
            })}
          </div>
        </div>
        {error && <div style={{ color: C.terra, fontSize: 13, marginTop: 8, fontFamily: F.body }}>Código incorrecto</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button style={{ ...st.btnGhost, flex: 1 }} onClick={onClose}>Cancelar</button>
          <button style={{ ...st.btn, flex: 1 }} onClick={intentar}>Mostrar</button>
        </div>
      </div>
    </div>
  );
}

function CartaModal({ onClose }) {
  return (
    <div style={{ ...st.overlay, zIndex: 90, alignItems: "center" }} onClick={onClose}>
      <div style={st.cartaModal} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 34, textAlign: "center", marginBottom: 4 }}>💍❤️</div>
        <h3 style={{ fontFamily: F.serif, fontSize: 22, color: C.wine, textAlign: "center", margin: "0 0 14px", fontWeight: 700 }}>
          Mensaje oculto desbloqueado
        </h3>
        <p style={st.cartaTexto}>Felicitaciones, encontraste este pequeño rincón secreto de la aplicación. ❤️</p>
        <p style={st.cartaTexto}>
          Tu premio es un recordatorio oficial de que sos hermosa, te amo un montón y tengo
          muchísimas ganas de casarme contigo 🥰
        </p>
        <p style={{ ...st.cartaTexto, fontStyle: "italic", color: C.wineSoft }}>PD: el desarrollador de esta app también te ama.</p>
        <p style={{ ...st.cartaTexto, fontStyle: "italic", color: C.wineSoft }}>PD 2: sí, es el mismo que va a casarse con vos 😘</p>
        <button style={{ ...st.btn, width: "100%", marginTop: 14, background: C.rose }} onClick={onClose}>Cerrar con un beso 💋</button>
      </div>
    </div>
  );
}

/* ========================== Bottom navigation =========================== */
function BottomNav({ tab, setTab }) {
  const tabs = [
    { id: "resumen", label: "Resumen", icon: "📊" },
    { id: "gastos", label: "Costos", icon: "📋" },
    { id: "ahorros", label: "Ahorros", icon: "🐷" },
    { id: "notas", label: "Notas", icon: "📝" },
    { id: "limpiar", label: "Limpiar", icon: "🧹" },
  ];
  return (
    <nav style={st.nav}>
      {tabs.map((t) => {
        const on = tab === t.id;
        return (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...st.navBtn, ...(on ? st.navBtnOn : {}) }}>
            <span style={{ fontSize: 22, filter: on ? "none" : "grayscale(.4)", opacity: on ? 1 : 0.7 }}>{t.icon}</span>
            <span style={{ fontSize: 11, fontWeight: on ? 600 : 400 }}>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/* ========================== PANEL · RESUMEN ============================= */
function PanelResumen({ t, data }) {
  const cards = [
    { label: "Costo total", val: t.costo, color: C.wine, icon: "💗" },
    { label: "Pagado", val: t.pagado, color: C.sage, icon: "✓" },
    { label: "Pendiente de pago", val: t.pendiente, color: C.terra, icon: "⏳" },
    { label: "Ahorrado a la fecha", val: t.ahorrado, color: C.gold, icon: "🐷" },
  ];
  const cubre = t.proyectado >= t.costo && t.costo > 0;
  const pctProy = t.costo > 0 ? Math.min(100, (t.proyectado / t.costo) * 100) : 0;

  const porCat = data.categorias
    .map((cat) => {
      const c = cat.items.reduce(
        (a, it) => {
          const x = calcItem(it);
          a.costo += x.costo;
          a.pagado += x.pagado;
          return a;
        },
        { costo: 0, pagado: 0 }
      );
      return { ...cat, ...c };
    })
    .filter((c) => c.costo > 0)
    .sort((a, b) => b.costo - a.costo);

  return (
    <div>
      <a
        href="https://boda-aleycande.lat/admin"
        target="_blank"
        rel="noopener noreferrer"
        style={st.atajoBtnWrap}
      >
        <span style={st.atajoEmojis}>👰🤵💍</span>
        <span style={st.atajoTexto}>Ir al panel de invitados y tarjetas</span>
        <span style={st.atajoArrow}>›</span>
      </a>

      <div style={st.grid2}>
        {cards.map((c) => (
          <div key={c.label} style={st.card}>
            <div style={{ fontSize: 20 }}>{c.icon}</div>
            <div style={{ ...st.cardVal, color: c.color }}>{fmt(c.val)}</div>
            <div style={st.cardLabel}>{c.label}</div>
          </div>
        ))}
      </div>

      <section style={st.panel}>
        <h2 style={st.h2}>Proyección de ahorro</h2>
        {t.costo === 0 ? (
          <p style={st.hint}>Cargá costos en el panel “Costos” para ver la proyección.</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ position: "relative", width: 138, height: 138, flexShrink: 0 }}>
                <Donut
                  segments={[
                    { value: Math.min(t.ahorrado, t.costo), color: C.gold },
                    { value: Math.min(t.ingresosFut, Math.max(0, t.costo - t.ahorrado)), color: C.sage },
                    { value: Math.max(0, t.costo - t.ahorrado - t.ingresosFut), color: C.terra },
                  ]}
                />
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ fontFamily: F.serif, fontSize: 32, fontWeight: 700, color: cubre ? C.sage : C.wine, lineHeight: 1 }}>{Math.round(pctProy)}%</div>
                  <div style={{ fontSize: 11, color: C.wineSoft, fontFamily: F.body }}>cubierto</div>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <LegendRow color={C.gold} label="Ahorrado" val={t.ahorrado} />
                <LegendRow color={C.sage} label="Ingresos futuros" val={t.ingresosFut} />
                <LegendRow color={C.terra} label="Falta ahorrar" val={t.faltaAhorrar} />
                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 6 }}>
                  <LegendRow color={C.wine} label="Costo total" val={t.costo} bold />
                </div>
              </div>
            </div>
            <div style={{ textAlign: "center", marginTop: 12, fontFamily: F.serif, fontSize: 19, color: cubre ? C.sage : C.terra, fontWeight: 600 }}>
              {cubre ? `¡Llegás a cubrir todo! Sobran ${fmt(t.proyectado - t.costo)} 🎉` : `Te faltan ${fmt(t.faltaAhorrar)} por ahorrar`}
            </div>
            <p style={{ ...st.hint, textAlign: "center" }}>
              Disponible hoy (ahorrado − pagado): <strong style={{ color: t.saldoCaja >= 0 ? C.sage : C.terra }}>{fmt(t.saldoCaja)}</strong>
            </p>
          </>
        )}
      </section>

      <section style={{ ...st.panel, marginTop: 14 }}>
        <h2 style={st.h2}>Gasto por categoría</h2>
        {porCat.length === 0 ? (
          <p style={st.hint}>Cargá gastos en el panel “Gastos” para ver el desglose.</p>
        ) : (
          porCat.map((c) => {
            const pct = c.costo > 0 ? (c.pagado / c.costo) * 100 : 0;
            return (
              <div key={c.id} style={{ marginBottom: 12 }}>
                <div style={st.catBarTop}>
                  <span>{c.emoji} {c.nombre}</span>
                  <span style={{ color: C.wineSoft }}>{fmt(c.pagado)} / {fmt(c.costo)}</span>
                </div>
                <div style={st.barTrackSm}>
                  <div style={{ ...st.barFillSm, width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>
            );
          })
        )}
      </section>

      <DashboardProximos data={data} />

      <div style={{ textAlign: "center", marginTop: 18 }}>
        <div style={{ fontSize: 11, color: C.wineSoft, fontFamily: F.body }}>PlanBoda {APP_VERSION} · datos en la nube (compartido)</div>
      </div>
    </div>
  );
}

/* ---------------- Dashboard híbrido: próximos pagos/ingresos ----------- */
function DashboardProximos({ data }) {
  const hoy = todayISO();
  const [mesSel, setMesSel] = useState(null); // null = todos (total)
  const [verGrafico, setVerGrafico] = useState(false);
  const [abrePagos, setAbrePagos] = useState(false);
  const [abreIngresos, setAbreIngresos] = useState(false);
  const [abrePasados, setAbrePasados] = useState(false);
  const [fechaBalance, setFechaBalance] = useState(hoy);
  const { meses, ingresos, gastos } = useMemo(() => calcDashboard(data, hoy, 6), [data, hoy]);

  const hayDatos = ingresos.length > 0 || gastos.length > 0;
  const maxAbs = Math.max(1, ...meses.map((m) => Math.max(m.ingreso, m.pago)));

  // Balance a la fecha elegida
  const balanceFecha = useMemo(
    () => acumuladoHasta(ingresos, fechaBalance) - acumuladoHasta(gastos, fechaBalance),
    [ingresos, gastos, fechaBalance]
  );

  // Mapas a "evento" para mostrar
  const toPago = (g) => ({ tipo: "pago", nombre: g.nombre, monto: g.monto, cat: g.cat, fecha: g.fecha, vencida: g.fecha < hoy });
  const toIngreso = (i) => ({ tipo: "ingreso", nombre: i.nombre, monto: i.monto, fecha: i.fecha });
  const porFecha = (a, b) => (a.fecha || "").localeCompare(b.fecha || "");

  // Listas según vista
  let pagos, ingresosEv, pasados = null;
  if (mesSel) {
    const enMes = (f) => (f || "").slice(0, 7) === mesSel;
    pagos = gastos.filter((g) => g.pendiente && enMes(g.fecha)).map(toPago).sort(porFecha);
    ingresosEv = ingresos.filter((i) => enMes(i.fecha)).map(toIngreso).sort(porFecha);
  } else {
    pagos = gastos.filter((g) => g.pendiente).map(toPago).sort(porFecha);
    ingresosEv = ingresos.filter((i) => i.fecha >= hoy).map(toIngreso).sort(porFecha);
    pasados = [
      ...gastos.filter((g) => !g.pendiente && g.fecha < hoy).map(toPago),
      ...ingresos.filter((i) => i.fecha < hoy).map(toIngreso),
    ].sort(porFecha);
  }
  const sufijo = mesSel ? MESES_ABR[Number(mesSel.slice(5)) - 1] : "total";
  const totalPagos = pagos.reduce((s, e) => s + e.monto, 0);
  const totalIngresos = ingresosEv.reduce((s, e) => s + e.monto, 0);
  const netoPasados = pasados
    ? pasados.reduce((s, e) => s + (e.tipo === "ingreso" ? e.monto : -e.monto), 0)
    : 0;

  const filaEvento = (e, i) => (
    <div key={i} style={st.dashEvento}>
      <span style={{ ...st.dashEventoDot, background: e.tipo === "ingreso" ? C.sage : e.vencida ? C.terra : C.rose }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={st.dashEventoNombre}>
          {e.nombre}
          {e.vencida && <span style={st.dashVencida}>vencido</span>}
        </div>
        <div style={st.dashEventoFecha}>{e.tipo === "ingreso" ? "Ingreso" : e.cat || "Pago"} · {fmtFecha(e.fecha)}</div>
      </div>
      <span style={{ fontFamily: F.serif, fontWeight: 600, fontSize: 15, color: e.tipo === "ingreso" ? C.sage : C.terra }}>
        {e.tipo === "ingreso" ? "+" : "−"}{fmt(e.monto)}
      </span>
    </div>
  );

  return (
    <section style={{ ...st.panel, marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <h2 style={{ ...st.h2, margin: 0, fontSize: 20 }}>BALANCE DE CAJA BODA 💍🤵👰</h2>
        {hayDatos && <button style={st.btnGhostSm} onClick={() => setVerGrafico(true)}>📈 Gráfica</button>}
      </div>

      {verGrafico && <GraficaFlujo data={data} onClose={() => setVerGrafico(false)} />}

      {!hayDatos ? (
        <p style={st.hint}>Cuando cargues pagos con fecha o ingresos futuros, vas a ver acá tu agenda y el balance proyectado mes a mes.</p>
      ) : (
        <>
          {/* Balance a la fecha elegida */}
          <div style={st.dashArrastre}>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontFamily: F.body, fontSize: 12, color: C.wineSoft }}>Balance hasta la fecha</span>
              <input type="date" value={fechaBalance} onChange={(e) => setFechaBalance(e.target.value || hoy)} style={st.dashFechaInput} />
            </div>
            <span style={{ fontFamily: F.serif, fontSize: 22, fontWeight: 700, color: balanceFecha >= 0 ? C.sage : C.terra }}>{fmt(balanceFecha)}</span>
          </div>

          {/* Tira de meses (acumulado hasta fin de cada mes) */}
          <div style={st.dashMesesWrap}>
            {meses.map((m) => {
              const on = mesSel === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => setMesSel(on ? null : m.key)}
                  style={{ ...st.dashMes, ...(on ? st.dashMesOn : {}) }}
                >
                  <div style={st.dashMesLabel}>{m.label}</div>
                  <div style={st.dashMesBarras}>
                    <div style={{ ...st.dashBar, height: `${(m.ingreso / maxAbs) * 100}%`, background: C.sage }} title={`Ingresos acum. ${fmt(m.ingreso)}`} />
                    <div style={{ ...st.dashBar, height: `${(m.pago / maxAbs) * 100}%`, background: C.terra }} title={`Gastos acum. ${fmt(m.pago)}`} />
                  </div>
                  <div style={{ ...st.dashMesNeto, color: m.balance >= 0 ? C.sage : C.terra }}>{fmt(m.balance)}</div>
                </button>
              );
            })}
          </div>
          <div style={st.dashLeyenda}>
            <span><span style={{ ...st.dashDot, background: C.sage }} /> Ingresos acum.</span>
            <span><span style={{ ...st.dashDot, background: C.terra }} /> Gastos acum.</span>
            <span style={{ color: C.wineSoft }}>· abajo: balance</span>
          </div>

          {/* Agenda desplegable */}
          <div style={{ marginTop: 10 }}>
            {mesSel && (
              <div style={{ marginBottom: 8 }}>
                <button style={st.dashVerTodo} onClick={() => setMesSel(null)}>← Ver todo</button>
              </div>
            )}

            <button style={st.dashDesplegable} onClick={() => setAbrePagos((v) => !v)}>
              <span style={{ flex: 1, textAlign: "left" }}>💸 Pagos próximos <span style={st.dashConteo}>({sufijo})</span></span>
              <span style={{ color: C.terra, fontWeight: 600, marginRight: 8 }}>{fmt(totalPagos)}</span>
              <span style={{ color: C.rose, fontSize: 16, transform: abrePagos ? "rotate(90deg)" : "none", transition: "transform .2s" }}>›</span>
            </button>
            {abrePagos && (pagos.length === 0
              ? <p style={{ ...st.hint, margin: "4px 0 8px" }}>No hay pagos en este período.</p>
              : <div style={{ marginBottom: 8 }}>{pagos.map(filaEvento)}</div>)}

            <button style={st.dashDesplegable} onClick={() => setAbreIngresos((v) => !v)}>
              <span style={{ flex: 1, textAlign: "left" }}>💰 Ingresos próximos <span style={st.dashConteo}>({sufijo})</span></span>
              <span style={{ color: C.sage, fontWeight: 600, marginRight: 8 }}>{fmt(totalIngresos)}</span>
              <span style={{ color: C.rose, fontSize: 16, transform: abreIngresos ? "rotate(90deg)" : "none", transition: "transform .2s" }}>›</span>
            </button>
            {abreIngresos && (ingresosEv.length === 0
              ? <p style={{ ...st.hint, margin: "4px 0 8px" }}>No hay ingresos en este período.</p>
              : <div>{ingresosEv.map(filaEvento)}</div>)}

            {/* Movimientos pasados (solo en vista total) */}
            {pasados && (
              <>
                <button style={st.dashDesplegable} onClick={() => setAbrePasados((v) => !v)}>
                  <span style={{ flex: 1, textAlign: "left" }}>🕓 Movimientos pasados <span style={st.dashConteo}>({pasados.length})</span></span>
                  <span style={{ color: netoPasados >= 0 ? C.sage : C.terra, fontWeight: 600, marginRight: 8 }}>{netoPasados >= 0 ? "+" : "−"}{fmt(Math.abs(netoPasados))}</span>
                  <span style={{ color: C.rose, fontSize: 16, transform: abrePasados ? "rotate(90deg)" : "none", transition: "transform .2s" }}>›</span>
                </button>
                {abrePasados && (pasados.length === 0
                  ? <p style={{ ...st.hint, margin: "4px 0 8px" }}>Todavía no hay movimientos registrados con fecha pasada.</p>
                  : <div>{pasados.map(filaEvento)}</div>)}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/* -------- Gráfica completa: ingresos vs gastos acumulados ------------- */
function GraficaFlujo({ data, onClose }) {
  // arranca el 1° del mes actual (junio), igual que las barras del dashboard
  const desdeISO = useMemo(() => { const n = new Date(todayISO() + "T00:00:00"); return new Date(n.getFullYear(), n.getMonth(), 1).toISOString().slice(0, 10); }, []);
  const r = useMemo(() => calcProyeccionFlujo(data, { desdeISO, bodaISO: BODA_ISO }), [data, desdeISO]);
  const svgRef = React.useRef(null);

  const W = 340, H = 210, padL = 8, padR = 8, padT = 30, padB = 44;
  const innerW = W - padL - padR, innerH = H - padT - padB;

  const descargar = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const svg64 = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = W * scale; canvas.height = H * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "balance-caja-boda.png";
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      }, "image/png");
    };
    img.src = svg64;
  };

  let contenido;
  if (!r.hayDatos) {
    contenido = <p style={st.hint}>Cargá ingresos en “Ahorros” y costos con fechas para ver la proyección.</p>;
  } else {
    const maxY = Math.max(r.totalIngreso, r.totalGasto, 1);
    const X = (f) => padL + (diasEntre(f, r.minFecha) / r.diasTotales) * innerW;
    const Y = (v) => padT + innerH - (v / maxY) * innerH;
    const linea = (key) => r.puntos.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.fecha).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(" ");
    const xBoda = X(r.bodaISO);

    const marcas = [];
    {
      const d0 = new Date(r.minFecha + "T00:00:00");
      let m = new Date(d0.getFullYear(), d0.getMonth(), 1);
      const fin = new Date(r.maxFecha + "T00:00:00");
      while (m <= fin) {
        const iso = m.toISOString().slice(0, 10);
        if (iso >= r.minFecha) marcas.push({ x: X(iso), label: MESES_ABR[m.getMonth()] });
        m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      }
    }

    contenido = (
      <>
        <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto", background: "#fff", borderRadius: 8 }}>
          {/* título + leyenda embebidos (para la imagen exportada) */}
          <text x={W / 2} y={16} fontSize="12" fontWeight="700" fill={C.wine} textAnchor="middle" fontFamily="sans-serif">Balance de caja · boda</text>
          <circle cx={padL + 6} cy={25} r="4" fill={C.sage} />
          <text x={padL + 14} y={28} fontSize="8" fill={C.wine} fontFamily="sans-serif">Ingresos acum.</text>
          <circle cx={padL + 78} cy={25} r="4" fill={C.terra} />
          <text x={padL + 86} y={28} fontSize="8" fill={C.wine} fontFamily="sans-serif">Gastos acum.</text>

          {/* grilla horizontal */}
          {[0.25, 0.5, 0.75, 1].map((q) => (
            <line key={q} x1={padL} y1={Y(maxY * q)} x2={W - padR} y2={Y(maxY * q)} stroke={C.line} strokeWidth="1" />
          ))}
          {/* marcas de mes */}
          {marcas.map((mk, i) => (
            <g key={i}>
              <line x1={mk.x} y1={padT} x2={mk.x} y2={padT + innerH} stroke={C.line} strokeWidth="0.5" opacity="0.5" />
              <text x={mk.x} y={H - 24} fontSize="8" fill={C.wineSoft} textAnchor="middle" fontFamily="sans-serif">{mk.label}</text>
            </g>
          ))}
          {/* línea fecha de boda */}
          <line x1={xBoda} y1={padT} x2={xBoda} y2={padT + innerH} stroke={C.gold} strokeWidth="1.5" strokeDasharray="3 3" />
          <text x={Math.min(xBoda, W - 16)} y={padT - 2} fontSize="8" fill={C.gold} textAnchor="middle" fontFamily="sans-serif">boda</text>
          {/* curvas */}
          <path d={linea("gasto")} fill="none" stroke={C.terra} strokeWidth="2" strokeLinejoin="round" />
          <path d={linea("ingreso")} fill="none" stroke={C.sage} strokeWidth="2" strokeLinejoin="round" />
          {/* punto de cruce */}
          {r.cruce && (
            <circle cx={X(r.cruce.fecha)} cy={Y(r.puntos.find((p) => p.fecha === r.cruce.fecha)?.gasto || 0)} r="4" fill={C.terra} stroke="#fff" strokeWidth="1.5" />
          )}
          {/* eje x */}
          <text x={padL} y={H - 8} fontSize="8" fill={C.wineSoft} fontFamily="sans-serif">{fmtFecha(r.minFecha)}</text>
          <text x={W - padR} y={H - 8} fontSize="8" fill={C.wineSoft} textAnchor="end" fontFamily="sans-serif">{fmtFecha(r.maxFecha)}</text>
        </svg>

        {/* alerta */}
        {r.cruce ? (
          <div style={{ ...st.avisoBox, marginTop: 14, borderColor: `${C.terra}` }}>
            <div style={{ fontWeight: 700, color: C.terra, fontFamily: F.body }}>⚠️ Atención: te quedás corto</div>
            <p style={{ ...st.hint, marginTop: 4 }}>
              El <strong style={{ color: C.terra }}>{fmtFecha(r.cruce.fecha)}</strong> los gastos acumulados superan a los ingresos.
              Ese día te faltarían <strong style={{ color: C.terra }}>{fmt(r.cruce.faltante)}</strong> para cubrir todo lo que vence hasta entonces.
            </p>
          </div>
        ) : (
          <div style={{ ...st.avisoBox, marginTop: 14, borderColor: `${C.sage}88`, background: "#f3f8f1" }}>
            <div style={{ fontWeight: 700, color: C.sage, fontFamily: F.body }}>✓ Vas bien encaminados</div>
            <p style={{ ...st.hint, marginTop: 4 }}>
              Los ingresos acumulados cubren los gastos en todo el período, hasta la boda. Sobran <strong style={{ color: C.sage }}>{fmt(r.totalIngreso - r.totalGasto)}</strong> al {fmtFecha(r.maxFecha)} 🎉
            </p>
          </div>
        )}
      </>
    );
  }

  return (
    <div style={{ ...st.overlay, zIndex: 60, alignItems: "center" }} onClick={onClose}>
      <div style={{ ...st.confirm, maxWidth: 440, width: "calc(100% - 28px)", textAlign: "left", maxHeight: "88vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3 style={{ ...st.h3 }}>Proyección hasta la boda</h3>
          <button style={st.iconBtn} onClick={onClose}>✕</button>
        </div>
        {contenido}
        <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", gap: 8 }}>
          {r.hayDatos ? <button style={st.btnSm} onClick={descargar}>⬇️ Descargar imagen</button> : <span />}
          <button style={st.btnGhost} onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

function Donut({ segments, size = 138, stroke = 20 }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.roseLite} strokeWidth={stroke} opacity={0.5} />
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {segments.map((seg, i) => {
          const len = (seg.value / total) * circ;
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              style={{ transition: "stroke-dasharray .5s ease" }}
            />
          );
          offset += len;
          return el;
        })}
      </g>
    </svg>
  );
}
function LegendRow({ color, label, val, bold }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
      <span style={{ width: 11, height: 11, borderRadius: 3, background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, fontFamily: F.body, fontSize: 13, color: C.wineSoft }}>{label}</span>
      <span style={{ fontFamily: F.serif, fontSize: bold ? 17 : 15, fontWeight: bold ? 700 : 600, color: bold ? C.wine : color }}>{fmt(val)}</span>
    </div>
  );
}

/* =========================== PANEL · GASTOS ============================= */
const ORDEN_GASTOS_KEY = "planboda:ordenGastos";
const ORDENES_GASTOS = [
  { id: "default", label: "Por defecto" },
  { id: "nombre", label: "Nombre A-Z" },
  { id: "costoDesc", label: "Mayor costo" },
  { id: "pendienteDesc", label: "Más pendiente" },
  { id: "pagadoDesc", label: "Más pagado" },
];

function totalesCat(cat) {
  return (cat.items || []).reduce(
    (a, it) => { const c = calcItem(it); a.costo += c.costo; a.pagado += c.pagado; a.pendiente += c.pendiente; return a; },
    { costo: 0, pagado: 0, pendiente: 0 }
  );
}

function PanelGastos({ data, update, fechaRef }) {
  const confirm = useConfirm();
  const [modalCat, setModalCat] = useState(null);
  const [ordenGastos, setOrdenGastos] = useState(() => {
    try { return localStorage.getItem(ORDEN_GASTOS_KEY) || "default"; } catch { return "default"; }
  });
  const cambiarOrden = (id) => { setOrdenGastos(id); try { localStorage.setItem(ORDEN_GASTOS_KEY, id); } catch {} };

  const categoriasOrdenadas = (() => {
    const arr = data.categorias.map((cat) => ({ cat, tot: totalesCat(cat) }));
    switch (ordenGastos) {
      case "nombre": arr.sort((a, b) => (a.cat.nombre || "").localeCompare(b.cat.nombre || "")); break;
      case "costoDesc": arr.sort((a, b) => b.tot.costo - a.tot.costo); break;
      case "pendienteDesc": arr.sort((a, b) => b.tot.pendiente - a.tot.pendiente); break;
      case "pagadoDesc": arr.sort((a, b) => b.tot.pagado - a.tot.pagado); break;
      default: break;
    }
    return arr.map((x) => x.cat);
  })();

  const guardarCat = async ({ nombre, emoji, items }) => {
    const catId = modalCat?.cat?.id;
    if (!(await confirm(catId ? "¿Guardar los cambios de la categoría?" : "¿Crear la categoría?"))) return;
    update((d) => {
      if (catId) {
        const c = d.categorias.find((x) => x.id === catId);
        c.nombre = nombre;
        c.emoji = emoji;
        c.items = items;
      } else {
        d.categorias.push({ id: uid(), nombre, emoji: emoji || "💞", items });
      }
      return d;
    });
    setModalCat(null);
  };

  const sugeridas = async () => {
    if (!(await confirm("¿Agregar las categorías sugeridas?"))) return;
    update((d) => {
      CATEGORIAS_SUGERIDAS.forEach((c) => d.categorias.push({ id: uid(), ...c, items: [] }));
      return d;
    });
  };

  return (
    <div>
      <div style={st.sectionHead}>
        <p style={st.hint}>Tocá una categoría para ver y cargar sus ítems.</p>
        {data.categorias.length === 0 && <button style={st.btnGhost} onClick={sugeridas}>+ Sugeridas</button>}
      </div>

      {data.categorias.length > 1 && (
        <div style={st.ordenGastosWrap}>
          <span style={{ fontSize: 12, color: C.wineSoft, fontFamily: F.body, flexShrink: 0 }}>Ordenar:</span>
          <div style={st.ordenChips}>
            {ORDENES_GASTOS.map((o) => (
              <button key={o.id} onClick={() => cambiarOrden(o.id)} style={ordenGastos === o.id ? st.ordenChipOn : st.ordenChip}>{o.label}</button>
            ))}
          </div>
        </div>
      )}

      {data.categorias.length === 0 && (
        <div style={st.empty}>
          Todavía no cargaste nada. Tocá <strong>+ Categoría</strong> abajo (ej. <em>Novia</em>) y después agregale ítems (vestido, maquillaje, zapatos…).
        </div>
      )}

      {categoriasOrdenadas.map((cat) => (
        <Categoria key={cat.id} cat={cat} update={update} fechaRef={fechaRef} onEditar={() => setModalCat({ cat })} />
      ))}

      <button style={st.fab} onClick={() => setModalCat({})}>+ Categoría</button>

      {modalCat && (
        <ModalCategoria inicial={modalCat.cat} onClose={() => setModalCat(null)} onSave={guardarCat} />
      )}
    </div>
  );
}

function Categoria({ cat, update, fechaRef, onEditar }) {
  const confirm = useConfirm();
  const [abierta, setAbierta] = useState(false);
  const [nuevoItem, setNuevoItem] = useState(false);

  const tot = cat.items.reduce(
    (a, it) => {
      const c = calcItem(it);
      a.costo += c.costo;
      a.pagado += c.pagado;
      return a;
    },
    { costo: 0, pagado: 0 }
  );
  const completoCat = tot.costo > 0 && tot.pagado >= tot.costo;

  const borrarCat = async () => {
    if (!(await confirm(`¿Eliminar la categoría “${cat.nombre}” y todos sus ítems? No se puede deshacer.`, "peligro"))) return;
    update((d) => {
      d.categorias = d.categorias.filter((c) => c.id !== cat.id);
      return d;
    });
  };

  const agregarItem = async (item) => {
    if (!(await confirm("¿Agregar la subcategoría?"))) return;
    update((d) => {
      d.categorias.find((x) => x.id === cat.id).items.push(item);
      return d;
    });
    setNuevoItem(false);
  };

  return (
    <div style={st.catCard}>
      <div style={st.catHead}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, cursor: "pointer" }} onClick={() => setAbierta((a) => !a)}>
          <span style={{ fontSize: 22 }}>{cat.emoji}</span>
          <div>
            <div style={st.catNombre}>{cat.nombre}</div>
            <div style={st.catTot}>
              <span style={{ fontSize: 17, fontWeight: completoCat ? 700 : 600, color: completoCat ? C.sage : C.wine }}>{fmt(tot.pagado)}</span>
              <span> / {fmt(tot.costo)} · {cat.items.length} ítem(s)</span>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button style={st.iconBtn} title="Editar" onClick={onEditar}>✏️</button>
          <button style={st.iconBtn} title="Eliminar" onClick={borrarCat}>🗑️</button>
          <button style={st.iconBtn} onClick={() => setAbierta((a) => !a)}>{abierta ? "▲" : "▼"}</button>
        </div>
      </div>

      {abierta && (
        <div style={{ padding: "2px 12px 14px" }}>
          {cat.items.length === 0 && (
            <p style={{ ...st.hint, margin: "8px 0" }}>Sin ítems todavía. Agregá la primera subcategoría.</p>
          )}
          {cat.items.map((it) => (
            <Item key={it.id} catId={cat.id} item={it} update={update} fechaRef={fechaRef} />
          ))}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            <button style={st.btnSm} onClick={() => setNuevoItem(true)}>+ Agregar ítem</button>
            <button style={st.btnGhostSm} onClick={onEditar}>✏️ Editar categoría e ítems</button>
          </div>
        </div>
      )}

      {nuevoItem && <ModalNuevoItem onClose={() => setNuevoItem(false)} onSave={agregarItem} />}
    </div>
  );
}

/* =============================== Ítem ================================== */
function Item({ catId, item, update, fechaRef }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [formPago, setFormPago] = useState(false);
  const c = useMemo(() => calcItem(item), [item]);

  const mutar = (fn) =>
    update((d) => {
      const cat = d.categorias.find((x) => x.id === catId);
      fn(cat.items.find((x) => x.id === item.id));
      return d;
    });

  const registrarPago = async (monto, fecha, nota) => {
    if (!(await confirm(`¿Registrar pago de ${fmt(monto)}?`))) return;
    mutar((it) => it.pagos.push({ id: uid(), monto, fecha, nota }));
    setFormPago(false);
  };

  const pagarSaldo = async () => {
    if (c.pendiente <= 0) return;
    if (!(await confirm(`¿Registrar el saldo restante (${fmt(c.pendiente)}) como pagado hoy?`))) return;
    mutar((it) => it.pagos.push({ id: uid(), monto: c.pendiente, fecha: todayISO(), nota: "Saldo final" }));
  };

  const borrarPago = async (pid) => {
    if (!(await confirm("¿Eliminar este pago del historial?", "peligro"))) return;
    mutar((it) => (it.pagos = it.pagos.filter((y) => y.id !== pid)));
  };

  const venc = c.proxima ? diasEntre(c.proxima.fechaVencimiento, fechaRef) : item.fechaLimite ? diasEntre(item.fechaLimite, fechaRef) : null;

  return (
    <div style={st.itemCard}>
      <div style={st.itemHead}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={st.itemNombre}>{item.nombre}</span>
            <span style={c.completo ? st.badgePago : st.badgePend}>{c.completo ? "Pagado" : "Pendiente"}</span>
          </div>
          <div style={st.itemSub}>
            {item.modalidad === "cuotas"
              ? `${c.cuotasTot - c.cuotasPend}/${c.cuotasTot} cuotas` + (c.proxima ? ` · próx. ${fmtFecha(c.proxima.fechaVencimiento)}` : "")
              : item.fechaLimite
              ? `Límite ${fmtFecha(item.fechaLimite)}`
              : "Pago único"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: F.serif, color: C.wine, fontWeight: 600, fontSize: 15 }}>
            {fmt(c.pagado)} <span style={{ color: C.wineSoft, fontWeight: 400, fontSize: 13 }}>/ {fmt(c.costo)}</span>
          </div>
        </div>
      </div>

      <div style={st.barTrackSm}><div style={{ ...st.barFillSm, width: `${c.pct}%`, background: c.completo ? C.sage : `linear-gradient(90deg, ${C.rose}, ${C.gold})` }} /></div>

      {venc != null && venc <= 7 && c.pendiente > 0 && (
        <div style={st.alerta}>{venc < 0 ? `⚠ Vencido hace ${Math.abs(venc)} día(s)` : venc === 0 ? "⚠ Vence hoy" : `⏰ Vence en ${venc} día(s)`}</div>
      )}

      <div style={st.histToggle} onClick={() => setOpen((o) => !o)}>
        <span>{item.modalidad === "cuotas" ? "Cuotas" : "Historial de pagos"}</span>
        <span style={{ transition: "transform .2s", transform: open ? "rotate(90deg)" : "none", color: C.rose, fontSize: 18, lineHeight: 1 }}>›</span>
      </div>

      {open && (
        <div style={{ padding: "8px 12px 12px", background: "#fffaf7" }}>
          {item.modalidad === "libre" ? (
            <>
              {item.pagos.length === 0 ? (
                <p style={st.hint}>Sin pagos registrados.</p>
              ) : (
                item.pagos
                  .slice()
                  .sort((a, b) => b.fecha.localeCompare(a.fecha))
                  .map((p) => (
                    <div key={p.id} style={st.linea}>
                      <span style={{ width: 80 }}>{fmtFecha(p.fecha)}</span>
                      <span style={{ flex: 1, color: C.wineSoft, fontSize: 12 }}>{p.nota || "—"}</span>
                      <span style={{ color: C.sage, fontWeight: 600 }}>{fmt(p.monto)}</span>
                      <button style={st.x} onClick={() => borrarPago(p.id)}>✕</button>
                    </div>
                  ))
              )}
              {c.completo ? (
                <div style={{ ...st.hint, color: C.sage, fontWeight: 600, marginTop: 10 }}>Pagado al 100% 🎉</div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button style={st.btnSm} onClick={() => setFormPago(true)}>+ Registrar pago</button>
                  {c.pendiente > 0 && <button style={st.btnGhostSm} onClick={pagarSaldo}>Pagar saldo</button>}
                </div>
              )}
            </>
          ) : (
            <>
              {item.cuotas.length === 0 ? (
                <p style={st.hint}>Configurá las cuotas editando la subcategoría (✏️).</p>
              ) : (
                item.cuotas
                  .slice()
                  .sort((a, b) => a.fechaVencimiento.localeCompare(b.fechaVencimiento))
                  .map((q, idx) => (
                    <div key={q.id} style={st.linea}>
                      <input
                        type="checkbox"
                        checked={q.pagada}
                        onChange={async () => {
                          if (!(await confirm(q.pagada ? "¿Marcar la cuota como NO pagada?" : "¿Marcar la cuota como pagada?"))) return;
                          mutar((it) => {
                            const cc = it.cuotas.find((y) => y.id === q.id);
                            cc.pagada = !cc.pagada;
                            cc.fechaPago = cc.pagada ? todayISO() : null;
                          });
                        }}
                      />
                      <span style={{ flex: 1, fontSize: 12 }}>
                        Cuota {idx + 1} · vence {fmtFecha(q.fechaVencimiento)}
                        {q.pagada && <span style={{ color: C.sage }}> · pagada {fmtFecha(q.fechaPago)}</span>}
                      </span>
                      <span style={{ color: q.pagada ? C.sage : C.terra, fontWeight: 600 }}>{fmt(q.monto)}</span>
                    </div>
                  ))
              )}
            </>
          )}

        </div>
      )}

      {formPago && <ModalPago onClose={() => setFormPago(false)} onSave={registrarPago} />}
    </div>
  );
}

/* ========================== PANEL · NOTAS ============================== */
const estadoRecordatorio = (n, hoy) => {
  if (n.tipo !== "recordatorio" || !n.recordatorioFecha) return null;
  const d = diasEntre(n.recordatorioFecha, hoy);
  if (d < 0) return { txt: `Venció hace ${Math.abs(d)} d`, color: C.terra, urgente: true };
  if (d === 0) return { txt: "¡Es hoy!", color: C.terra, urgente: true };
  if (d <= 7) return { txt: `En ${d} día(s)`, color: C.gold, urgente: false };
  return { txt: fmtFecha(n.recordatorioFecha), color: C.wineSoft, urgente: false };
};

function NotaItem({ n, onVer, onBorrar, onToggleHecha }) {
  const pressTimer = React.useRef(null);
  const [presionando, setPresionando] = useState(false);
  const hecha = !!n.hecha;
  const rec = estadoRecordatorio(n, todayISO());

  const iniciarPress = (e) => {
    e.preventDefault();
    setPresionando(true);
    pressTimer.current = setTimeout(() => {
      setPresionando(false);
      onToggleHecha(n.id, !hecha);
    }, 3000);
  };
  const cancelarPress = () => {
    setPresionando(false);
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
  };

  return (
    <div
      style={{
        ...st.notaItem,
        ...(hecha ? st.notaItemHecha : {}),
        ...(rec?.urgente && !hecha ? { borderColor: C.terra, background: "#fff6f1" } : {}),
        ...(presionando ? { opacity: 0.7, transform: "scale(0.98)" } : {}),
        userSelect: "none", WebkitUserSelect: "none",
        transition: "opacity .15s, transform .15s",
      }}
      onPointerDown={iniciarPress}
      onPointerUp={cancelarPress}
      onPointerLeave={cancelarPress}
      onPointerCancel={cancelarPress}
      onClick={() => onVer(n)}
    >
      {presionando && (
        <div style={st.notaProgress}>
          <div style={{ ...st.notaProgressBar, animation: "notaPress 3s linear forwards" }} />
        </div>
      )}
      {n.tipo === "recordatorio" && <span style={{ fontSize: 13, flexShrink: 0 }}>⏰</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ ...st.notaItemTitulo, ...(hecha ? st.notaItemTituloHecha : {}) }}>
          {n.titulo || <em style={{ color: C.wineSoft }}>Sin título</em>}
        </span>
        {rec && !hecha && <div style={{ fontSize: 11, color: rec.color, fontFamily: F.body, fontWeight: 600 }}>{rec.txt}</div>}
      </div>
      {hecha && <span style={st.notaCheckBadge}>✓</span>}
      <button
        style={st.notaBorrarBtn}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onBorrar(n.id); }}
        title="Eliminar"
      >✕</button>
    </div>
  );
}

function PanelNotas({ data, update }) {
  const confirm = useConfirm();
  const [modalVer, setModalVer] = useState(null);
  const [modalNueva, setModalNueva] = useState(false);
  const notas = data.notas || [];

  const borrarNota = async (id) => {
    if (!(await confirm("¿Eliminar esta nota?", "peligro"))) return;
    update((d) => { d.notas = (d.notas || []).filter((n) => n.id !== id); return d; });
  };

  const toggleHecha = (id, valor) => {
    update((d) => {
      const n = (d.notas || []).find((x) => x.id === id);
      if (n) n.hecha = valor;
      return d;
    });
  };

  const guardarNota = async ({ titulo, descripcion, tipo, recordatorioFecha }) => {
    if (!titulo.trim() && !descripcion.trim()) return;
    if (!(await confirm("¿Guardar la nota?"))) return;
    update((d) => {
      d.notas = [{ id: uid(), titulo: titulo.trim(), descripcion: descripcion.trim(), fecha: todayISO(), hecha: false, tipo, recordatorioFecha: tipo === "recordatorio" ? recordatorioFecha : null }, ...(d.notas || [])];
      return d;
    });
    setModalNueva(false);
  };

  const pendientes = notas.filter((n) => !n.hecha);
  // recordatorios arriba (por fecha más próxima); notas comunes abajo (orden de carga)
  const recordatorios = pendientes
    .filter((n) => n.tipo === "recordatorio" && n.recordatorioFecha)
    .sort((a, b) => (a.recordatorioFecha || "").localeCompare(b.recordatorioFecha || ""));
  const notasComunes = pendientes.filter((n) => !(n.tipo === "recordatorio" && n.recordatorioFecha));
  const hechas = notas.filter((n) => n.hecha);

  const renderLista = (arr) => (
    <div style={st.notaLista}>
      {arr.map((n) => (
        <NotaItem key={n.id} n={n} onVer={setModalVer} onBorrar={borrarNota} onToggleHecha={toggleHecha} />
      ))}
    </div>
  );

  return (
    <div>
      <p style={{ ...st.hint, marginBottom: 12 }}>Tocá para ver · Mantené 3 seg para marcar como lista</p>

      {notas.length === 0 && (
        <div style={st.empty}>Todavía no hay notas. Tocá <strong>+ Nota</strong> para agregar la primera.</div>
      )}

      {recordatorios.length > 0 && (
        <>
          <div style={st.notaSeccionTit}>⏰ Recordatorios</div>
          {renderLista(recordatorios)}
        </>
      )}

      {recordatorios.length > 0 && notasComunes.length > 0 && <div style={st.notaDivisor} />}

      {notasComunes.length > 0 && (
        <>
          <div style={st.notaSeccionTit}>📝 Notas</div>
          {renderLista(notasComunes)}
        </>
      )}

      {hechas.length > 0 && (
        <>
          <div style={{ ...st.notaSeccionTit, marginTop: 16 }}>Listas ✓</div>
          {renderLista(hechas)}
        </>
      )}

      <button style={st.fab} onClick={() => setModalNueva(true)}>+ Nota</button>

      {modalVer && <ModalVerNota nota={modalVer} onClose={() => setModalVer(null)} />}

      {modalNueva && (
        <Sheet titulo="Nueva nota" onClose={() => setModalNueva(false)}>
          <ModalNuevaNota onClose={() => setModalNueva(false)} onSave={guardarNota} />
        </Sheet>
      )}
    </div>
  );
}

function ModalVerNota({ nota, onClose }) {
  return (
    <div style={{ ...st.overlay, zIndex: 50, alignItems: "center" }} onClick={onClose}>
      <div style={st.cuadernillo} onClick={(e) => e.stopPropagation()}>
        {/* espiral */}
        <div style={st.cuadernilloEspiral}>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} style={st.cuadernilloAnillo} />
          ))}
        </div>
        {/* hoja */}
        <div style={st.cuadernilloHoja}>
          {/* línea de margen roja */}
          <div style={st.cuadernilloMargen} />
          {/* líneas de renglón */}
          <div style={st.cuadernilloRenglones} />
          {/* contenido */}
          <div style={st.cuadernilloContenido}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
              <div style={st.cuadernilloTitulo}>{nota.titulo || <em>Sin título</em>}</div>
              <button style={{ ...st.iconBtn, color: C.wineSoft, fontSize: 18 }} onClick={onClose}>✕</button>
            </div>
            <div style={st.cuadernilloFecha}>
              {nota.tipo === "recordatorio" && nota.recordatorioFecha
                ? `⏰ Recordatorio · ${fmtFecha(nota.recordatorioFecha)}`
                : `Creada el ${fmtFecha(nota.fecha)}`}
            </div>
            <p style={st.cuadernilloTexto}>
              {nota.descripcion || <em style={{ color: "#b5966a" }}>Sin descripción.</em>}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalNuevaNota({ onClose, onSave }) {
  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [tipo, setTipo] = useState("nota");
  const [recordatorioFecha, setRecordatorioFecha] = useState(todayISO());
  const hoy = todayISO();
  const fechaPasada = tipo === "recordatorio" && recordatorioFecha < hoy;

  const puedeGuardar = (titulo.trim() || descripcion.trim()) && !(tipo === "recordatorio" && (!recordatorioFecha || fechaPasada));

  return (
    <>
      <Campo label="Tipo">
        <div style={{ display: "flex", gap: 8 }}>
          {[["nota", "📝 Nota"], ["recordatorio", "⏰ Recordatorio"]].map(([v, tx]) => (
            <button key={v} onClick={() => setTipo(v)} style={tipo === v ? st.toggleOn : st.toggleOff}>{tx}</button>
          ))}
        </div>
      </Campo>
      <Campo label="Título"><input style={st.input} value={titulo} autoFocus placeholder="Ej. Pendiente con el salón…" onChange={(e) => setTitulo(e.target.value)} /></Campo>
      {tipo === "recordatorio" && (
        <Campo label="Fecha del recordatorio">
          <input style={st.input} type="date" min={hoy} value={recordatorioFecha} onChange={(e) => setRecordatorioFecha(e.target.value)} />
          {fechaPasada && <div style={{ fontSize: 12, color: C.terra, marginTop: 4 }}>No se pueden cargar fechas pasadas.</div>}
        </Campo>
      )}
      <Campo label="Descripción">
        <textarea
          style={{ ...st.input, minHeight: 100, resize: "vertical", lineHeight: 1.5 }}
          value={descripcion}
          placeholder="Escribí los detalles acá…"
          onChange={(e) => setDescripcion(e.target.value)}
        />
      </Campo>
      <Acciones onClose={onClose} ok={() => { if (puedeGuardar) onSave({ titulo, descripcion, tipo, recordatorioFecha }); }} />
    </>
  );
}

/* ========================== PANEL · AHORROS ============================ */
function PanelAhorros({ data, update, t }) {
  const confirm = useConfirm();
  const [fAhorro, setFAhorro] = useState(false);
  const [fIngreso, setFIngreso] = useState(false);

  const borrar = async (key, id) => {
    if (!(await confirm("¿Eliminar este registro?", "peligro"))) return;
    update((d) => {
      d[key] = d[key].filter((y) => y.id !== id);
      return d;
    });
  };

  const lista = (arr, key) =>
    arr.length === 0 ? (
      <p style={st.hint}>{key === "ahorros" ? "Registrá lo que vas guardando, con su fecha." : "Cargá ingresos que esperás (sueldo, aguinaldo, regalos…)."}</p>
    ) : (
      arr
        .slice()
        .sort((a, b) => b.fecha.localeCompare(a.fecha))
        .map((x) => (
          <div key={x.id} style={st.linea}>
            <span style={{ width: 80 }}>{fmtFecha(x.fecha)}</span>
            <span style={{ flex: 1, color: C.wineSoft, fontSize: 12 }}>{x.descripcion || "—"}</span>
            <span style={{ color: key === "ahorros" ? C.gold : C.sage, fontWeight: 600 }}>{fmt(x.monto)}</span>
            <button style={st.x} onClick={() => borrar(key, x.id)}>✕</button>
          </div>
        ))
    );

  return (
    <div>
      <div style={st.grid2}>
        <div style={st.card}><div style={{ fontSize: 20 }}>🐷</div><div style={{ ...st.cardVal, color: C.gold }}>{fmt(t.ahorrado)}</div><div style={st.cardLabel}>Ahorrado a la fecha</div></div>
        <div style={st.card}><div style={{ fontSize: 20 }}>{t.faltaAhorrar > 0 ? "🎯" : "🎉"}</div><div style={{ ...st.cardVal, color: t.faltaAhorrar > 0 ? C.terra : C.sage }}>{fmt(t.faltaAhorrar)}</div><div style={st.cardLabel}>Falta ahorrar</div></div>
      </div>

      <section style={st.panel}>
        <div style={st.sectionHead}><h2 style={st.h2}>🐷 Ahorros realizados</h2></div>
        {lista(data.ahorros, "ahorros")}
        <button style={{ ...st.btnSm, marginTop: 10 }} onClick={() => setFAhorro(true)}>+ Ahorro</button>
      </section>

      <section style={{ ...st.panel, marginTop: 14 }}>
        <div style={st.sectionHead}><h2 style={st.h2}>📈 Ingresos futuros</h2></div>
        {lista(data.ingresos, "ingresos")}
        <button style={{ ...st.btnSm, marginTop: 10 }} onClick={() => setFIngreso(true)}>+ Ingreso</button>
      </section>

      {fAhorro && (
        <ModalMonto titulo="Registrar ahorro" onClose={() => setFAhorro(false)} onSave={async (entries) => {
          const e = entries[0];
          if (!(await confirm(`¿Registrar ahorro de ${fmt(e.monto)}?`))) return;
          update((d) => { d.ahorros.push({ id: uid(), ...e }); return d; });
          setFAhorro(false);
        }} />
      )}
      {fIngreso && (
        <ModalMonto titulo="Ingreso futuro" permitirRepetir onClose={() => setFIngreso(false)} onSave={async (entries) => {
          const msg = entries.length > 1 ? `¿Registrar ${entries.length} ingresos futuros (total ${fmt(entries.reduce((s, e) => s + e.monto, 0))})?` : `¿Registrar ingreso futuro de ${fmt(entries[0].monto)}?`;
          if (!(await confirm(msg))) return;
          update((d) => { entries.forEach((e) => d.ingresos.push({ id: uid(), ...e })); return d; });
          setFIngreso(false);
        }} />
      )}
    </div>
  );
}

/* =============================== Modales =============================== */
function Sheet({ children, onClose, titulo }) {
  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={st.sheetHandle} />
        <h3 style={{ ...st.h3, marginTop: 0 }}>{titulo}</h3>
        {children}
      </div>
    </div>
  );
}

function ConfirmModal({ mensaje, tono, resolve }) {
  return (
    <div style={{ ...st.overlay, zIndex: 80, alignItems: "center" }} onClick={() => resolve(false)}>
      <div style={st.confirm} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 26, marginBottom: 6 }}>{tono === "peligro" ? "⚠️" : "💍"}</div>
        <p style={{ fontFamily: F.body, color: C.wine, fontSize: 15, margin: "0 0 16px", lineHeight: 1.4 }}>{mensaje}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button style={{ ...st.btnGhost, flex: 1 }} onClick={() => resolve(false)}>No</button>
          <button style={{ ...(tono === "peligro" ? st.btnPeligro : st.btn), flex: 1 }} onClick={() => resolve(true)}>Sí, confirmar</button>
        </div>
      </div>
    </div>
  );
}

function ModalCategoria({ inicial, onClose, onSave }) {
  const confirm = useConfirm();
  const [nombre, setNombre] = useState(inicial?.nombre || "");
  const [emoji, setEmoji] = useState(inicial?.emoji || "💞");
  const [items, setItems] = useState(() =>
    (inicial?.items || []).map((it) => {
      const copy = { ...it, yaPagado: "" };
      if (copy.modalidad === "cuotas") {
        if (copy.cuotasCantidad == null && (copy.cuotas?.length || 0) > 0) copy.cuotasCantidad = copy.cuotas.length;
        if (!copy.cuotasInicio && (copy.cuotas?.length || 0) > 0)
          copy.cuotasInicio = copy.cuotas.map((q) => q.fechaVencimiento).sort()[0];
      }
      return copy;
    })
  );

  const setIt = (id, patch) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const addIt = () =>
    setItems((xs) => [
      ...xs,
      { id: uid(), nombre: "", presupuesto: "", yaPagado: "", modalidad: "libre", fechaLimite: "", pagos: [], cuotas: [] },
    ]);
  const delIt = async (it) => {
    const tienePagos = (it.pagos?.length || 0) + (it.cuotas?.length || 0) > 0;
    if (tienePagos && !(await confirm(`El ítem “${it.nombre || "sin nombre"}” tiene pagos cargados. ¿Eliminarlo igual?`, "peligro"))) return;
    setItems((xs) => xs.filter((x) => x.id !== it.id));
  };

  const guardar = () => {
    if (!nombre.trim()) return;
    const limpios = items
      .filter((it) => (it.nombre || "").trim() !== "")
      .map((it) => {
        const costo = Number(it.presupuesto) || 0;
        const esCuotas = it.modalidad === "cuotas";
        const montoYaPagado = Number(it.yaPagado) || 0;
        const pagosExistentes = it.pagos || [];
        const pagosFinales = montoYaPagado > 0
          ? [...pagosExistentes, { id: uid(), monto: montoYaPagado, fecha: todayISO(), nota: "Pago inicial" }]
          : pagosExistentes;
        return {
          id: it.id,
          nombre: it.nombre.trim(),
          presupuesto: costo,
          reservado: 0,
          modalidad: it.modalidad,
          fechaLimite: esCuotas ? null : it.fechaLimite || null,
          cuotasCantidad: esCuotas ? parseInt(it.cuotasCantidad) || 0 : null,
          cuotasInicio: esCuotas ? it.cuotasInicio || null : null,
          pagos: pagosFinales,
          cuotas: esCuotas ? generarCuotas(costo, it.cuotasCantidad, it.cuotasInicio, it.cuotas || []) : [],
        };
      });
    onSave({ nombre: nombre.trim(), emoji, items: limpios });
  };

  return (
    <Sheet titulo={inicial ? "Editar categoría" : "Nueva categoría"} onClose={onClose}>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ width: 70 }}>
          <Campo label="Emoji"><input style={st.input} value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={2} /></Campo>
        </div>
        <Campo label="Nombre de la categoría"><input style={st.input} value={nombre} placeholder="Ej. Novia" onChange={(e) => setNombre(e.target.value)} /></Campo>
      </div>

      <div style={st.subTit}>Ítems (subcategorías)</div>
      <div style={st.itemsEditWrap}>
        {items.length === 0 && <p style={st.hint}>Sin ítems. Agregá el primero abajo.</p>}
        {items.map((it) => (
          <div key={it.id} style={st.itemEditRow}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input style={{ ...st.input, flex: 1 }} value={it.nombre} placeholder="Ej. Vestido" onChange={(e) => setIt(it.id, { nombre: e.target.value })} />
              <button style={st.x} title="Eliminar ítem" onClick={() => delIt(it)}>🗑️</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <MoneyInput small value={it.presupuesto} placeholder="Costo" onChange={(v) => setIt(it.id, { presupuesto: v })} />
              <MoneyInput small value={it.yaPagado ?? ""} placeholder="Ya pagado" onChange={(v) => setIt(it.id, { yaPagado: v })} />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {[["libre", "Pago único"], ["cuotas", "Cuotas"]].map(([v, tx]) => (
                <button key={v} onClick={() => setIt(it.id, { modalidad: v })} style={it.modalidad === v ? st.toggleOnSm : st.toggleOffSm}>{tx}</button>
              ))}
            </div>
            {it.modalidad === "libre" ? (
              <div style={{ marginTop: 6 }}>
                <label style={st.miniLabel}>Fecha límite (opcional)</label>
                <input style={{ ...st.inputSm, width: "100%", boxSizing: "border-box" }} type="date" value={it.fechaLimite || ""} onChange={(e) => setIt(it.id, { fechaLimite: e.target.value })} />
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={st.miniLabel}>Cantidad cuotas</label>
                    <input style={{ ...st.inputSm, width: "100%", boxSizing: "border-box" }} type="number" value={it.cuotasCantidad ?? ""} placeholder="Ej. 6" onChange={(e) => setIt(it.id, { cuotasCantidad: e.target.value })} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={st.miniLabel}>1ª cuota</label>
                    <input style={{ ...st.inputSm, width: "100%", boxSizing: "border-box" }} type="date" value={it.cuotasInicio || ""} onChange={(e) => setIt(it.id, { cuotasInicio: e.target.value })} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.wineSoft, marginTop: 4 }}>
                  {(parseInt(it.cuotasCantidad) || 0) > 0 && (Number(it.presupuesto) || 0) > 0
                    ? `≈ ${fmt(Math.floor((Number(it.presupuesto) || 0) / (parseInt(it.cuotasCantidad) || 1)))} por cuota · vencimientos mensuales`
                    : "Cargá costo y cantidad para calcular cada cuota."}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <button style={{ ...st.btnSm, marginTop: 8 }} onClick={addIt}>+ Agregar ítem</button>

      <Acciones onClose={onClose} ok={guardar} />
    </Sheet>
  );
}

function ModalPago({ onClose, onSave }) {
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState(todayISO());
  const [nota, setNota] = useState("");
  return (
    <Sheet titulo="Registrar pago" onClose={onClose}>
      <Campo label="Monto"><MoneyInput value={monto} onChange={setMonto} placeholder="0" /></Campo>
      <Campo label="Fecha del pago"><input style={st.input} type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
      <Campo label="Nota (opcional)"><input style={st.input} value={nota} placeholder="Ej. Seña, transferencia…" onChange={(e) => setNota(e.target.value)} /></Campo>
      <Acciones onClose={onClose} ok={() => Number(monto) > 0 && onSave(Number(monto), fecha, nota.trim())} />
    </Sheet>
  );
}

function ModalNuevoItem({ onClose, onSave }) {
  const [nombre, setNombre] = useState("");
  const [presupuesto, setPresupuesto] = useState("");
  const [yaPagado, setYaPagado] = useState("");
  const [modalidad, setModalidad] = useState("libre");
  const [fechaLimite, setFechaLimite] = useState("");
  const [cuotasCantidad, setCuotasCantidad] = useState("3");
  const [cuotasInicio, setCuotasInicio] = useState(todayISO());

  const costo = Number(presupuesto) || 0;
  const cant = parseInt(cuotasCantidad) || 0;
  const montoCuota = cant > 0 ? Math.floor(costo / cant) : 0;

  const guardar = () => {
    if (!nombre.trim()) return;
    const esCuotas = modalidad === "cuotas";
    const montoYaPagado = Number(yaPagado) || 0;
    const pagosIniciales = montoYaPagado > 0
      ? [{ id: uid(), monto: montoYaPagado, fecha: todayISO(), nota: "Pago inicial" }]
      : [];
    onSave({
      id: uid(),
      nombre: nombre.trim(),
      presupuesto: costo,
      reservado: 0,
      modalidad,
      fechaLimite: esCuotas ? null : fechaLimite || null,
      cuotasCantidad: esCuotas ? cant : null,
      cuotasInicio: esCuotas ? cuotasInicio || null : null,
      pagos: pagosIniciales,
      cuotas: esCuotas ? generarCuotas(costo, cant, cuotasInicio, []) : [],
    });
  };

  return (
    <Sheet titulo="Nueva subcategoría" onClose={onClose}>
      <Campo label="Nombre"><input style={st.input} value={nombre} autoFocus placeholder="Ej. Vestido" onChange={(e) => setNombre(e.target.value)} /></Campo>
      <div style={{ display: "flex", gap: 10 }}>
        <Campo label="Costo estimado"><MoneyInput value={presupuesto} onChange={setPresupuesto} placeholder="0" /></Campo>
        <Campo label="Ya pagado"><MoneyInput value={yaPagado} onChange={setYaPagado} placeholder="0" /></Campo>
      </div>
      {(Number(yaPagado) || 0) > 0 && (
        <p style={{ ...st.hint, color: C.sage, marginTop: -4 }}>Se registrará {fmt(Number(yaPagado))} como pago inicial en el historial.</p>
      )}
      <Campo label="Modalidad de pago">
        <div style={{ display: "flex", gap: 8 }}>
          {[["libre", "Pago único"], ["cuotas", "En cuotas"]].map(([v, tx]) => (
            <button key={v} onClick={() => setModalidad(v)} style={modalidad === v ? st.toggleOn : st.toggleOff}>{tx}</button>
          ))}
        </div>
      </Campo>
      {modalidad === "libre" ? (
        <Campo label="Fecha límite (opcional)"><input style={st.input} type="date" value={fechaLimite} onChange={(e) => setFechaLimite(e.target.value)} /></Campo>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10 }}>
            <Campo label="Cantidad de cuotas"><input style={st.input} type="number" value={cuotasCantidad} placeholder="Ej. 6" onChange={(e) => setCuotasCantidad(e.target.value)} /></Campo>
            <Campo label="Fecha 1ª cuota"><input style={st.input} type="date" value={cuotasInicio} onChange={(e) => setCuotasInicio(e.target.value)} /></Campo>
          </div>
          <p style={st.hint}>
            {cant > 0 && costo > 0
              ? `Cada cuota: ${fmt(montoCuota)} (la última ajusta el redondeo) · vencimientos mensuales`
              : "Cargá el costo y la cantidad para calcular el valor de cada cuota."}
          </p>
        </>
      )}
      <Acciones onClose={onClose} ok={guardar} />
    </Sheet>
  );
}

function ModalMonto({ titulo, onClose, onSave, permitirRepetir }) {
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState(todayISO());
  const [desc, setDesc] = useState("");
  const [repetir, setRepetir] = useState(false);
  const [frecuencia, setFrecuencia] = useState("mensual");
  const [veces, setVeces] = useState("12");

  const n = Math.max(1, parseInt(veces) || 1);
  const construir = () => {
    const m = Number(monto) || 0;
    if (m <= 0) return [];
    if (!permitirRepetir || !repetir) return [{ monto: m, fecha, descripcion: desc.trim() }];
    const arr = [];
    for (let i = 0; i < n; i++) arr.push({ monto: m, fecha: addFecha(fecha, i, frecuencia), descripcion: desc.trim() });
    return arr;
  };

  return (
    <Sheet titulo={titulo} onClose={onClose}>
      <Campo label="Monto"><MoneyInput value={monto} onChange={setMonto} placeholder="0" /></Campo>
      <Campo label={permitirRepetir && repetir ? "Fecha del primero" : "Fecha"}><input style={st.input} type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
      <Campo label="Descripción (opcional)"><input style={st.input} value={desc} placeholder="Ej. Sueldo, aguinaldo…" onChange={(e) => setDesc(e.target.value)} /></Campo>

      {permitirRepetir && (
        <Campo label="¿Se repite?">
          <div style={{ display: "flex", gap: 8 }}>
            {[[false, "Una vez"], [true, "Repetir"]].map(([v, tx]) => (
              <button key={tx} onClick={() => setRepetir(v)} style={repetir === v ? st.toggleOn : st.toggleOff}>{tx}</button>
            ))}
          </div>
        </Campo>
      )}

      {permitirRepetir && repetir && (
        <>
          <Campo label="Frecuencia">
            <div style={{ display: "flex", gap: 8 }}>
              {[["mensual", "Mensual"], ["quincenal", "Quincenal"], ["anual", "Anual"]].map(([v, tx]) => (
                <button key={v} onClick={() => setFrecuencia(v)} style={frecuencia === v ? st.toggleOnSm : st.toggleOffSm}>{tx}</button>
              ))}
            </div>
          </Campo>
          <Campo label="Cantidad de veces">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((num) => (
                <button key={num} onClick={() => setVeces(String(num))} style={n === num ? st.numBtnOn : st.numBtn}>{num}</button>
              ))}
            </div>
          </Campo>
          {Number(monto) > 0 && (
            <p style={st.hint}>
              Se generarán {n} ingresos de {fmt(Number(monto))} desde el {fmtFecha(fecha)} hasta el {fmtFecha(addFecha(fecha, n - 1, frecuencia))}. Total: <strong style={{ color: C.sage }}>{fmt(Number(monto) * n)}</strong>.
            </p>
          )}
        </>
      )}

      <Acciones onClose={onClose} ok={() => { const e = construir(); if (e.length) onSave(e); }} />
    </Sheet>
  );
}

/* ----------------------------- Mini UI -------------------------------- */
function MoneyInput({ value, onChange, placeholder, small }) {
  const display = value === "" || value == null ? "" : Number(value).toLocaleString("es-AR");
  const handle = (e) => {
    const d = e.target.value.replace(/[^\d]/g, "");
    onChange(d === "" ? "" : Number(d));
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
      <span style={{ color: C.wineSoft, fontFamily: F.body, fontSize: small ? 14 : 17, fontWeight: 600 }}>$</span>
      <input type="text" inputMode="numeric" value={display} placeholder={placeholder} onChange={handle} style={small ? st.inputSm : st.input} />
    </div>
  );
}

function Campo({ label, children }) {
  return (
    <div style={{ marginBottom: 12, flex: 1 }}>
      <label style={{ fontFamily: F.body, fontSize: 13, color: C.wineSoft, display: "block", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
function Acciones({ onClose, ok }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
      <button style={st.btnGhost} onClick={onClose}>Cancelar</button>
      <button style={st.btn} onClick={ok}>Continuar</button>
    </div>
  );
}

/* ------------------------------ Fuentes -------------------------------- */
/* ============================== Splash ================================= */
function RingsLogo() {
  return (
    <svg width="132" height="104" viewBox="0 0 132 104" aria-hidden="true">
      <circle cx="50" cy="60" r="32" fill="none" stroke={C.gold} strokeWidth="6" />
      <circle cx="82" cy="60" r="32" fill="none" stroke={C.rose} strokeWidth="6" />
      <g style={{ animation: "pbshimmer 1.6s ease-in-out infinite" }}>
        <path d="M82 10 l11 11 -11 13 -11 -13 z" fill={C.gold} />
        <path d="M82 10 l11 11 -11 13 -11 -13 z" fill="none" stroke="#fff8" strokeWidth="1" />
      </g>
    </svg>
  );
}
function Spinner() {
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" style={{ animation: "pbspin .9s linear infinite" }}>
      <circle cx="19" cy="19" r="15" fill="none" stroke={C.roseLite} strokeWidth="4" />
      <path d="M19 4 a15 15 0 0 1 15 15" fill="none" stroke={C.wine} strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
function Splash() {
  return (
    <div style={st.shell}>
      <Fuentes />
      <div style={st.bg} />
      <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 480, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: 28, textAlign: "center" }}>
        <div style={{ animation: "pbfloat 2.6s ease-in-out infinite" }}>
          <RingsLogo />
        </div>
        <div style={{ animation: "pbfade .9s ease both" }}>
          <div style={{ fontSize: 13, letterSpacing: 6, color: C.gold, fontFamily: F.body }}>BODA</div>
          <h1 style={{ fontFamily: F.serif, fontSize: 48, fontWeight: 700, color: C.wine, margin: "2px 0 0", lineHeight: 1 }}>Ale &amp; Cande</h1>
        </div>
        <div style={{ marginTop: 6 }}>
          <Spinner />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Fuentes -------------------------------- */
function Fuentes() {
  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Jost:wght@400;500;600&display=swap";
    document.head.appendChild(l);
    const s = document.createElement("style");
    s.textContent =
      "@keyframes slideUp{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}" +
      "@keyframes pbspin{to{transform:rotate(360deg)}}" +
      "@keyframes pbfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}" +
      "@keyframes pbfade{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:translateY(0)}}" +
      "@keyframes pbshimmer{0%,100%{opacity:.4}50%{opacity:1}}" +
      "@keyframes notaPress{from{width:0%}to{width:100%}}" +
      "@keyframes cartaLatido{0%,100%{transform:scale(1) rotate(-4deg)}50%{transform:scale(1.12) rotate(4deg)}}";
    document.head.appendChild(s);
    return () => { document.head.removeChild(l); document.head.removeChild(s); };
  }, []);
  return null;
}

/* ------------------------------ Paleta --------------------------------- */
const C = {
  ivory: "#fbf4ee", ivory2: "#f6e9e0", wine: "#7a2e3f", wineSoft: "#a9707c",
  rose: "#c98a98", roseLite: "#ecd3d8", gold: "#c2a050", sage: "#6f8f6a",
  terra: "#bb6b4a", line: "#ead9d0", card: "#ffffff",
};
const F = { serif: "'Cormorant Garamond', Georgia, serif", body: "'Jost', system-ui, sans-serif" };

/* ------------------------------ Estilos -------------------------------- */
const st = {
  shell: { minHeight: "100vh", position: "relative", fontFamily: F.body, color: C.wine, background: C.ivory, display: "flex", justifyContent: "center", alignItems: "flex-start" },
  bg: { position: "fixed", inset: 0, background: `radial-gradient(circle at 15% 8%, ${C.roseLite}55, transparent 45%), radial-gradient(circle at 85% 95%, ${C.ivory2}, transparent 50%)`, pointerEvents: "none" },
  app: { width: "100%", maxWidth: 480, minHeight: "100vh", position: "relative", zIndex: 1, display: "flex", flexDirection: "column", boxShadow: "0 0 40px #7a2e3f12", background: "#fff5" },

  topbar: { padding: "16px 16px 10px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, borderBottom: `1px solid ${C.line}`, background: `linear-gradient(180deg, ${C.ivory}, transparent)`, position: "sticky", top: 0, zIndex: 10, backdropFilter: "blur(6px)" },
  h1: { fontFamily: F.serif, fontSize: 30, fontWeight: 600, color: C.wine, margin: "0", lineHeight: 1 },
  fechaBox: { display: "inline-flex", alignItems: "center", gap: 6, background: C.card, border: `1px solid ${C.line}`, padding: "5px 8px 5px 12px", borderRadius: 30 },
  dateInput: { border: "none", fontFamily: F.body, color: C.wine, fontSize: 13, background: "transparent" },
  ojoBtn: { background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px 0", display: "flex", alignItems: "center", lineHeight: 0 },
  cartaBtn: { position: "absolute", top: 12, right: 12, background: "#fff", border: `1px solid ${C.roseLite}`, borderRadius: "50%", width: 38, height: 38, fontSize: 19, cursor: "pointer", boxShadow: "0 3px 10px #7a2e3f22", display: "flex", alignItems: "center", justifyContent: "center", animation: "cartaLatido 1.8s ease-in-out infinite", zIndex: 12 },
  cartaModal: { background: `linear-gradient(160deg, #fff, ${C.ivory})`, borderRadius: 20, padding: "24px 22px", width: "calc(100% - 36px)", maxWidth: 380, boxShadow: "0 24px 60px #3a161e55", border: `1px solid ${C.roseLite}`, animation: "slideUp .25s ease", maxHeight: "86vh", overflowY: "auto" },
  cartaTexto: { fontFamily: F.body, fontSize: 15, color: C.wine, lineHeight: 1.6, margin: "0 0 12px", textAlign: "center" },

  main: { flex: 1, padding: "16px 14px 96px", overflowY: "auto" },

  nav: { position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 480, margin: "0 auto", display: "flex", background: "#fffefc", borderTop: `1px solid ${C.line}`, boxShadow: "0 -6px 20px #7a2e3f12", zIndex: 20 },
  navBtn: { flex: 1, border: "none", background: "transparent", padding: "10px 0 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, cursor: "pointer", color: C.wineSoft, fontFamily: F.body },
  navBtnOn: { color: C.wine, borderTop: `2px solid ${C.gold}`, background: `linear-gradient(180deg, ${C.roseLite}33, transparent)` },

  h2: { fontFamily: F.serif, fontSize: 23, color: C.wine, margin: "0 0 8px", fontWeight: 600 },
  h3: { fontFamily: F.serif, fontSize: 20, color: C.wine, margin: 0, fontWeight: 600 },

  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 },
  card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "14px 10px", textAlign: "center", boxShadow: "0 6px 16px #7a2e3f0d" },
  cardVal: { fontFamily: F.serif, fontSize: 21, fontWeight: 700, marginTop: 3 },
  cardLabel: { fontSize: 11, color: C.wineSoft, marginTop: 2 },

  panel: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 18, padding: 16, boxShadow: "0 6px 16px #7a2e3f0d" },
  avisoBox: { background: "#fff6f1", border: `1px solid ${C.terra}55`, borderRadius: 14, padding: 14 },
  hint: { fontSize: 13, color: C.wineSoft, fontFamily: F.body, margin: "8px 0 0" },

  barTrackSm: { height: 6, background: C.roseLite, borderRadius: 6, overflow: "hidden", margin: "0 0 8px" },
  barFillSm: { height: "100%", background: `linear-gradient(90deg, ${C.rose}, ${C.gold})`, transition: "width .4s ease" },
  catBarTop: { display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: F.body, color: C.wine, marginBottom: 4 },

  sectionHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 },
  empty: { background: "#fff8", border: `1px dashed ${C.rose}`, borderRadius: 14, padding: 18, color: C.wineSoft, fontSize: 14, textAlign: "center", lineHeight: 1.5 },

  catCard: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, marginBottom: 12, overflow: "hidden", boxShadow: "0 4px 12px #7a2e3f0a" },
  catHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 12px", background: `linear-gradient(90deg, ${C.ivory2}55, transparent)` },
  catNombre: { fontFamily: F.serif, fontSize: 20, color: C.wine, fontWeight: 600, lineHeight: 1.1 },
  catTot: { fontFamily: F.body, fontSize: 12, color: C.wineSoft },

  itemCard: { border: `1px solid ${C.line}`, borderRadius: 12, marginBottom: 8, background: "#fffdfc", padding: "8px 0 0" },
  itemHead: { display: "flex", gap: 10, padding: "0 12px 6px", alignItems: "flex-start" },
  itemNombre: { fontFamily: F.body, fontWeight: 600, color: C.wine, fontSize: 15 },
  itemSub: { fontSize: 11, color: C.wineSoft, marginTop: 2 },
  badgePago: { fontSize: 10, background: C.sage, color: "#fff", padding: "2px 7px", borderRadius: 20 },
  badgePend: { fontSize: 10, background: C.roseLite, color: C.wine, padding: "2px 7px", borderRadius: 20 },
  alerta: { fontSize: 12, color: C.terra, padding: "0 12px 8px", fontWeight: 600 },
  subTit: { fontFamily: F.body, fontWeight: 600, color: C.wine, fontSize: 13, margin: "2px 0 6px" },
  linea: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontFamily: F.body, color: C.wine, padding: "5px 0", borderBottom: `1px solid ${C.line}77` },
  x: { border: "none", background: "transparent", color: C.wineSoft, cursor: "pointer", fontSize: 12 },

  btn: { background: C.wine, color: "#fff", border: "none", borderRadius: 30, padding: "9px 18px", fontFamily: F.body, fontSize: 14, cursor: "pointer", fontWeight: 500 },
  btnPeligro: { background: C.terra, color: "#fff", border: "none", borderRadius: 30, padding: "9px 18px", fontFamily: F.body, fontSize: 14, cursor: "pointer", fontWeight: 500 },
  btnGhost: { background: "transparent", color: C.wine, border: `1px solid ${C.rose}`, borderRadius: 30, padding: "9px 16px", fontFamily: F.body, fontSize: 14, cursor: "pointer" },
  btnGhostSm: { background: "transparent", color: C.wine, border: `1px solid ${C.rose}`, borderRadius: 24, padding: "6px 12px", fontFamily: F.body, fontSize: 12, cursor: "pointer" },
  btnSm: { background: C.rose, color: "#fff", border: "none", borderRadius: 24, padding: "6px 14px", fontFamily: F.body, fontSize: 13, cursor: "pointer" },
  iconBtn: { background: "transparent", border: "none", cursor: "pointer", fontSize: 16, padding: 4, lineHeight: 1 },
  fab: { position: "sticky", bottom: 8, width: "100%", background: C.wine, color: "#fff", border: "none", borderRadius: 30, padding: "13px 0", fontFamily: F.body, fontSize: 15, cursor: "pointer", fontWeight: 600, boxShadow: "0 8px 20px #7a2e3f33", marginTop: 8 },

  toggleOn: { flex: 1, background: C.wine, color: "#fff", border: "none", borderRadius: 24, padding: "9px 0", fontFamily: F.body, cursor: "pointer", fontSize: 14 },
  toggleOff: { flex: 1, background: "transparent", color: C.wine, border: `1px solid ${C.rose}`, borderRadius: 24, padding: "9px 0", fontFamily: F.body, cursor: "pointer", fontSize: 14 },

  overlay: { position: "fixed", inset: 0, background: "#3a161e55", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50, backdropFilter: "blur(3px)" },
  sheet: { background: C.ivory, borderRadius: "22px 22px 0 0", padding: "12px 20px 28px", width: "100%", maxWidth: 480, boxShadow: "0 -10px 40px #3a161e33", border: `1px solid ${C.line}`, animation: "slideUp .25s ease" },
  sheetHandle: { width: 44, height: 4, background: C.rose, borderRadius: 4, margin: "2px auto 12px", opacity: 0.6 },
  confirm: { background: C.ivory, borderRadius: 18, padding: "22px 20px", width: "calc(100% - 48px)", maxWidth: 360, textAlign: "center", boxShadow: "0 20px 50px #3a161e55", border: `1px solid ${C.line}`, animation: "slideUp .2s ease" },
  input: { width: "100%", boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", fontFamily: F.body, fontSize: 15, color: C.wine, background: "#fff", outline: "none" },
  inputSm: { flex: 1, minWidth: 0, boxSizing: "border-box", border: `1px solid ${C.line}`, borderRadius: 9, padding: "8px 10px", fontFamily: F.body, fontSize: 13, color: C.wine, background: "#fff", outline: "none" },
  histToggle: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", cursor: "pointer", borderTop: `1px solid ${C.line}`, fontFamily: F.body, fontSize: 13, fontWeight: 600, color: C.wine },
  itemsEditWrap: { maxHeight: "42vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 },
  itemEditRow: { border: `1px solid ${C.line}`, borderRadius: 12, padding: 10, background: "#fff" },
  miniLabel: { display: "block", fontFamily: F.body, fontSize: 11, color: C.wineSoft, marginBottom: 3 },
  numBtn: { width: 42, height: 38, border: `1px solid ${C.rose}`, background: "transparent", color: C.wine, borderRadius: 10, fontFamily: F.body, fontSize: 15, cursor: "pointer" },
  numBtnOn: { width: 42, height: 38, border: "none", background: C.wine, color: "#fff", borderRadius: 10, fontFamily: F.body, fontSize: 15, cursor: "pointer", fontWeight: 700 },
  toggleOnSm: { flex: 1, background: C.wine, color: "#fff", border: "none", borderRadius: 20, padding: "6px 0", fontFamily: F.body, cursor: "pointer", fontSize: 12 },
  toggleOffSm: { flex: 1, background: "transparent", color: C.wine, border: `1px solid ${C.rose}`, borderRadius: 20, padding: "6px 0", fontFamily: F.body, cursor: "pointer", fontSize: 12 },

  /* ---- Orden gastos ---- */
  ordenGastosWrap: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
  ordenChips: { display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 },
  ordenChip: { background: "transparent", border: `1px solid ${C.line}`, color: C.wineSoft, borderRadius: 20, padding: "5px 12px", fontFamily: F.body, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  ordenChipOn: { background: C.wine, border: `1px solid ${C.wine}`, color: "#fff", borderRadius: 20, padding: "5px 12px", fontFamily: F.body, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, fontWeight: 600 },

  /* ---- Dashboard próximos ---- */
  dashArrastre: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fbf6f0", border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 14px", marginBottom: 12 },
  dashMesesWrap: { display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 },
  dashMes: { flex: "1 0 52px", minWidth: 52, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 12, padding: "6px 4px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  dashMesOn: { borderColor: C.rose, background: `${C.roseLite}44`, boxShadow: `0 0 0 1px ${C.rose}` },
  dashMesLabel: { fontFamily: F.body, fontSize: 12, fontWeight: 600, color: C.wine },
  dashMesBarras: { display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 3, height: 40, width: "100%" },
  dashBar: { width: 9, minHeight: 2, borderRadius: "3px 3px 0 0", transition: "height .4s ease" },
  dashMesNeto: { fontFamily: F.body, fontSize: 9.5, fontWeight: 600 },
  dashLeyenda: { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: C.wine, fontFamily: F.body, marginTop: 8, alignItems: "center" },
  dashDot: { display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 4, verticalAlign: "middle" },
  dashVerTodo: { background: "#fff", border: `1px solid ${C.rose}`, color: C.wine, borderRadius: 20, padding: "6px 14px", fontFamily: F.body, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  dashFechaInput: { border: `1px solid ${C.line}`, borderRadius: 8, padding: "3px 8px", fontFamily: F.body, fontSize: 13, color: C.wine, background: "#fff", outline: "none" },
  dashDesplegable: { display: "flex", alignItems: "center", width: "100%", background: "#fbf6f0", border: `1px solid ${C.line}`, borderRadius: 10, padding: "9px 12px", marginTop: 6, fontFamily: F.body, fontSize: 14, fontWeight: 600, color: C.wine, cursor: "pointer" },
  dashConteo: { color: C.wineSoft, fontWeight: 400, fontSize: 12 },
  dashEvento: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.line}77` },
  dashEventoDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  dashEventoNombre: { fontFamily: F.body, fontSize: 14, color: C.wine, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 6 },
  dashVencida: { fontSize: 9, background: C.terra, color: "#fff", padding: "1px 6px", borderRadius: 10, fontWeight: 600, flexShrink: 0 },
  dashEventoFecha: { fontSize: 11, color: C.wineSoft, marginTop: 1 },

  /* ---- Atajo panel tarjetas ---- */
  atajoBtnWrap: { display: "flex", alignItems: "center", gap: 10, background: `linear-gradient(100deg, ${C.ivory2}, #fff8f2)`, border: `1px solid ${C.roseLite}`, borderRadius: 14, padding: "11px 14px", marginBottom: 14, textDecoration: "none", color: C.wine, boxShadow: "0 2px 8px #7a2e3f0d", transition: "box-shadow .18s, transform .18s" },
  atajoEmojis: { fontSize: 20, letterSpacing: -2, flexShrink: 0 },
  atajoTexto: { flex: 1, fontFamily: F.body, fontSize: 13, color: C.wineSoft, fontWeight: 500, lineHeight: 1.3 },
  atajoArrow: { fontSize: 20, color: C.rose, fontWeight: 300, flexShrink: 0, lineHeight: 1 },

  /* ---- Notas ---- */
  notaLista: { display: "flex", flexDirection: "column", gap: 4 },
  notaItem: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, cursor: "pointer", position: "relative", overflow: "hidden", touchAction: "none" },
  notaItemHecha: { background: "#f5f0eb", border: `1px solid ${C.roseLite}` },
  notaItemTitulo: { flex: 1, fontFamily: F.body, fontSize: 15, fontWeight: 500, color: C.wine, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  notaItemTituloHecha: { textDecoration: "line-through", color: C.wineSoft, fontWeight: 400 },
  notaCheckBadge: { fontSize: 12, color: C.sage, fontWeight: 700, flexShrink: 0 },
  notaBorrarBtn: { background: "transparent", border: "none", color: C.wineSoft, cursor: "pointer", fontSize: 13, padding: "2px 6px", flexShrink: 0, lineHeight: 1 },
  notaSeccionTit: { fontFamily: F.body, fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: C.wineSoft, margin: "0 0 7px" },
  notaDivisor: { height: 1, background: `linear-gradient(90deg, transparent, ${C.rose}, transparent)`, margin: "18px 0 14px", opacity: 0.6 },
  notaProgress: { position: "absolute", bottom: 0, left: 0, right: 0, height: 3 },
  notaProgressBar: { height: "100%", background: C.gold, borderRadius: 2, width: "0%" },

  /* ---- Cuadernillo modal ---- */
  cuadernillo: { display: "flex", alignItems: "stretch", width: "calc(100% - 40px)", maxWidth: 400, maxHeight: "80vh", filter: "drop-shadow(0 12px 32px #3a161e44)", animation: "slideUp .22s ease" },
  cuadernilloEspiral: { display: "flex", flexDirection: "column", justifyContent: "space-evenly", alignItems: "center", background: "#c8bfaa", width: 26, borderRadius: "12px 0 0 12px", padding: "14px 0", flexShrink: 0 },
  cuadernilloAnillo: { width: 16, height: 16, borderRadius: "50%", border: "3px solid #8a7d68", background: "#e8e0d0" },
  cuadernilloHoja: { flex: 1, background: "#fdf6e3", borderRadius: "0 12px 12px 0", position: "relative", overflow: "hidden", minHeight: 320 },
  cuadernilloMargen: { position: "absolute", left: 42, top: 0, bottom: 0, width: 1, background: "#e8a0a055", zIndex: 1 },
  cuadernilloRenglones: { position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(transparent, transparent 27px, #c8d8e855 28px)", backgroundSize: "100% 28px", backgroundPosition: "0 48px", zIndex: 0 },
  cuadernilloContenido: { position: "relative", zIndex: 2, padding: "16px 18px 20px 50px", overflowY: "auto", maxHeight: "80vh" },
  cuadernilloTitulo: { fontFamily: F.serif, fontSize: 22, fontWeight: 700, color: "#5c3a1e", lineHeight: 1.2, flex: 1, marginRight: 6 },
  cuadernilloFecha: { fontSize: 11, color: "#b5966a", fontFamily: F.body, marginBottom: 14, marginTop: 2 },
  cuadernilloTexto: { fontFamily: F.body, fontSize: 15, color: "#5c3a1e", lineHeight: "28px", whiteSpace: "pre-wrap", margin: 0 },
};
