// =======================
// CONFIGURACIÓN PRINCIPAL
// =======================
const API_CONFIG = {
  metals: {
    xe: {
      username: "segundojoyeria273136564",
      key: "581ka5ir0d4q2r7mhcdbdfr69u",
      endpoint: "https://xecdapi.xe.com/v1/convert_from.json"
    },
    fallback: "https://api.metals.live/v1/spot"
  },
  coinGecko: "https://api.coingecko.com/api/v3",
  gnews: {
    key: "4847ac2227a0e462cf9b8a4594eb7008",
    endpoint: "https://gnews.io/api/v4/top-headlines"
  }
};

// =======================
// VARIABLES GLOBALES
// =======================
let historial = [];
let preciosAnteriores = {};
let chart;
let isLoading = false;
let refreshIntervals = [];

// =======================
// SISTEMA DE ALMACENAMIENTO SEGURO
// =======================
const safeLocalStorage = {
  get: (key) => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (error) {
      console.error(`Error al leer ${key} del localStorage:`, error);
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Error al guardar ${key} en localStorage:`, error);
      if (error.name === 'QuotaExceededError') {
        localStorage.clear();
        mostrarNotificacion("Se ha limpiado el almacenamiento local por falta de espacio", 'warning');
      }
    }
  }
};

// =======================
// FUNCIONES PRINCIPALES
// =======================

/**
 * Obtiene los precios actuales de metales preciosos
 */
async function obtenerPreciosMetales() {
  if (isLoading) return;
  setLoadingState(true);
  appMetrics.start('obtenerPreciosMetales');

  try {
    const [oroData, plataData] = await Promise.all([
      fetchWithRetry(`${API_CONFIG.metals.xe.endpoint}/?from=XAU&to=USD&amount=1`, {
        headers: {
          "Authorization": "Basic " + btoa(`${API_CONFIG.metals.xe.username}:${API_CONFIG.metals.xe.key}`)
        }
      }),
      fetchWithRetry(`${API_CONFIG.metals.xe.endpoint}/?from=XAG&to=USD&amount=1`, {
        headers: {
          "Authorization": "Basic " + btoa(`${API_CONFIG.metals.xe.username}:${API_CONFIG.metals.xe.key}`)
        }
      })
    ]);

    const { hora, fechaHora } = formatDateTime();
    let oroPorGramo, plataPorGramo;

    if (oroData?.to?.[0]?.mid && plataData?.to?.[0]?.mid) {
      oroPorGramo = oroData.to[0].mid / 31.1035;
      plataPorGramo = plataData.to[0].mid / 31.1035;
    } else {
      const fallbackData = await fetchWithRetry(API_CONFIG.metals.fallback);
      oroPorGramo = fallbackData.gold / 31.1035;
      plataPorGramo = fallbackData.silver / 31.1035;
    }

    const cambios = calcularCambios({ oro: oroPorGramo, plata: plataPorGramo });
    
    actualizarUI('oro', oroPorGramo, cambios.oro, hora);
    actualizarUI('plata', plataPorGramo, cambios.plata, hora);
    
    agregarAlHistorial({
      hora,
      fechaHora,
      oro: oroPorGramo.toFixed(2),
      plata: plataPorGramo.toFixed(2),
      bitcoin: document.getElementById('precio-bitcoin')?.textContent || '0'
    });
    
    actualizarGrafico();
    verificarAlertas({ oro: oroPorGramo, plata: plataPorGramo });

  } catch (error) {
    console.error("Error al obtener precios:", error);
    mostrarNotificacion("Error al cargar precios. Mostrando datos locales...", 'error');
    cargarDatosLocales();
  } finally {
    setLoadingState(false);
    appMetrics.end('obtenerPreciosMetales');
  }
}

/**
 * Obtiene el precio actual de Bitcoin
 */
async function obtenerPrecioBitcoin() {
  appMetrics.start('obtenerPrecioBitcoin');
  
  try {
    const data = await fetchWithRetry(
      `${API_CONFIG.coinGecko}/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true`
    );
    
    if (!data?.bitcoin?.usd) {
      throw new Error("Datos de Bitcoin no válidos");
    }
    
    const { hora, fechaHora } = formatDateTime();
    const precioBTC = data.bitcoin.usd;
    const cambioBTC = data.bitcoin.usd_24h_change;
    
    actualizarUI('bitcoin', precioBTC, cambioBTC, hora);
    
    if (historial.length > 0) {
      const ultimoRegistro = historial[0];
      if (ultimoRegistro.fechaHora === fechaHora) {
        ultimoRegistro.bitcoin = precioBTC.toFixed(2);
        safeLocalStorage.set('historial', historial);
      }
    }
    
    actualizarGrafico();
  } catch (error) {
    console.error("Error al obtener precio de Bitcoin:", error);
    mostrarNotificacion("Error al obtener precio de Bitcoin", 'error');
  } finally {
    appMetrics.end('obtenerPrecioBitcoin');
  }
}

/**
 * Obtiene noticias financieras
 */
async function obtenerNoticias(page = 1) {
  appMetrics.start('obtenerNoticias');
  
  const cached = newsCache.get(page);
  if (cached && (Date.now() - cached.timestamp < 1800000)) {
    renderNoticias(cached.data, page);
    appMetrics.end('obtenerNoticias');
    return;
  }

  try {
    const data = await fetchWithRetry(
      `${API_CONFIG.gnews.endpoint}?category=business&lang=es&token=${API_CONFIG.gnews.key}&page=${page}`
    );
    
    newsCache.set(page, data);
    renderNoticias(data, page);
    
  } catch (error) {
    console.error("Error al obtener noticias:", error);
    
    if (cached) {
      mostrarNotificacion("Mostrando noticias en caché", 'info');
      renderNoticias(cached.data, page);
    } else {
      mostrarNotificacion("Error al cargar noticias", 'error');
      const contenedor = document.getElementById('lista-noticias');
      if (contenedor) contenedor.innerHTML = '<p>No se pudieron cargar las noticias.</p>';
    }
  } finally {
    appMetrics.end('obtenerNoticias');
  }
}

// =======================
// FUNCIONES UTILITARIAS
// =======================

/**
 * Función para hacer peticiones HTTP con timeout y reintentos
 */
async function fetchWithRetry(url, options = {}, retries = 2, timeout = 8000) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      mode: 'cors'
    });
    
    clearTimeout(id);
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
    
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return await fetchWithRetry(url, options, retries - 1, timeout);
    }
    throw error;
  }
}

/**
 * Carga datos desde el almacenamiento local
 */
function cargarDatosLocales() {
  historial = safeLocalStorage.get('historial') || [];
  preciosAnteriores = safeLocalStorage.get('preciosAnteriores') || {};
  
  if (historial.length > 0) {
    const ultimo = historial[0];
    const hora = ultimo.hora || new Date().toLocaleTimeString();
    
    actualizarUI('oro', parseFloat(ultimo.oro), 0, hora);
    actualizarUI('plata', parseFloat(ultimo.plata), 0, hora);
    if (ultimo.bitcoin) {
      actualizarUI('bitcoin', parseFloat(ultimo.bitcoin), 0, hora);
    }
  } else {
    const hora = new Date().toLocaleTimeString();
    actualizarUI('oro', 62.35, 0, hora);
    actualizarUI('plata', 0.78, 0, hora);
    actualizarUI('bitcoin', 50000, 0, hora);
  }
}

/**
 * Formatea fecha y hora
 */
function formatDateTime(date = new Date()) {
  return {
    hora: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    fecha: date.toLocaleDateString(),
    fechaHora: date.toISOString(),
    timestamp: date.getTime()
  };
}

/**
 * Calcula los cambios porcentuales
 */
function calcularCambios(preciosActuales) {
  const cambios = { oro: 0, plata: 0 };
  
  if (preciosAnteriores.oro) {
    cambios.oro = ((preciosActuales.oro - preciosAnteriores.oro) / preciosAnteriores.oro) * 100;
  }
  
  if (preciosAnteriores.plata) {
    cambios.plata = ((preciosActuales.plata - preciosAnteriores.plata) / preciosAnteriores.plata) * 100;
  }
  
  preciosAnteriores = { ...preciosActuales };
  safeLocalStorage.set('preciosAnteriores', preciosAnteriores);
  
  return cambios;
}

/**
 * Actualiza la interfaz de usuario
 */
function actualizarUI(metal, precio, cambio, hora) {
  const precioElement = document.getElementById(`precio-${metal}`);
  const cambioElement = document.getElementById(`cambio-${metal}`);
  const horaElement = document.getElementById(`hora-${metal}`);
  
  if (precioElement) precioElement.textContent = precio.toFixed(metal === 'bitcoin' ? 0 : 2);
  if (horaElement) horaElement.textContent = hora;
  
  if (cambioElement && cambio !== undefined) {
    cambioElement.textContent = `${cambio >= 0 ? '+' : ''}${cambio.toFixed(2)}%`;
    cambioElement.className = `cambio ${cambio >= 0 ? 'positivo' : 'negativo'}`;
  }
}

/**
 * Agrega registro al historial
 */
function agregarAlHistorial(datos) {
  historial.unshift(datos);
  if (historial.length > 100) historial = historial.slice(0, 100);
  safeLocalStorage.set('historial', historial);
}

/**
 * Verifica alertas configuradas
 */
function verificarAlertas(precios) {
  const alertas = safeLocalStorage.get('alertas') || [];
  
  alertas.forEach(alerta => {
    const precioActual = precios[alerta.metal];
    if (precioActual !== undefined && 
        ((alerta.direccion === 'arriba' && precioActual >= alerta.precio) ||
         (alerta.direccion === 'abajo' && precioActual <= alerta.precio))) {
      mostrarNotificacion(`Alerta: ${alerta.metal} $${alerta.precio}`, 'alerta');
    }
  });
}

/**
 * Muestra notificaciones
 */
function mostrarNotificacion(mensaje, tipo = 'info') {
  if (!('Notification' in window) || !Notification.permission === 'granted') {
    // Mostrar notificación en la UI si no hay soporte para Notification API
    const notificacion = document.createElement('div');
    notificacion.className = `notificacion ${tipo}`;
    notificacion.textContent = mensaje;
    document.body.appendChild(notificacion);
    setTimeout(() => notificacion.remove(), 5000);
    return;
  }

  const opciones = {
    body: mensaje,
    icon: tipo === 'error' ? 'error.png' : 'info.png'
  };
  
  new Notification(tipo === 'error' ? 'Error' : 'Información', opciones);
}

/**
 * Inicializa el gráfico
 */
function inicializarGrafico() {
  const ctx = document.getElementById('precio-chart');
  if (!ctx) return;
  
  if (chart) chart.destroy();
  
  const datos = historial.slice(0, 20).reverse();
  const labels = datos.map(item => item.hora);
  
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Oro (USD/g)',
          data: datos.map(item => parseFloat(item.oro)),
          borderColor: 'rgba(255, 215, 0, 1)',
          backgroundColor: 'rgba(255, 215, 0, 0.1)',
          tension: 0.1
        },
        {
          label: 'Plata (USD/g)',
          data: datos.map(item => parseFloat(item.plata)),
          borderColor: 'rgba(192, 192, 192, 1)',
          backgroundColor: 'rgba(192, 192, 192, 0.1)',
          tension: 0.1
        },
        {
          label: 'Bitcoin (USD)',
          data: datos.map(item => parseFloat(item.bitcoin || 0)),
          borderColor: 'rgba(247, 147, 26, 1)',
          backgroundColor: 'rgba(247, 147, 26, 0.1)',
          tension: 0.1,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) label += ': ';
              label += context.parsed.y.toFixed(2);
              return label;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          title: { display: true, text: 'Oro/Plata (USD)' }
        },
        y1: {
          position: 'right',
          beginAtZero: false,
          grid: { drawOnChartArea: false },
          title: { display: true, text: 'Bitcoin (USD)' }
        }
      }
    }
  });
}

/**
 * Actualiza el gráfico
 */
function actualizarGrafico() {
  if (chart) inicializarGrafico();
}

/**
 * Maneja el estado de carga
 */
function setLoadingState(loading) {
  isLoading = loading;
  document.body.classList.toggle('loading', loading);
  const loader = document.getElementById('loader');
  if (loader) loader.style.display = loading ? 'flex' : 'none';
  
  const buttons = document.querySelectorAll('button:not(.load-more)');
  buttons.forEach(button => button.disabled = loading);
}

// =======================
// SISTEMA DE CACHÉ PARA NOTICIAS
// =======================
const newsCache = {
  get: (page) => safeLocalStorage.get('newsCache')?.[page] || null,
  set: (page, data) => {
    const cache = safeLocalStorage.get('newsCache') || {};
    cache[page] = { data, timestamp: Date.now() };
    safeLocalStorage.set('newsCache', cache);
  },
  clear: () => safeLocalStorage.set('newsCache', {})
};

/**
 * Renderiza noticias en la UI
 */
function renderNoticias(data, page) {
  const contenedor = document.getElementById('lista-noticias');
  if (!contenedor) return;

  if (page === 1) contenedor.innerHTML = '';

  if (data.articles?.length > 0) {
    data.articles.forEach(articulo => {
      if (!articulo.title) return;
      
      const fecha = new Date(articulo.publishedAt).toLocaleDateString();
      const imagen = articulo.image || 'https://via.placeholder.com/300x150?text=Noticia';
      
      const tarjeta = document.createElement('div');
      tarjeta.className = 'news-card';
      tarjeta.innerHTML = `
        <img src="${imagen}" alt="${articulo.title}" onerror="this.src='https://via.placeholder.com/300x150?text=Noticia'">
        <div class="news-content">
          <h3>${articulo.title}</h3>
          <p>${articulo.description || 'No hay descripción disponible.'}</p>
          <div class="news-footer">
            <span>${articulo.source?.name || 'Fuente desconocida'} • ${fecha}</span>
            <a href="${articulo.url}" target="_blank" rel="noopener noreferrer">
              Leer más <i class="fas fa-external-link-alt"></i>
            </a>
          </div>
        </div>
      `;
      contenedor.appendChild(tarjeta);
    });

    if (data.totalArticles > (page * 10)) {
      const existingButton = document.querySelector('.load-more');
      if (!existingButton) {
        const loadMore = document.createElement('button');
        loadMore.className = 'load-more';
        loadMore.textContent = 'Cargar más noticias';
        loadMore.onclick = () => obtenerNoticias(page + 1);
        contenedor.appendChild(loadMore);
      }
    }
  } else if (page === 1) {
    contenedor.innerHTML = '<p>No se encontraron noticias recientes.</p>';
  }
}

// =======================
// SISTEMA DE CONFIGURACIÓN
// =======================
const appConfig = {
  get: () => safeLocalStorage.get('appConfig') || {
    refreshInterval: 300000,
    theme: 'auto',
    notifications: true,
    alerts: []
  },
  set: (config) => safeLocalStorage.set('appConfig', config),
  apply: () => {
    const config = appConfig.get();
    
    // Aplicar tema
    if (config.theme === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', config.theme);
    }
    
    // Configurar intervalos
    limpiarIntervalos();
    refreshIntervals.push(
      setInterval(obtenerPreciosMetales, config.refreshInterval),
      setInterval(obtenerPrecioBitcoin, 60000),
      setInterval(obtenerNoticias, 1800000)
    );
    
    // Configurar alertas
    safeLocalStorage.set('alertas', config.alerts);
  }
};

// =======================
// SISTEMA DE MÉTRICAS
// =======================
const appMetrics = {
  startTimes: {},
  metrics: [],
  start: (name) => appMetrics.startTimes[name] = performance.now(),
  end: (name) => {
    const endTime = performance.now();
    const startTime = appMetrics.startTimes[name];
    if (startTime) {
      const duration = endTime - startTime;
      appMetrics.metrics.push({ name, duration, timestamp: Date.now() });
      console.log(`[Metrica] ${name}: ${duration.toFixed(2)}ms`);
      if (appMetrics.metrics.length > 100) appMetrics.metrics.shift();
    }
  }
};

// =======================
// FUNCIONES DE IMPORTACIÓN/EXPORTACIÓN
// =======================
function exportarDatos() {
  const data = {
    historial,
    config: appConfig.get(),
    timestamp: Date.now(),
    version: '1.0'
  };
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `metales-bitcoin-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importarDatos(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  try {
    const content = await file.text();
    const data = JSON.parse(content);
    
    if (!data.version) throw new Error("Formato de archivo no válido");
    
    if (data.historial) {
      safeLocalStorage.set('historial', data.historial);
      historial = data.historial;
    }
    
    if (data.config) {
      appConfig.set(data.config);
      appConfig.apply();
    }
    
    mostrarNotificacion("Datos importados correctamente", 'success');
    location.reload();
  } catch (error) {
    console.error("Error al importar datos:", error);
    mostrarNotificacion("Error al importar datos: " + error.message, 'error');
  }
}

// =======================
// INICIALIZACIÓN DE LA APLICACIÓN
// =======================
async function init() {
  // Cargar datos iniciales
  historial = safeLocalStorage.get('historial') || [];
  preciosAnteriores = safeLocalStorage.get('preciosAnteriores') || {};
  
  // Configurar listeners básicos
  document.querySelector('.theme-toggle')?.addEventListener('click', toggleTheme);
  document.getElementById('refresh-btn')?.addEventListener('click', refreshData);
  document.getElementById('export-btn')?.addEventListener('click', exportarDatos);
  document.getElementById('import-input')?.addEventListener('change', importarDatos);
  
  // Configurar notificaciones
  if ('Notification' in window && Notification.permission !== 'denied') {
    Notification.requestPermission();
  }
  
  // Aplicar configuración
  appConfig.apply();
  
  // Mostrar datos locales primero
  cargarDatosLocales();
  
  // Cargar datos actualizados
  try {
    setLoadingState(true);
    await Promise.all([
      obtenerPreciosMetales(),
      obtenerPrecioBitcoin(),
      obtenerNoticias()
    ]);
  } catch (error) {
    console.error("Error inicial:", error);
  } finally {
    setLoadingState(false);
  }
  
  // Inicializar gráfico
  inicializarGrafico();
}

/**
 * Cambia el tema claro/oscuro
 */
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  
  const config = appConfig.get();
  config.theme = newTheme;
  appConfig.set(config);
}

/**
 * Actualiza todos los datos
 */
function refreshData() {
  if (isLoading) return;
  obtenerPreciosMetales();
  obtenerPrecioBitcoin();
  obtenerNoticias();
  newsCache.clear();
}

/**
 * Limpia los intervalos de actualización
 */
function limpiarIntervalos() {
  refreshIntervals.forEach(interval => clearInterval(interval));
  refreshIntervals = [];
}

// Manejar recarga cuando se recupera la conexión
window.addEventListener('online', () => {
  mostrarNotificacion("Conexión recuperada. Actualizando datos...", 'info');
  refreshData();
});

// Iniciar la aplicación cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', init);