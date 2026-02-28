// --- TIMER AUTOMÁTICO PARA SUBASTA ---
const fs = require("fs");
const path = require('path');
const logger = require('./logger');
const db = require('./db_ext');
const RankingsCache = require('./rankings-cache');
const DataManager = require('./data-manager');
const bossAIIntegration = require('./boss-ai-integration'); // 🤖 Sistema de IA para Bosses

// --- INICIALIZAR GESTORES ---
const rankingsCache = new RankingsCache(5 * 60 * 1000); // 5 minutos TTL
const dataManager = new DataManager(__dirname);

// --- CARGAR CONFIGURACIÓN DESDE ARCHIVOS ---
const QUESTS = dataManager.loadJSON('config/quests.json', { QUESTS: [] }).QUESTS || [];
const FACCIONES = dataManager.loadJSON('config/factions.json', { FACCIONES: {} }).FACCIONES || {};
const DUNGEONS = dataManager.loadJSON('config/dungeons.json', { DUNGEONS: [] }).DUNGEONS || [];
const MONTURAS = dataManager.loadJSON('config/mounts.json', { MONTURAS: [] }).MONTURAS || [];
const LOGROS_DATA = dataManager.loadJSON('logros.json', { LOGROS: [] }).LOGROS || [];
const EVENTOS_DATA = dataManager.loadJSON('eventos.json', { EVENTOS: [], TORNEOS: [] }).EVENTOS || [];
const TORNEOS_DATA = dataManager.loadJSON('eventos.json', { EVENTOS: [], TORNEOS: [] }).TORNEOS || [];
let dungeonInstancias = dataManager.loadJSON('dungeons_instancias.json', { instancias: {} }).instancias || {};

// --- CONSTANTS ---
const INVENTORY_TYPES = {
  FRAGMENTOS: 'fragmentos',
  COFRES: 'cofres',
  LLAVES: 'llaves'
};

// --- INVENTORY MANAGER CLASS ---
class InventoryManager {
  constructor(usuarios) {
    this.usuarios = usuarios;
    logger.info('[InventoryManager] Inicializado');
  }

  /**
   * Obtiene el inventario de un usuario de forma segura
   * @param {string} userId - ID del usuario
   * @param {string} type - Tipo de inventario (fragmentos, cofres, llaves)
   * @returns {Object} Inventario del usuario
   */
  getInventory(userId, type = INVENTORY_TYPES.FRAGMENTOS) {
    try {
      if (!userId || typeof userId !== 'string') {
        logger.warn(`[InventoryManager] Usuario inválido: ${userId}`);
        return {};
      }
      if (!this.usuarios[userId]) {
        this.usuarios[userId] = { nombre: userId.split('@')[0] };
        logger.info(`[InventoryManager] Usuario creado: ${userId}`);
      }
      if (!this.usuarios[userId][type]) {
        this.usuarios[userId][type] = {};
      }
      return this.usuarios[userId][type];
    } catch (e) {
      logger.error(`[InventoryManager] Error al obtener inventario de ${userId}: ${e.message}`);
      return {};
    }
  }

  /**
   * Añade items al inventario de un usuario
   * @param {string} userId - ID del usuario
   * @param {string} itemId - ID del item
   * @param {number} cantidad - Cantidad a añadir
   * @param {string} type - Tipo de inventario
   * @returns {boolean} Éxito de la operación
   */
  addItem(userId, itemId, cantidad = 1, type = INVENTORY_TYPES.FRAGMENTOS) {
    try {
      if (cantidad <= 0) {
        logger.warn(`[InventoryManager] Cantidad inválida para ${userId}: ${cantidad}`);
        return false;
      }
      const inv = this.getInventory(userId, type);
      inv[itemId] = (inv[itemId] ?? 0) + cantidad;
      logger.info(`[InventoryManager] Item añadido - Usuario: ${userId}, Item: ${itemId}, Cantidad: ${cantidad}`);
      return true;
    } catch (e) {
      logger.error(`[InventoryManager] Error al añadir item a ${userId}: ${e.message}`);
      return false;
    }
  }

  /**
   * Elimina items del inventario de un usuario
   * @param {string} userId - ID del usuario
   * @param {string} itemId - ID del item
   * @param {number} cantidad - Cantidad a eliminar
   * @param {string} type - Tipo de inventario
   * @returns {boolean} Éxito de la operación
   */
  removeItem(userId, itemId, cantidad = 1, type = INVENTORY_TYPES.FRAGMENTOS) {
    try {
      const inv = this.getInventory(userId, type);
      const actual = inv[itemId] ?? 0;
      if (actual < cantidad) {
        logger.warn(`[InventoryManager] Inventario insuficiente - Usuario: ${userId}, Item: ${itemId}`);
        return false;
      }
      inv[itemId] = actual - cantidad;
      if (inv[itemId] === 0) delete inv[itemId];
      logger.info(`[InventoryManager] Item removido - Usuario: ${userId}, Item: ${itemId}, Cantidad: ${cantidad}`);
      return true;
    } catch (e) {
      logger.error(`[InventoryManager] Error al remover item de ${userId}: ${e.message}`);
      return false;
    }
  }

  /**
   * Obtiene la cantidad de un item en el inventario
   * @param {string} userId - ID del usuario
   * @param {string} itemId - ID del item
   * @param {string} type - Tipo de inventario
   * @returns {number} Cantidad del item
   */
  getItemCount(userId, itemId, type = INVENTORY_TYPES.FRAGMENTOS) {
    try {
      const inv = this.getInventory(userId, type);
      return inv[itemId] ?? 0;
    } catch (e) {
      logger.error(`[InventoryManager] Error al obtener cantidad de ${itemId} para ${userId}: ${e.message}`);
      return 0;
    }
  }

  /**
   * Obtiene la cantidad global de un item entre todos los usuarios
   * @param {string} itemId - ID del item
   * @param {string} type - Tipo de inventario
   * @returns {number} Cantidad global
   */
  getGlobalCount(itemId, type = INVENTORY_TYPES.FRAGMENTOS) {
    try {
      let total = 0;
      for (const uid in this.usuarios) {
        const inv = this.usuarios[uid][type] ?? {};
        total += inv[itemId] ?? 0;
      }
      return total;
    } catch (e) {
      logger.error(`[InventoryManager] Error al obtener cantidad global de ${itemId}: ${e.message}`);
      return 0;
    }
  }
}

// --- ACHIEVEMENTS/LOGROS SYSTEM ---
class AchievementsManager {
  constructor(usuarios) {
    this.usuarios = usuarios;
    this.logros = LOGROS_DATA;
    logger.info('[AchievementsManager] Inicializado con ' + this.logros.length + ' logros');
  }

  /**
   * Inicializa el sistema de logros para un usuario
   */
  initUser(userId) {
    if (!this.usuarios[userId].logros) {
      this.usuarios[userId].logros = {};
    }
  }

  /**
   * Verifica y desbloquea logros basados en progreso del usuario
   */
  checkAchievements(userId) {
    const user = this.usuarios[userId];
    if (!user) return [];

    this.initUser(userId);
    const desbloqueados = [];

    for (const logro of this.logros) {
      if (user.logros[logro.id]) continue; // Ya desbloqueado

      let condicionCumplida = false;
      switch (logro.tipo) {
        case 'duelos':
          condicionCumplida = (user.duelos_ganados ?? 0) >= logro.condicion;
          break;
        case 'bosses':
          condicionCumplida = (user.boss_kills ?? 0) >= logro.condicion;
          break;
        case 'dinero':
          condicionCumplida = (user.dinero ?? 0) >= logro.condicion;
          break;
        case 'nivel':
          condicionCumplida = (user.level ?? 1) >= logro.condicion;
          break;
      }

      if (condicionCumplida) {
        user.logros[logro.id] = {
          desbloqueado: true,
          fecha: new Date().toISOString(),
          recompensa: logro.recompensa
        };
        user.dinero = (user.dinero ?? 0) + logro.recompensa;
        desbloqueados.push(logro);
        logger.info(`[Logro Desbloqueado] ${userId} - ${logro.nombre}`);
      }
    }

    return desbloqueados;
  }

  /**
   * Obtiene todos los logros del usuario formateados
   */
  getUserAchievements(userId) {
    const user = this.usuarios[userId];
    if (!user) return [];

    this.initUser(userId);
    return this.logros.map(logro => ({
      ...logro,
      desbloqueado: !!user.logros[logro.id]
    }));
  }

  /**
   * Obtiene solo los logros desbloqueados
   */
  getUnlockedAchievements(userId) {
    const user = this.usuarios[userId];
    if (!user) return [];

    this.initUser(userId);
    const ids = Object.keys(user.logros || {});
    return this.logros.filter(l => ids.includes(l.id));
  }
}

// --- EVENTOS/TORNEOS SYSTEM ---
class EventosManager {
  constructor(usuarios) {
    this.usuarios = usuarios;
    this.eventos = EVENTOS_DATA;
    this.torneos = TORNEOS_DATA;
    logger.info('[EventosManager] Inicializado con ' + this.eventos.length + ' eventos y ' + this.torneos.length + ' torneos');
  }

  /**
   * Obtiene eventos activos
   */
  getEventosActivos() {
    return this.eventos.filter(e => e.estado === 'activo');
  }

  /**
   * Obtiene eventos próximos
   */
  getEventosProximos() {
    return this.eventos.filter(e => e.estado === 'proximo');
  }

  /**
   * Registra usuario en evento
   */
  registrarEnEvento(userId, eventoId) {
    const evento = this.eventos.find(e => e.id === eventoId);
    if (!evento) return { exito: false, mensaje: 'Evento no encontrado' };

    if (evento.estado !== 'activo') {
      return { exito: false, mensaje: 'Este evento no está activo' };
    }

    if (evento.participantes.includes(userId)) {
      return { exito: false, mensaje: 'Ya estás registrado en este evento' };
    }

    evento.participantes.push(userId);
    logger.info(`[Evento] ${userId} registrado en ${evento.nombre}`);
    return { exito: true, mensaje: `¡Te registraste en ${evento.nombre}!` };
  }

  /**
   * Obtiene torneos próximos
   */
  getTorneosProximos() {
    return this.torneos.filter(t => t.estado === 'proxima');
  }

  /**
   * Obtiene torneos activos
   */
  getTorneosActivos() {
    return this.torneos.filter(t => t.estado === 'activo');
  }

  /**
   * Registra usuario en torneo
   */
  registrarEnTorneo(userId, torneoId) {
    const torneo = this.torneos.find(t => t.id === torneoId);
    if (!torneo) return { exito: false, mensaje: 'Torneo no encontrado' };

    if (torneo.participantes.length >= torneo.maxParticipantes) {
      return { exito: false, mensaje: 'Torneo lleno' };
    }

    if (torneo.participantes.includes(userId)) {
      return { exito: false, mensaje: 'Ya estás registrado en este torneo' };
    }

    torneo.participantes.push(userId);
    logger.info(`[Torneo] ${userId} registrado en ${torneo.nombre}`);
    return { exito: true, mensaje: `¡Te registraste en ${torneo.nombre}!` };
  }

  /**
   * Obtiene información del evento con participantes
   */
  getEventoInfo(eventoId) {
    const evento = this.eventos.find(e => e.id === eventoId);
    if (!evento) return null;

    return {
      ...evento,
      participantesCount: evento.participantes.length,
      recompensaTotal: evento.recompensaBase * evento.multiplicador
    };
  }

  /**
   * Obtiene información del torneo
   */
  getTorneoInfo(torneoId) {
    const torneo = this.torneos.find(t => t.id === torneoId);
    if (!torneo) return null;

    return {
      ...torneo,
      vacantes: torneo.maxParticipantes - torneo.participantes.length
    };
  }
}

// --- DUNGEONS SYSTEM ---
class DungeonsManager {
  constructor(usuarios) {
    this.usuarios = usuarios;
    this.dungeons = DUNGEONS;
    this.instancias = dungeonInstancias;
    logger.info('[DungeonsManager] Inicializado con ' + this.dungeons.length + ' mazmorras');
  }

  /**
   * Crea una instancia de dungeon para un usuario
   */
  crearInstancia(userId, dungeonId) {
    const dungeon = this.dungeons.find(d => d.id === dungeonId);
    if (!dungeon) return { exito: false, mensaje: 'Mazmorra no encontrada' };

    const user = this.usuarios[userId];
    if (!user) return { exito: false, mensaje: 'Usuario no encontrado' };

    // Verificar cooldown
    if (user.dungeon_cooldown && Date.now() < user.dungeon_cooldown) {
      const tiempoRestante = Math.ceil((user.dungeon_cooldown - Date.now()) / 1000 / 60);
      return { exito: false, mensaje: `Espera ${tiempoRestante} minutos antes de entrar a otra mazmorra` };
    }

    const instanciaId = `${userId}_${dungeonId}_${Date.now()}`;
    const instancia = {
      id: instanciaId,
      userId,
      dungeonId,
      nivel: 1,
      vidaUsuario: 100,
      vidaMaxima: 100,
      dineroAcumulado: 0,
      enemigosDerotados: 0,
      estado: 'activa',
      fechaInicio: Date.now(),
      progreso: []
    };

    this.instancias[instanciaId] = instancia;
    logger.info(`[Dungeon] Instancia creada: ${instanciaId}`);

    return {
      exito: true,
      mensaje: `¡Entras a ${dungeon.nombre}!`,
      instancia
    };
  }

  /**
   * Combate un enemigo en la mazmorra
   */
  combatirEnemigo(instanciaId) {
    const instancia = this.instancias[instanciaId];
    if (!instancia) return { exito: false, mensaje: 'Instancia no encontrada' };

    const dungeon = this.dungeons.find(d => d.id === instancia.dungeonId);
    const user = this.usuarios[instancia.userId];

    // Calcular daño base 15 sin espada, multiplicado con espada
    let dañoUsuario = 15;
    try {
      if (user.equipo && user.equipo.weapon) {
        const item = getWeaponItem(user.equipo.weapon);
        if (item) {
          dañoUsuario = Math.floor(15 * getWeaponMultiplierByItem(item));
          // Variación ±20% solo con espada
          dañoUsuario = Math.floor(dañoUsuario * (0.8 + Math.random() * 0.4));
        }
      }
    } catch (e) {}
    
    const dañoEnemigo = Math.floor(50 * (0.7 + Math.random() * 0.3));

    instancia.vidaUsuario -= dañoEnemigo;
    instancia.dineroAcumulado += Math.floor(dungeon.recompensa / dungeon.niveles / 2);
    instancia.enemigosDerotados++;

    if (instancia.vidaUsuario <= 0) {
      instancia.estado = 'fracasada';
      user.dungeon_cooldown = Date.now() + 30 * 60 * 1000; // 30 minutos de cooldown
      logger.info(`[Dungeon] Fracaso: ${instancia.userId} en ${dungeon.nombre}`);

      return {
        exito: false,
        mensaje: '¡Fuiste derrotado!',
        dineroGanado: 0,
        instancia
      };
    }

    instancia.nivel++;

    if (instancia.nivel > dungeon.niveles) {
      instancia.estado = 'completada';
      const dineroFinal = instancia.dineroAcumulado + dungeon.recompensa;
      user.dinero = (user.dinero ?? 0) + dineroFinal;
      user.dungeon_cooldown = Date.now() + 10 * 60 * 1000; // 10 minutos de cooldown
      logger.info(`[Dungeon] Completada: ${instancia.userId} en ${dungeon.nombre} - Dinero: ${dineroFinal}`);

      return {
        exito: true,
        mensaje: `¡Completaste ${dungeon.nombre}!`,
        dineroGanado: dineroFinal,
        instancia
      };
    }

    return {
      exito: true,
      mensaje: `Derrotaste un enemigo. Nivel ${instancia.nivel}/${dungeon.niveles}`,
      dañoRecibido: dañoEnemigo,
      instancia
    };
  }

  /**
   * Obtiene información de la instancia actual
   */
  getInstanciaInfo(instanciaId) {
    return this.instancias[instanciaId] || null;
  }

  /**
   * Obtiene todas las mazmorras disponibles
   */
  getDungeonsDisponibles() {
    return this.dungeons.map(d => ({
      id: d.id,
      nombre: d.nombre,
      dificultad: d.dificultad,
      niveles: d.niveles,
      recompensa: d.recompensa
    }));
  }

  /**
   * Obtiene instancia activa del usuario
   */
  getInstanciaActiva(userId) {
    const instancia = Object.values(this.instancias).find(
      i => i.userId === userId && i.estado === 'activa'
    );
    return instancia || null;
  }

  /**
   * Abandona la mazmorra
   */
  abandonarMazmorra(instanciaId) {
    const instancia = this.instancias[instanciaId];
    if (!instancia) return { exito: false, mensaje: 'Instancia no encontrada' };

    if (instancia.estado !== 'activa') {
      return { exito: false, mensaje: 'Esta mazmorra no está activa' };
    }

    const user = this.usuarios[instancia.userId];
    instancia.estado = 'abandonada';
    user.dinero = (user.dinero ?? 0) + instancia.dineroAcumulado;

    logger.info(`[Dungeon] Abandonada: ${instancia.userId} - Dinero obtenido: ${instancia.dineroAcumulado}`);

    return {
      exito: true,
      mensaje: 'Abandonaste la mazmorra',
      dineroObtenido: instancia.dineroAcumulado
    };
  }
}

// Exportar utilidades públicas para tests y uso como módulo
try {
  module.exports = module.exports || {};
  module.exports.obtenerRangoClasificacion = obtenerRangoClasificacion;
} catch (e) {
  // en entornos donde module no existe, ignorar
}

let inventoryManager = null; // Se inicializará cuando tengamos usuarios

// Inicializar DB lo antes posible para poder usarla en bloques siguientes
try { 
  db.init('bot.sqlite');
  logger.info('[DB] Inicialización completada');
} catch (e) { 
  logger.error(`[DB] Error en inicialización temprana: ${e?.message || e}`);
}
// Cargar sorteos y retos desde DB si existen
try {
  if (db && typeof db.getAllRaffles === 'function') {
    const loaded = db.getAllRaffles();
    if (loaded && Object.keys(loaded).length > 0) {
      raffles = loaded;
      logger.info('[DB] Raffles cargados desde SQLite');
    }
  }
  if (db && typeof db.getAllRetos === 'function') {
    const loadedR = db.getAllRetos();
    if (loadedR && Object.keys(loadedR).length > 0) {
      for (const k of Object.keys(loadedR)) {
        try {
          const arr = loadedR[k].participants || [];
          retosDiarios[k] = { participants: new Set(Array.isArray(arr) ? arr : []) };
        } catch (e) { 
          logger.error(`[DB] Error cargando reto ${k}: ${e.message}`);
          retosDiarios[k] = { participants: new Set() }; 
        }
      }
      logger.info('[DB] Retos diarios cargados desde SQLite');
    }
  }
} catch (e) { 
  logger.error(`[DB] Error cargando raffles/retos: ${e?.message || e}`);
}
setInterval(() => {
  (async () => {
    if (subasta && subasta.abierta && Date.now() > subasta.fin) {
      subasta.abierta = false;
      let ganador = null;
      let max = -1;
      for (const p of subasta.pujas) {
        if (p.cantidad > max) { max = p.cantidad; ganador = p.usuarioId; }
      }
      if (ganador) {
        if (!usuarios[ganador]) usuarios[ganador] = { nombre: ganador.split('@')[0], fragmentos: {} };
        if (!usuarios[ganador].fragmentos) usuarios[ganador].fragmentos = {};
        if (!usuarios[ganador].fragmentos[subasta.fragmentoId]) usuarios[ganador].fragmentos[subasta.fragmentoId] = 0;
        usuarios[ganador].fragmentos[subasta.fragmentoId]++;
        guardarBD();
        await sock.sendMessage(subastaChatId, { text: `¡Subasta finalizada automáticamente! Ganador: @${ganador.split('@')[0]}\nFragmento entregado: ${getFragmentoById(subasta.fragmentoId).nombre}` , mentions: [ganador] }, { forceAllow: true });
      } else {
        await sock.sendMessage(subastaChatId, { text: 'Subasta finalizada automáticamente. No hubo pujas.' }, { forceAllow: true });
      }
      subasta = null;
    }
    // Recordatorio de tiempo restante cada 2 minutos
    if (subasta && subasta.abierta && subasta.fin - Date.now() < 10*60*1000 && (Math.floor((subasta.fin-Date.now())/60000)%2===0)) {
      await sock.sendMessage(subastaChatId, { text: `⏳ ¡Quedan ${(Math.round((subasta.fin-Date.now())/60000))} minutos para cerrar la subasta!` }, { forceAllow: true });
    }
  })();
}, 60000);
// Guardar el chatId de la subasta para avisos automáticos
let subastaChatId = null;
// --- SUBASTA ESPECIAL DE FRAGMENTOS PROHIBIDOS/ABSOLUTOS ---
let subasta = null; // { fragmentoId, rareza, pujas: [{usuarioId, cantidad}], abierta: bool, fin: timestamp }
// Almacenamiento rápido para features nuevos
let raffles = {}; // sorteos por chatId
let retosDiarios = {}; // retos diarios por chatId

// Helpers para persistencia de raffles/retos usando db_ext
function persistRaffles() {
  try {
    if (db && typeof db.saveAllRaffles === 'function') db.saveAllRaffles(raffles);
  } catch (e) { logger.warn('No se pudo persistir raffles: ' + (e.message || e)); }
}
function persistRetos() {
  try {
    // convertir Sets a arrays para guardar
    const serial = {};
    for (const k of Object.keys(retosDiarios)) {
      const p = retosDiarios[k].participants;
      serial[k] = { participants: Array.isArray(p) ? p : Array.from(p || []) };
    }
    if (db && typeof db.saveAllRetos === 'function') db.saveAllRetos(serial);
  } catch (e) { logger.warn('No se pudo persistir retosDiarios: ' + (e.message || e)); }
}

// --- FUNCIONES DE SUBASTA (Available for future integration) ---

/**
 * Inicia una subasta especial de fragmentos
 * @param {string} fragmentoId - ID del fragmento a subastar
 * @param {string} rareza - Rareza del fragmento
 * @param {number} duracionMin - Duración en minutos (default: 10)
 */
function iniciarSubastaEspecial(fragmentoId, rareza, duracionMin = 10) {
  subasta = {
    fragmentoId,
    rareza,
    pujas: [],
    abierta: true,
    fin: Date.now() + duracionMin * 60 * 1000
  };
}

/**
 * Registra una puja en la subasta actual
 * @param {string} usuarioId - ID del usuario que puja
 * @param {number} cantidad - Cantidad a pujar
 * @returns {boolean} Éxito de la operación
 */
function registrarPuja(usuarioId, cantidad) {
  if (!subasta || !subasta.abierta) return false;
  subasta.pujas.push({ usuarioId, cantidad });
  return true;
}

/**
 * Cierra la subasta actual y retorna el ganador
 * @returns {string|null} ID del usuario ganador o null
 */
function cerrarSubasta() {
  if (!subasta) return null;
  subasta.abierta = false;
  // Ganador: mayor cantidad
  let ganador = null;
  let max = -1;
  for (const p of subasta.pujas) {
    if (p.cantidad > max) { max = p.cantidad; ganador = p.usuarioId; }
  }
  return ganador;
}

/**
 * Anuncia la subasta activa en el chat
 * @param {Object} sock - Socket de WhatsApp
 * @param {string} chatId - ID del chat donde anunciar
 */
async function anunciarSubasta(sock, chatId) {
  if (!subasta) return;
  const f = getFragmentoById(subasta.fragmentoId);
  let txt = `¡SUBASTA ESPECIAL ABIERTA!\nFragmento: ${f.nombre} (${subasta.rareza})\n`;
  txt += `Para pujar usa: #pujar cantidad\nLa subasta termina en ${(Math.round((subasta.fin-Date.now())/60000))} minutos.`;
  await sock.sendMessage(chatId, { text: txt }, { forceAllow: true });
}

/**
 * Otorga recompensas de drop al usuario por derrotar un boss
 * @param {Object} user - Objeto del usuario
 * @param {string} tipo - Tipo de boss ('normal' o 'epico')
 */
function dropBossRewards(user, tipo) {
  try {
    if (!user) {
      logger.warn('[Rewards] Usuario nulo en dropBossRewards');
      return;
    }
    if (!user.mochila) user.mochila = { cofre_comun:0, cofre_raro:0, cofre_mitologico:0, llave_comun:0, llave_dorada:0, llave_mitologica:0 };
    if (!user.fragmentos) user.fragmentos = {};
    if (tipo === 'normal') {
      if (Math.random() < 0.7) user.mochila.cofre_comun += 1;
      if (Math.random() < 0.5) user.mochila.llave_comun += 1;
      if (Math.random() < 0.1) {
        const frag = fragmentosData.fragmentos.filter(f => ['raro', 'poco_comun'].includes(f.rareza));
        if (frag.length) {
          const f = frag[Math.floor(Math.random()*frag.length)];
          user.fragmentos[f.id] = (user.fragmentos[f.id]||0) + 1;
        }
      }
    }
    if (tipo === 'epico') {
      if (Math.random() < 0.5) user.mochila.cofre_raro += 1;
      if (Math.random() < 0.4) user.mochila.llave_dorada += 1;
      if (Math.random() < 0.2) {
        const frag = fragmentosData.fragmentos.filter(f => ['epico', 'legendario', 'mitico'].includes(f.rareza));
        if (frag.length) {
          const f = frag[Math.floor(Math.random()*frag.length)];
          user.fragmentos[f.id] = (user.fragmentos[f.id]||0) + 1;
        }
      }
    }
    guardarBD();
  } catch (e) {
    logger.error(`[Rewards] Error en dropBossRewards: ${e.message}`);
  }
}
// --- SISTEMA DE FRAGMENTOS, COFRES, LLAVES Y MOCHILA ---
const fragmentosPath = 'fragmentos.json';
const cofresLlavesPath = 'cofres_llaves.json';
let fragmentosData = { fragmentos: [] };
let cofresLlavesData = { cofres: [], llaves: [] };
if (fs.existsSync(fragmentosPath)) {
  try { 
    fragmentosData = JSON.parse(fs.readFileSync(fragmentosPath, 'utf8')); 
    logger.info(`[Fragmentos] Cargados ${fragmentosData.fragmentos?.length || 0} fragmentos`);
  } catch (e) { 
    logger.error(`[Fragmentos] Error cargando ${fragmentosPath}: ${e.message}`);
    fragmentosData = { fragmentos: [] }; 
  }
}
if (fs.existsSync(cofresLlavesPath)) {
  try { 
    cofresLlavesData = JSON.parse(fs.readFileSync(cofresLlavesPath, 'utf8')); 
    logger.info(`[Inventario] Cargados ${cofresLlavesData.cofres?.length || 0} cofres y ${cofresLlavesData.llaves?.length || 0} llaves`);
  } catch (e) { 
    logger.error(`[Inventario] Error cargando ${cofresLlavesPath}: ${e.message}`);
    cofresLlavesData = { cofres: [], llaves: [] }; 
  }
}
function getFragmentoById(id) { 
  try {
    return fragmentosData.fragmentos.find(f => f.id === id);
  } catch (e) {
    logger.error(`[Fragmentos] Error obteniendo fragmento ${id}: ${e.message}`);
    return null;
  }
}
// Funciones de utilidad para cofres y llaves (sin usar actualmente, pero disponibles)
function getCofreByTipo(tipo) { 
  try {
    if (!cofresLlavesData || !cofresLlavesData.cofres) return null;
    return cofresLlavesData.cofres.find(c => c.tipo === tipo);
  } catch (e) {
    logger.error(`[Cofres] Error obteniendo cofre ${tipo}: ${e.message}`);
    return null;
  }
}

function getLlaveById(id) { 
  try {
    if (!cofresLlavesData || !cofresLlavesData.llaves) return null;
    return cofresLlavesData.llaves.find(l => l.id === id);
  } catch (e) {
    logger.error(`[Llaves] Error obteniendo llave ${id}: ${e.message}`);
    return null;
  }
}
function rarezaToMult(rareza) {
  const tabla = { comun: 1, poco_comun: 2, raro: 4, epico: 8, legendario: 16, mitico: 32, ultra_mitico: 64, ancestral: 128, divino: 256, eterno: 512, primordial: 1024, prohibido: 2048, absoluto: 999999 };
  return tabla[rareza] || 1;
}
function getCantidadGlobal(id) {
  try {
    if (!inventoryManager) return 0;
    return inventoryManager.getGlobalCount(id, INVENTORY_TYPES.FRAGMENTOS);
  } catch (e) {
    logger.error(`[Fragmentos] Error al obtener cantidad global de ${id}: ${e.message}`);
    return 0;
  }
}
function precioFinal(fragmento) {
  try {
    if (!fragmento || !fragmento.id) {
      logger.warn('[Fragmentos] Fragmento inválido en precioFinal');
      return 0;
    }
    if (fragmento.rareza === 'absoluto') return 'No vendible';
    const base = fragmento.base ?? 0;
    const mult = rarezaToMult(fragmento.rareza);
    const global = getCantidadGlobal(fragmento.id) ?? 1;
    const precio = Math.round(base * mult * (1 / global));
    logger.debug(`[Fragmentos] Precio calculado para ${fragmento.id}: ${precio}`);
    return precio;
  } catch (e) {
    logger.error(`[Fragmentos] Error calculando precio: ${e.message}`);
    return 0;
  }
}
// --- SISTEMA ANTI-ABUSO INTELIGENTE (LORE) ---
const abusoPath = 'abuso_historial.json';
let abusoData = { historial: {} };
if (fs.existsSync(abusoPath)) {
  try { 
    abusoData = JSON.parse(fs.readFileSync(abusoPath, 'utf8')); 
    logger.info(`[Abuso] Cargado historial de abuso con ${Object.keys(abusoData.historial).length} usuarios`);
  } catch (e) { 
    logger.error(`[Abuso] Error cargando ${abusoPath}: ${e.message}`);
    abusoData = { historial: {} }; 
  }
}
function saveAbuso() {
  try { 
    fs.writeFileSync(abusoPath, JSON.stringify(abusoData, null, 2), 'utf8'); 
  } catch (e) { 
    logger.error(`[Abuso] No se pudo guardar abuso_historial.json: ${e.message}`); 
  }
}
function registrarAbuso(uid, tipo, detalle) {
  try {
    if (!abusoData.historial[uid]) abusoData.historial[uid] = [];
    abusoData.historial[uid].push({ fecha: new Date().toISOString(), tipo, detalle });
    saveAbuso();
    logger.info(`[Abuso] Registrado para ${uid}: ${tipo}`);
  } catch (e) {
    logger.error(`[Abuso] Error registrando abuso: ${e.message}`);
  }
}
function getAbuso(uid) {
  try {
    return abusoData.historial[uid] || [];
  } catch (e) {
    logger.error(`[Abuso] Error obteniendo historial de ${uid}: ${e.message}`);
    return [];
  }
}

// Hook: detectar abuso en comandos (flood, insultos, spam)
function detectarAbuso(msg, user, chatId) {
  // Registrar el conteo de posibles abusos sin mutear ni enviar mensajes automáticos
  try {
    if (!user) {
      logger.warn('[Abuso] Usuario nulo en detectarAbuso');
      return null;
    }
    user.abusoCount = (user.abusoCount ?? 0) + 1;
    const uid = user.id || chatId;
    if (user.abusoCount === 3) {
      registrarAbuso(uid, 'advertencia', 'Flood de comandos');
      logger.warn(`[Abuso] Advertencia para ${uid} (cuenta: ${user.abusoCount})`);
    } else if (user.abusoCount === 5) {
      registrarAbuso(uid, 'advertencia_publica', 'Flood de comandos');
      logger.warn(`[Abuso] Advertencia pública para ${uid} (cuenta: ${user.abusoCount})`);
    } else if (user.abusoCount === 7) {
      registrarAbuso(uid, 'mute_temporal', 'Flood de comandos');
      logger.warn(`[Abuso] Mute temporal para ${uid} (cuenta: ${user.abusoCount})`);
    } else if (user.abusoCount > 10) {
      registrarAbuso(uid, 'mute_extendido', 'Flood de comandos');
      logger.error(`[Abuso] Mute extendido para ${uid} (cuenta: ${user.abusoCount})`);
    }
  } catch (e) { 
    logger.error(`[Abuso] Error en detectarAbuso: ${e.message}`);
  }
  return null;
}

// --- SISTEMA ÁRBOL DE DECISIONES / DESTINO ---
const destinoPath = 'destino_eventos.json';
let destinoData = { eventos: [] };
try {
  const loadedDestinos = db.getAllDestinos();
  if (loadedDestinos && Object.keys(loadedDestinos).length > 0) {
    // stored as multiple rows; merge into single structure if needed
    // if data was stored with single id 'root' keep backwards compat
    if (loadedDestinos.root) destinoData = loadedDestinos.root;
    else {
      // reconstruct destinoData from rows
      destinoData = { eventos: [] };
      for (const v of Object.values(loadedDestinos)) {
        if (v && v.eventos) destinoData.eventos = destinoData.eventos.concat(v.eventos || []);
      }
    }
    logger.info(`[Destino] Cargados ${destinoData.eventos?.length || 0} eventos desde SQLite`);
  } else if (fs.existsSync(destinoPath)) {
    try { 
      destinoData = JSON.parse(fs.readFileSync(destinoPath, 'utf8')); 
      db.saveAllDestinos({ root: destinoData }); 
      logger.info(`[Destino] Migrado destino_eventos.json -> SQLite (${destinoData.eventos?.length || 0} eventos)`);
    } catch (e) { 
      logger.error(`[Destino] Error cargando ${destinoPath}: ${e.message}`);
      destinoData = { eventos: [] }; 
    }
  }
} catch (e) { 
  logger.error(`[Destino] Error accediendo a DB para destinos: ${e.message}`);
}

function saveDestino() {
  try {
    if (db && typeof db.saveAllDestinos === 'function') {
      db.saveAllDestinos({ root: destinoData });
      logger.debug('[Destino] Persistido en SQLite');
    } else {
      fs.writeFileSync(destinoPath, JSON.stringify(destinoData, null, 2), 'utf8');
      logger.debug('[Destino] Persistido en archivo JSON');
    }
  } catch (e) { 
    logger.error(`[Destino] Error guardando destino: ${e.message}`); 
  }
}
function crearEventoDestino(grupoId) {
  try {
    const id = 'destino_' + Math.random().toString(36).slice(2, 10);
    const inicio = Date.now();
    const fin = inicio + 15 * 60000; // 15 min para elegir
    const evento = { id, grupoId, inicio, fin, elecciones: {}, resultados: {} };
    destinoData.eventos = destinoData.eventos || [];
    destinoData.eventos.push(evento);
    saveDestino();
    logger.info(`[Destino] Evento creado: ${id} para grupo ${grupoId}`);
    return evento;
  } catch (e) {
    logger.error(`[Destino] Error creando evento: ${e.message}`);
    return null;
  }
}

function procesarEleccion(user, opcion) {
  let resultado = '';
  if (!user) {
    logger.warn('[Destino] Usuario nulo en procesarEleccion');
    return 'Usuario no válido.';
  }
  try {
    if (opcion === 'A') {
      user.poder = (user.poder ?? 0) + 250;
      resultado = '¡Has recibido poder!';
    } else if (opcion === 'B') {
      user.dinero = (user.dinero ?? 0) + 2000 + Math.floor(Math.random() * 1000);
      resultado = '¡Has recibido dinero!';
    } else if (opcion === 'C') {
      if (Math.random() < 0.5) {
        user.poder = (user.poder ?? 0) + 500;
        user.dinero = (user.dinero ?? 0) + 5000;
        resultado = '¡Riesgo y fortuna! Ganaste poder y dinero.';
      } else {
        resultado = 'El destino no te favoreció esta vez.';
      }
    } else {
      resultado = 'Opción inválida.';
    }
    guardarBD();
    logger.info(`[Destino] Elección procesada para usuario - opción: ${opcion}`);
  } catch (e) { 
    logger.error(`[Destino] Error procesando elección: ${e.message}`); 
    resultado = 'Error al procesar tu elección.';
  }
  return resultado;
}

    // --- COMANDOS DESTINO ---
    if (typeof body !== 'undefined' && typeof sock !== 'undefined' && typeof chatId !== 'undefined' && body === '#destino') {
      (async () => {
        let evento = getEventoActivo(chatId);
        if (!evento) evento = crearEventoDestino(chatId);
        const tiempoRestante = Math.max(0, Math.floor((evento.fin - Date.now())/60000));
        await sock.sendMessage(chatId, { text: '🔮 *EL DESTINO TE LLAMA*\n\nA) Poder ⚔️\nB) Dinero 💰\nC) Riesgo ☠️\n\nResponde: #elegir A | B | C\nTiempo: ' + tiempoRestante + ' min' }, { quoted: msg });
      })();
    }

    if (typeof body !== 'undefined' && typeof sock !== 'undefined' && typeof chatId !== 'undefined' && typeof senderId !== 'undefined' && body.startsWith('#elegir ')) {
      (async () => {
        const evento = getEventoActivo(chatId);
        if (!evento) {
          await sock.sendMessage(chatId, { text: '❌ No hay evento activo.' }, { quoted: msg });
          return;
        }
        const opcion = body.split(' ')[1]?.toUpperCase();
        if (!['A','B','C'].includes(opcion)) {
          await sock.sendMessage(chatId, { text: '❌ Opción inválida. A, B o C.' }, { quoted: msg });
          return;
        }
        if (evento.elecciones[senderId]) {
          await sock.sendMessage(chatId, { text: '❌ Ya completaste tu elección.' }, { quoted: msg });
          return;
        }
        evento.elecciones[senderId] = opcion;
        const resultado = procesarEleccion(user, opcion);
        evento.resultados[senderId] = resultado;
        saveDestino();
        await sock.sendMessage(chatId, { text: `✅ *${opcion}* seleccionado\n\n${resultado}` }, { quoted: msg });
      })();
    }
// --- SISTEMA DE TÍTULOS VISIBLES ---
const titulosPath = 'titulos.json';
let titulosData = { titulos: [] };
try {
  const loaded = db.getAllTitulos();
  if (loaded && Object.keys(loaded).length > 0) {
    if (loaded.root) titulosData = loaded.root;
    else {
      titulosData = { titulos: [] };
      for (const v of Object.values(loaded)) if (v && v.titulos) titulosData.titulos = titulosData.titulos.concat(v.titulos || []);
    }
    logger.info('[db] titulos cargados desde SQLite');
  } else if (fs.existsSync(titulosPath)) {
    try { titulosData = JSON.parse(fs.readFileSync(titulosPath)); db.saveAllTitulos({ root: titulosData }); logger.info('[db] migrado titulos.json -> SQLite'); } catch (e) { titulosData = { titulos: [] }; logger.warn('Error cargando titulos.json: ' + (e.message || e)); }
  }
} catch (e) { logger.warn('Error accediendo a DB para titulos: ' + (e.message || e)); }

/**
 * Guarda datos de títulos en persistencia
 */
function saveTitulos() {
  try {
    if (db && typeof db.saveAllTitulos === 'function') db.saveAllTitulos({ root: titulosData });
    else fs.writeFileSync(titulosPath, JSON.stringify(titulosData, null, 2));
  } catch (e) { logger.error('No se pudo guardar titulos: ' + (e.message || e)); }
}
function getTituloById(id) {
  return titulosData.titulos.find(t => t.id === id);
}

// Helper: obtener weapon item desde la tienda
function getWeaponItem(itemId) {
  const it = buscarItem(itemId);
  return (it && it.categoria === 'armas') ? it : null;
}

function getWeaponMultiplierByItem(item) {
  if (!item) return 1;
  const raw = (item.rareza || item.rarity || 'comun').toString();
  // normalizar: eliminar tildes y pasar a minúsculas
  const normalize = s => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const rnorm = normalize(raw);
  // alias para diferentes formas de escritura
  const alias = {
    'comun': 'comun', 'común': 'comun',
    'especial': 'especial',
    'raro': 'raro',
    'epica': 'epico', 'epica ': 'epico', 'epico': 'epico',
    'legendaria': 'legendario', 'legendario': 'legendario',
    'mitica': 'mitico', 'mitico': 'mitico',
    'ultra mitica': 'ultra', 'ultra mitico': 'ultra', 'ultra': 'ultra',
    'hecha por dioses': 'dioses', 'dioses': 'dioses'
  };
  const canonical = alias[rnorm] || rnorm;
  const multipliers = {
    'comun': 1.1,
    'especial': 2.0,
    'raro': 2.0,
    'epico': 3.5,
    'legendario': 5.0,
    'mitico': 7.0,
    'ultra': 9.0,
    'dioses': 12.0
  };
  return multipliers[canonical] || 1;
}

// --- SISTEMA DE BOSSES MUNDIALES POR GRUPO ---
const bossesPath = 'bosses.json';
let bossesData = { bosses: [], spawnHistory: {} };
try {
  const loaded = db.getAllBosses();
  if (loaded && Object.keys(loaded).length > 0) {
    if (loaded.root) bossesData = loaded.root;
    else {
      bossesData = { bosses: [], spawnHistory: {} };
      for (const v of Object.values(loaded)) {
        if (v && v.bosses) bossesData.bosses = bossesData.bosses.concat(v.bosses || []);
        if (v && v.spawnHistory) bossesData.spawnHistory = Object.assign(bossesData.spawnHistory, v.spawnHistory || {});
      }
    }
    logger.info('[db] bosses cargados desde SQLite');
  } else if (fs.existsSync(bossesPath)) {
    try { bossesData = JSON.parse(fs.readFileSync(bossesPath)); db.saveAllBosses({ root: bossesData }); logger.info('[db] migrado bosses.json -> SQLite'); } catch (e) { bossesData = { bosses: [], spawnHistory: {} }; logger.warn('Error cargando bosses.json: ' + (e.message || e)); }
  }
} catch (e) { logger.warn('Error accediendo a DB para bosses: ' + (e.message || e)); }

function saveBosses() {
  try {
    if (db && typeof db.saveAllBosses === 'function') db.saveAllBosses({ root: bossesData });
    else fs.writeFileSync(bossesPath, JSON.stringify(bossesData, null, 2));
  } catch (e) { logger.error('No se pudo guardar bosses: ' + (e.message || e)); }
}

function getActiveBossByGroup(grupoId) {
  return bossesData.bosses.find(b => b.grupoId === grupoId && b.vidaActual > 0 && b.activo);
}


function createBossForGroup(grupoId, opts = {}) {
  const id = 'boss_' + Math.random().toString(36).slice(2,10);
  const vidaMax = opts.vidaMax || 1000000;
  const durMin = opts.duracionMin || 60; // duración por defecto 60 min
  const boss = {
    bossId: id,
    nombre: opts.nombre || 'Coloso Mundial',
    vidaMax,
    vidaActual: vidaMax,
    grupoId,
    inicio: Date.now(),
    fin: Date.now() + durMin*60*1000,
    rankingDaño: {},
    activo: true,
    lootPool: opts.lootPool || []
  };
  bossesData.bosses.push(boss);
  bossesData.spawnHistory[grupoId] = Date.now();
  saveBosses();
  return boss;
}

function registerDamageToBoss(boss, userId, amount, sock = null, chatId = null) {
  if (!boss || !boss.activo) return null;
  
  // 🤖 Procesar daño con IA inteligente del boss
  const resultado = bossAIIntegration.procesarDañoConIA(boss, userId, amount);
  
  if (!resultado.aplicado) return null;

  // 📊 Enviar reporte del daño
  if (sock && chatId) {
    sock.sendMessage(chatId, { text: resultado.reporte }).catch(() => {});
  }

  // 🔴 Mostrar descripción de la acción del boss
  if (sock && chatId) {
    const accionBoss = bossAIIntegration.obtenerDescripcionAccionBoss(boss);
    sock.sendMessage(chatId, { text: accionBoss }).catch(() => {});
  }

  // 📈 Si salud está baja, mostrar análisis
  if (resultado.estadoBoss.porcentajeSalud < 50 && sock && chatId) {
    const analisis = bossAIIntegration.obtenerAnalisisIA(boss);
    sock.sendMessage(chatId, { text: analisis }).catch(() => {});
  }

  // 💀 Si el boss muere
  if (!resultado.bossActivo && boss.vidaActual <= 0) {
    boss.activo = false;
    boss.muerteTs = Date.now();
    distributeBossLoot(boss, sock, chatId);
    
    // 🎉 Reporte final
    if (sock && chatId) {
      const reporteFinal = bossAIIntegration.generarReporteFinal(boss);
      sock.sendMessage(chatId, { text: reporteFinal }).catch(() => {});
      sock.sendMessage(chatId, { text: `🎉 ¡¡${boss.nombre} ha sido derrotado!!\n\n👑 Recompensas entregadas a los top 3 participantes.` }).catch(() => {});
    }
  }

  saveBosses();
  return resultado.daño;
}

function distributeBossLoot(boss, sock = null, chatId = null) {
  try {
    // Calcular puntos base según dificultad (solo para bosses personales)
    const dificultadMultipliers = {
      // recompensas base más moderadas; escalan con la dificultad
      'facil': { puntos: 20, dineroMult: 0.5 },
      'medio': { puntos: 50, dineroMult: 1.0 },
      'dificil': { puntos: 100, dineroMult: 1.5 },
      'imposible': { puntos: 200, dineroMult: 2.5 },
      'importal': { puntos: 400, dineroMult: 4.0 }
    };
    
    const dificConfig = boss.dificultad ? dificultadMultipliers[boss.dificultad.toLowerCase()] : dificultadMultipliers['facil'];
    const puntosBase = dificConfig.puntos;
    const dineroMult = dificConfig.dineroMult;

    // calcular ranking ordenado
    const entries = Object.entries(boss.rankingDaño).sort((a,b) => b[1]-a[1]);
    
    // Guardar rangos anteriores para detectar subidas
    const prevRangos = {};
    for (const [uid] of entries) {
      const user = usuarios[uid];
      if (user) {
        const prev = obtenerRangoClasificacion(user.poder);
        prevRangos[uid] = prev;
      }
    }
    
    // top3 rewards
    for (let i=0;i<Math.min(3, entries.length); i++) {
      const uid = entries[i][0];
      const user = usuarios[uid];
      if (!user) continue;
      
      // Recompensa en dinero (mayor para dificultades altas)
      // fórmula generosa de Preset B: baseFactor = 0.003
      const dinero = Math.floor(boss.vidaMax * (0.003 * (3 - i)) * dineroMult);
      user.dinero = (user.dinero||0) + dinero;
      
      // Puntos de temporada basados en dificultad y posición
      let puntos = puntosBase;
      if (i === 0) puntos = Math.floor(puntosBase * 1.0); // 1er lugar = puntos completos
      else if (i === 1) puntos = Math.floor(puntosBase * 0.6); // 2do lugar = 60%
      else if (i === 2) puntos = Math.floor(puntosBase * 0.3); // 3er lugar = 30%
      
      // Agregar puntos a la temporada
      if (currentSeason) {
        seasonAddPointsAndRegister(uid, puntos);
      }
      
      // añadir cofre raro/mitologico según posición
      if (!user.mochila) user.mochila = { cofre_comun:0, cofre_raro:0, cofre_mitologico:0, llave_comun:0, llave_dorada:0, llave_mitologica:0 };
      if (i === 0) {
        user.mochila.cofre_mitologico = (user.mochila.cofre_mitologico||0) + 1;
        // otorgar título boss_winner si no lo tiene
        if (!user.titulosUnlocked) user.titulosUnlocked = [];
        if (!user.titulosUnlocked.includes('boss_winner')) user.titulosUnlocked.push('boss_winner');
        // primer lugar recibe arma aleatoria
        const armas = (TIENDA_ITEMS.armas || []);
        if (armas.length > 0) {
          const armaIndex = Math.floor(Math.random() * armas.length);
          const armaItem = armas[armaIndex];
          const armaId = armaItem.id || armaItem.itemId || armaItem.key || 'espada_comun_1';
          if (!user.inventario) user.inventario = {};
          user.inventario[armaId] = (user.inventario[armaId]||0) + 1;
        }
      } else if (i === 1) {
        user.mochila.cofre_raro = (user.mochila.cofre_raro||0) + 1;
      } else {
        user.mochila.cofre_comun = (user.mochila.cofre_comun||0) + 1;
      }
      
      // dar experiencia (más para dificultades altas)
      const expBase = Math.floor(boss.vidaMax * 0.0005);
      const expMultiplier = boss.dificultad ? (dificultadMultipliers[boss.dificultad.toLowerCase()]?.dineroMult || 1.0) : 1.0;
      addExp(user, Math.floor(expBase * expMultiplier));
      
      // Detectar cambio de rango/clase
      const newRango = obtenerRangoClasificacion(user.poder);
      const prevRango = prevRangos[uid];
      
      if (prevRango && (prevRango.rango !== newRango.rango || prevRango.clasificacion !== newRango.clasificacion)) {
        if (sock && chatId) {
          const mensaje = `🚀 *ASCENSO DE CLASE*\n\n🌟 ${user.nombre}\n${prevRango.rango} ${prevRango.clasificacion} → ${newRango.rango} ${newRango.clasificacion}\n\n💪 ¡Sigue adelante!`;
          sock.sendMessage(chatId, { text: mensaje }).catch(() => {});
        }
      }
      
      // mostrar recompensas detalladas
      if (sock && chatId) {
        const posicionTexto = ['🥇 PRIMER LUGAR', '🥈 SEGUNDO LUGAR', '🥉 TERCER LUGAR'][i] || 'Participante';
        const expRecompensa = Math.floor(expBase * expMultiplier);
        let recompensaMsg = `${posicionTexto}\n\n${user.nombre}\n💰 $${dinero.toLocaleString()}  |  📊 ${puntos} pts  |  📚 +${expRecompensa} exp`;
        if (i === 0) {
          recompensaMsg += `🎁 Cofre Mitológico: +1\n`;
          const armas = (TIENDA_ITEMS.armas || []);
          if (armas.length > 0) {
            const armaItem = armas[Math.floor(Math.random() * armas.length)];
            recompensaMsg += `⚔️ ${armaItem.nombre} (rareza: ${armaItem.rareza})\n`;
          }
        } else if (i === 1) {
          recompensaMsg += `🎁 Cofre Raro: +1\n`;
        } else {
          recompensaMsg += `🎁 Cofre Común: +1\n`;
        }
        sock.sendMessage(chatId, { text: recompensaMsg }).catch(() => {});
      }
      
      // actualizar misión de derrotar bosses
      if (updateMissionProgress(user, 'derrota_bosses', 1)) {
        const mission = DAILY_MISSIONS['derrota_bosses'];
        const dineroBonus = getStreakDineroBonus(user.streakDays);
        const expBonus = getStreakExpBonus(user.streakDays);
        const missionDinero = Math.floor(mission.reward.dinero + dineroBonus);
        const missionExp = Math.floor(mission.reward.exp + expBonus);
        const missionPuntos = Math.floor(mission.reward.puntos + (mission.reward.puntos * user.streakDays * 0.1));
        sock.sendMessage(chatId, { text: `✅ ¡Misión completada! ${mission.nombre}\n💰 +$${missionDinero} | 📚 +${missionExp} exp${user.streakDays > 0 ? ` | 🔥 Día ${user.streakDays}` : ''}` }).catch(() => {});
        user.dinero = (user.dinero || 0) + missionDinero;
        addExp(user, missionExp);
        if (currentSeason) seasonAddPointsAndRegister(uid, missionPuntos);
      }
      
      // registrar que este usuario participó en la derrota (para cooldowns personales)
      try { user.lastBossKill = Date.now(); } catch (e) { /* ignore */ }
    }
    saveBosses();
    guardarBD();
  } catch (e) { logger.warn('Error distribuyendo loot boss:', e.message); }
}

// spawn scheduler básico: intentar crear bosses para grupos listados en config cada X minutos
const bossSpawnConfigPath = 'boss_spawn_groups.json';
let bossSpawnConfig = { groups: [], cooldownHours: 6 };
if (fs.existsSync(bossSpawnConfigPath)) {
  try { bossSpawnConfig = JSON.parse(fs.readFileSync(bossSpawnConfigPath)); } catch (e) { bossSpawnConfig = { groups: [], cooldownHours: 6 }; }
}
setInterval(() => {
  try {
    const cooldownMs = (bossSpawnConfig.cooldownHours||6) * 3600 * 1000;
    for (const gid of bossSpawnConfig.groups || []) {
      const active = getActiveBossByGroup(gid);
      const last = bossesData.spawnHistory && bossesData.spawnHistory[gid];
      if (!active && (!last || Date.now() - last > cooldownMs)) {
        createBossForGroup(gid, { vidaMax: 1000000, duracionMin: 60, nombre: 'Jefe Mundial' });
      }
    }
  } catch (e) { /* ignore scheduler errors */ }
}, 60*1000);


const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadContentFromMessage } = require("@whiskeysockets/baileys");
// Marca de tiempo de arranque del bot
const botStartTime = Date.now();
// Mapa para evitar procesar el mismo mensaje varias veces (deduplicación)
const processedMessageIds = new Map();
// Limpiar entradas antiguas cada 10 minutos
setInterval(() => {
  const cutoff = Date.now() - (60 * 60 * 1000); // 1 hora
  for (const [k, v] of processedMessageIds) {
    if (v < cutoff) processedMessageIds.delete(k);
  }
}, 10 * 60 * 1000);

const express = require('express');

let ffmpeg = null;
let ffmpegPath = null;
try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegPath = require('ffmpeg-static');
} catch (err) {
  logger.warn('Aviso: fluent-ffmpeg o ffmpeg-static no están instalados. Funcionalidad de video/GIF deshabilitada.');
}

let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  logger.warn('Aviso: sharp no está instalado. Procesamiento de imágenes deshabilitado.');
}

let qrcode = null;
try { qrcode = require('qrcode-terminal'); } catch (e) { /* opcional */ }

let qrcodeImageLib = null;
try { qrcodeImageLib = require('qrcode'); } catch (e) { logger.warn('Aviso: paquete "qrcode" no instalado, no se podrán generar imágenes PNG del QR.'); }

if (ffmpeg && ffmpegPath) {
  try { ffmpeg.setFfmpegPath(ffmpegPath); } catch (e) { logger.warn('No se pudo configurar ffmpeg path:', e.message); }
}

async function downloadMediaMessage(msg) {
  if (!downloadContentFromMessage) throw new Error('downloadContentFromMessage no disponible en esta versión de baileys');
  const message = msg.message ? msg.message : msg;
  let type = null;
  if (message.imageMessage) type = 'image';
  else if (message.videoMessage) type = 'video';
  else if (message.documentMessage) type = 'document';
  else if (message.audioMessage) type = 'audio';
  if (!type) throw new Error('Tipo de media no soportado para descarga');
  const stream = await downloadContentFromMessage(message, type);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return buffer;
}

// Inicializar DB y cargar usuarios (migrando desde JSON si hace falta)
let loaded = db.getAllUsers();
let usuarios = {};
if (loaded && Object.keys(loaded).length > 0) {
  usuarios = loaded;
  logger.info(`[Usuarios] Cargados ${Object.keys(usuarios).length} usuarios desde SQLite`);
} else {
  const usuariosPath = "usuarios.json";
  if (fs.existsSync(usuariosPath)) {
    try {
      usuarios = JSON.parse(fs.readFileSync(usuariosPath, 'utf8'));
      logger.info(`[Usuarios] Cargando ${Object.keys(usuarios).length} usuarios desde usuarios.json y migrando a SQLite`);
      db.migrateFromJson(usuariosPath);
    } catch (e) {
      logger.error(`[Usuarios] Error cargando usuarios.json: ${e.message}`);
      usuarios = {};
    }
  } else {
    logger.info('[Usuarios] No se encontró usuarios.json, iniciando con objeto vacío');
  }
  // Mantener watcher sobre el JSON para desarrollos locales (opcional)
  try {
    if (fs.existsSync(usuariosPath)) {
      fs.watchFile(usuariosPath, { interval: 1000 }, (_curr, _prev) => {
        try {
          if (!fs.existsSync(usuariosPath)) return;
          const data = JSON.parse(fs.readFileSync(usuariosPath, 'utf8'));
          usuarios = data;
          if (inventoryManager) inventoryManager.usuarios = usuarios;
          logger.info(`[Usuarios] usuarios.json recargado (${Object.keys(usuarios).length} usuarios)`);
        } catch (e) {
          logger.error(`[Usuarios] Error recargando usuarios.json: ${e.message}`);
        }
      });
    }
  } catch (e) {
    logger.warn(`[Usuarios] No se pudo iniciar watcher de usuarios.json: ${e.message}`);
  }
}

// Inicializar InventoryManager
inventoryManager = new InventoryManager(usuarios);
logger.info('[InventoryManager] Sistema de inventario inicializado');

// Inicializar AchievementsManager
achievementsManager = new AchievementsManager(usuarios);
logger.info('[AchievementsManager] Sistema de logros inicializado');

// Inicializar EventosManager
eventosManager = new EventosManager(usuarios);
logger.info('[EventosManager] Sistema de eventos y torneos inicializado');

// Inicializar DungeonsManager
dungeonsManager = new DungeonsManager(usuarios);
logger.info('[DungeonsManager] Sistema de mazmorras inicializado');

// Function para guardar usuarios en BD
function guardarBD() {
  try {
    if (db && typeof db.saveAllUsers === 'function') {
      db.saveAllUsers(usuarios);
      logger.debug('[BD] Usuarios guardados en SQLite');
    }
  } catch (e) {
    logger.error(`[BD] Error guardando usuarios: ${e.message}`);
  }
}

// ------------------ SISTEMA SOCIAL: Memoria, Identidad, Historial Negro, Alertas ------------------
let socialGroupStats = {}; // por chat: { msgs: [timestamps], lastAlert: 0 }

// Config social persistente
const socialConfigPath = 'socialConfig.json';
let socialConfig = {
  badWords: ['puta','idiota','imbecil','tonto','estupido','estúpido','mierda','shut','fuck'],
  alertThreshold: 30, // mensajes en ventana
  alertWindowMs: 60000, // ventana en ms
  historialVisibility: 'public' // opciones: 'public'|'admins'|'owner'
};
function loadSocialConfig() {
  try {
    if (fs.existsSync(socialConfigPath)) {
      const data = JSON.parse(fs.readFileSync(socialConfigPath));
      socialConfig = Object.assign(socialConfig, data || {});
    }
  } catch (e) { logger.warn('No se pudo cargar socialConfig:', e.message); }
}
function saveSocialConfig() {
  try { fs.writeFileSync(socialConfigPath, JSON.stringify(socialConfig, null, 2)); } catch (e) { logger.warn('No se pudo guardar socialConfig:', e.message); }
}
loadSocialConfig();

// alias local para compatibilidad con código previo
let SOCIAL_BAD_WORDS = socialConfig.badWords;

function generateSoulCode() {
  // Genera un código tipo A7X-92Q-LUC garantizando unicidad
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function block(len){ let s=''; for(let i=0;i<len;i++) s += alpha[Math.floor(Math.random()*alpha.length)]; return s; }
  for (let i=0;i<50;i++) {
    const code = `${block(3)}-${block(3)}-${block(3)}`;
    // verificar unicidad
    let ok = true;
    for (const k of Object.keys(usuarios||{})) { if (usuarios[k] && usuarios[k].identidad === code) { ok = false; break; } }
    if (ok) return code;
  }
  // fallback con timestamp
  return 'ID-' + Date.now().toString(36).toUpperCase().slice(-9);
}

function ensureSocialFields(uid) {
  if (!uid) return;
  if (!usuarios[uid]) usuarios[uid] = usuarios[uid] || {};
  const u = usuarios[uid];
  if (!u.hasOwnProperty?.call(u, 'identidad') || !u.identidad) u.identidad = generateSoulCode();
  if (!u.historialNegro) u.historialNegro = [];
  if (!u.memoria) u.memoria = { mensajes: 0, audios: 0, silencios: 0, conflictos: 0, lastMessageTs: 0 };
  if (!Object.prototype.hasOwnProperty.call(u, 'status')) u.status = null;
  if (!u.cooldowns) u.cooldowns = {};
  if (!u.badges) u.badges = u.badges || [];
}

function addHistorialNegro(uid, accion, motivo) {
  try {
    if (!uid) return;
    ensureSocialFields(uid);
    usuarios[uid].historialNegro.push({ fecha: new Date().toISOString().slice(0,10), accion: accion || 'Acción', motivo: motivo || null });
    guardarBD();
  } catch (e) { logger.warn('addHistorialNegro error:', e.message); }
}

function recordMessageBehavior(msg, chatId, senderId) {
  try {
    if (!senderId) return;
    ensureSocialFields(senderId);
    const u = usuarios[senderId];
    const now = Date.now();
    u.memoria.mensajes = (u.memoria.mensajes || 0) + 1;
    u.memoria.lastMessageTs = now;
    // audios
    if (msg.message && msg.message.audioMessage) u.memoria.audios = (u.memoria.audios||0) + 1;
    // detectar insultos simples por palabra
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
    const lowered = (text || '').toLowerCase();
    for (const w of SOCIAL_BAD_WORDS) {
      if (!w) continue;
      if (lowered.includes(w)) {
        u.memoria.conflictos = (u.memoria.conflictos||0) + 1;
        addHistorialNegro(senderId,'Insulto detectado', `Palabra: ${w}`);
        break;
      }
    }
    guardarBD();

    // estadística por grupo para detectar caos (sin enviar alertas molestas)
    if (chatId && chatId.endsWith('@g.us')) {
      if (!socialGroupStats[chatId]) socialGroupStats[chatId] = { msgs: [], lastAlert: 0 };
      socialGroupStats[chatId].msgs.push(now);
      // depurar mensajes antiguos (ventana 60s)
      socialGroupStats[chatId].msgs = socialGroupStats[chatId].msgs.filter(ts => ts > now - (socialConfig.alertWindowMs||60000));
      // solo contar estadísticas, no enviar alertas
    }
  } catch (e) { logger.warn('recordMessageBehavior error:', e.message); }
}

function psychCooldownCheck(uid, key, durationMs) {
  try {
    if (!uid || !key) return true;
    ensureSocialFields(uid);
    const u = usuarios[uid];
    u.cooldowns = u.cooldowns || {};
    const last = u.cooldowns[key] || 0;
    const now = Date.now();
    if (now - last < (durationMs||0)) {
      return false;
    }
    u.cooldowns[key] = now;
    guardarBD();
    return true;
  } catch (e) { logger.warn('psychCooldownCheck error:', e.message); return true; }
}


const locales = {
  es: {
    menu_title: '◆ MENÚ SUPREMO ◆',
    menu_basic: '─ COMANDOS ─',
    menu_economy: '─ ECONOMÍA ─',
    menu_combat: '─ COMBATE ─',
    menu_store: '─ TIENDA ─',
    menu_clans: '─ CLANES ─',
    menu_extras: '─ EXTRAS ─',
    menu_ranks: 'RANKS',
    menu_admin: 'ADMINISTRACIÓN',
    menu_info_desc: 'Información del chat/grupo (miembros, mensajes/día, creador, hora local)',
    admin_note: 'comandos solo para admins de grupo',
    info_title: 'INFO DEL CHAT',
    info_group: 'Grupo',
    info_members: 'Miembros',
    info_total_msgs: 'Mensajes totales registrados',
    info_msgs_day: 'Mensajes/día (promedio)',
    info_bot_creator: 'Creador del bot',
    info_local_time: 'Hora local',
    info_group_owner: 'Creador del grupo',
    not_group: '❌ Este comando solo funciona en grupos.',
    only_admin: '❌ Solo administradores del grupo pueden usar este comando.',
    mute_success: '✅ {user} ha sido silenciado por {dur}',
    unmute_success: '✅ {user} ha sido des-silenciado.',
    mute_invalid_duration: '❌ Duración inválida. Ejemplos válidos: 10m, 2h, 1d, o "10 minutos"',
    setlang_success: '✅ Idioma establecido a: {lang}',
    setlang_invalid: '❌ Idioma inválido. Opciones: es, en'
  },
  en: {
    menu_title: '◆ SUPREME MENU ◆',
    menu_basic: '─ COMMANDS ─',
    menu_economy: '─ ECONOMY ─',
    menu_combat: '─ COMBAT ─',
    menu_store: '─ STORE ─',
    menu_clans: '─ CLANS ─',
    menu_extras: '─ EXTRAS ─',
    menu_ranks: 'RANKS',
    menu_admin: 'ADMIN',
    menu_info_desc: 'Chat/group info (members, msgs/day, owner, local time)',
    admin_note: 'commands only for group admins',
    info_title: 'CHAT INFO',
    info_group: 'Group',
    info_members: 'Members',
    info_total_msgs: 'Total tracked messages',
    info_msgs_day: 'Messages/day (avg)',
    info_bot_creator: 'Bot creator',
    info_local_time: 'Local time',
    info_group_owner: 'Group owner',
    not_group: '❌ This command works only in groups.',
    only_admin: '❌ Only group admins can use this command.',
    mute_success: '✅ {user} has been muted for {dur}',
    unmute_success: '✅ {user} has been unmuted.',
    mute_invalid_duration: '❌ Invalid duration. Examples: 10m, 2h, 1d, or "10 minutes"',
    setlang_success: '✅ Language set to: {lang}',
    setlang_invalid: '❌ Invalid language. Options: es, en'
  }
};

function t(key, lang = 'es', vars = {}) {
  const L = locales[lang] || locales.es;
  let str = L[key] || locales.es[key] || key;
  Object.keys(vars).forEach(k => {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), vars[k]);
  });
  return str;
}

let chatStats = {};
let chatStatsSaveTimeout = null;
if (fs.existsSync("chatStats.json")) {
  try { chatStats = JSON.parse(fs.readFileSync("chatStats.json")); } catch (e) { chatStats = {}; }
}

function saveChatStats() {
  if (chatStatsSaveTimeout) return;
  chatStatsSaveTimeout = setTimeout(() => {
    fs.writeFileSync("chatStats.json", JSON.stringify(chatStats, null, 2));
    chatStatsSaveTimeout = null;
  }, 1500);
}

let mutes = {};
let mutesSaveTimeout = null;
if (fs.existsSync("mutes.json")) {
  try { mutes = JSON.parse(fs.readFileSync("mutes.json")); } catch (e) { mutes = {}; }
}

function saveMutes() {
  if (mutesSaveTimeout) return;
  mutesSaveTimeout = setTimeout(() => {
    fs.writeFileSync("mutes.json", JSON.stringify(mutes, null, 2));
    mutesSaveTimeout = null;
  }, 1500);
}

let clanes = {};
if (fs.existsSync("clanes.json")) {
  clanes = JSON.parse(fs.readFileSync("clanes.json"));
}

// Snapshot used to detect cambios y notificar automáticamente a usuarios
let lastUsuariosSnapshot = {};
try { lastUsuariosSnapshot = JSON.parse(JSON.stringify(usuarios || {})); } catch (e) { lastUsuariosSnapshot = {}; }

function simpleClone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return Object.assign({}, obj); }
}

function diffUserFields(before, after) {
  const diffs = [];
  if (!before && after) {
    diffs.push('✅ Usuario registrado.');
    return diffs;
  }
  if (!after) return diffs;
  if ((before.nivel || 0) !== (after.nivel || 0)) diffs.push(`🔼 Nivel: ${before.nivel || 0} → ${after.nivel || 0}`);
  if ((before.poder || 0) !== (after.poder || 0)) diffs.push(`⚔️ Poder: ${(before.poder||0).toLocaleString()} → ${(after.poder||0).toLocaleString()}`);
  if ((before.dinero || 0) !== (after.dinero || 0)) diffs.push(`💰 Dinero: $${(before.dinero||0).toLocaleString()} → $${(after.dinero||0).toLocaleString()}`);
  if ((before.banco || 0) !== (after.banco || 0)) diffs.push(`🏦 Banco: $${(before.banco||0).toLocaleString()} → $${(after.banco||0).toLocaleString()}`);
  if ((before.exp || 0) !== (after.exp || 0)) diffs.push(`📚 EXP: ${before.exp || 0} → ${after.exp || 0}`);
  if ((before.defensa || 0) !== (after.defensa || 0)) diffs.push(`🛡️ Defensa: ${before.defensa || 0} → ${after.defensa || 0}`);
  if ((before.vida || 0) !== (after.vida || 0)) diffs.push(`❤️ Vida: ${before.vida || 0} → ${after.vida || 0}`);
  if ((before.skillPoints || 0) !== (after.skillPoints || 0)) diffs.push(`🔧 Puntos de habilidad: ${before.skillPoints || 0} → ${after.skillPoints || 0}`);
  if (String(before.clanId || '') !== String(after.clanId || '')) diffs.push(`🏰 Clan: ${before.clanId || '—'} → ${after.clanId || '—'}`);
  // cambios simples en skills
  const beforeSkills = (before.skills || []).slice().sort().join(',');
  const afterSkills = (after.skills || []).slice().sort().join(',');
  if (beforeSkills !== afterSkills) diffs.push(`🔓 Skills: ${afterSkills || '(ninguna)'}`);
  return diffs;
}

async function notifyUserChanges(uid, diffs) {
  return;
}

function guardarBD() {
  try {
    // Notificaciones privadas desactivadas
    const beforeAll = lastUsuariosSnapshot || {};
    const afterAll = usuarios || {};
    // Snapshot actualizado para referencia futura
    lastUsuariosSnapshot = simpleClone(afterAll);
  } catch (e) {
    logger.warn('Error en guardarBD diff:', e?.message || e);
  }
  try {
    if (db && typeof db.saveAllUsers === 'function') {
      db.saveAllUsers(usuarios);
    } else {
      fs.writeFileSync("usuarios.json", JSON.stringify(usuarios, null, 2));
    }
  } catch (e) {
    try { fs.writeFileSync("usuarios.json", JSON.stringify(usuarios, null, 2)); } catch (err) { logger.error('No se pudo persistir usuarios: ' + (err?.message || err)); }
  }
}

// Buscar usuario intentando varios formatos de JID (normaliza números)
function findUsuarioByAnyId(id) {
  if (!id) return null;
  if (usuarios[id]) return { key: id, user: usuarios[id] };
  const num = id.split('@')[0];
  const variants = [
    num + '@s.whatsapp.net',
    num + '@c.us',
    num + '@g.us',
    num + '@lid',
    num
  ];
  for (const v of variants) {
    if (usuarios[v]) return { key: v, user: usuarios[v] };
  }
  // Fallback: buscar coincidencias aproximadas por sufijo de número (últimos dígitos)
  try {
    const numOnly = num.replace(/^0+/, '');
    const tail7 = numOnly.slice(-7);
    for (const [k, u] of Object.entries(usuarios)) {
      const knum = (k.split('@')[0] || '').replace(/^0+/, '');
      if (!knum) continue;
      if (knum === numOnly) {
        logger.info('[findUsuario] exact match by numeric key', k);
        return { key: k, user: u };
      }
      if (knum.endsWith(numOnly) || numOnly.endsWith(knum)) {
        logger.info('[findUsuario] suffix match full:', k, 'for', id);
        return { key: k, user: u };
      }
      if (knum.endsWith(tail7)) {
        logger.info('[findUsuario] suffix7 match:', k, 'for', id);
        return { key: k, user: u };
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function findUsuarioKeyByAnyId(id) {
  const res = findUsuarioByAnyId(id);
  return res ? res.key : null;
}

function guardarClanes() {
  fs.writeFileSync("clanes.json", JSON.stringify(clanes, null, 2));
}

// Helper: detectar si un JID corresponde al bot actual (o a BOT_JID env)
function isBotJid(jid) {
  if (!jid) return false;
  const envJid = process.env.BOT_JID;
  if (envJid && jid === envJid) return true;
  try {
    const botJid = (currentSocket && currentSocket.user && (currentSocket.user.id || currentSocket.user.jid)) || null;
    if (botJid && jid === botJid) return true;
  } catch (e) {}
  return false;
}

function obtenerRangoClasificacion(poder) {
  // Tabla de clases más granular y con requisitios superiores
  const classes = [
    { name: 'Callejero', min: 0, max: 999 },
    { name: 'Luchador', min: 1000, max: 4999 },
    { name: 'Héroe', min: 5000, max: 14999 },
    { name: 'Campeón', min: 15000, max: 29999 },
    { name: 'Continental', min: 30000, max: 74999 },
    { name: 'Planetario', min: 75000, max: 149999 },
    { name: 'Estelar', min: 150000, max: 299999 },
    { name: 'Universal', min: 300000, max: 599999 },
    { name: 'Infinity', min: 600000, max: 999999 },
    { name: 'Celestial', min: 1000000, max: 1999999 },
    { name: 'Eterno', min: 2000000, max: 4999999 },
    { name: 'Inmortal', min: 5000000, max: 9999999 },
    { name: 'Divino', min: 10000000, max: 24999999 },
    { name: 'Ancestral', min: 25000000, max: 49999999 },
    { name: 'Legendario', min: 50000000, max: 99999999 },
    { name: 'Omega', min: 100000000, max: Infinity }
  ];

  // buscar la clase correspondiente
  let clase = classes[0].name;
  let claseObj = classes[0];
  for (const c of classes) {
    if (poder >= c.min && poder <= c.max) {
      clase = c.name;
      claseObj = c;
      break;
    }
  }

  // calcular una clasificación interna basada en la posición dentro del rango de la clase
  let clasificacion = 'C';
  const span = (claseObj.max === Infinity) ? 1 : (claseObj.max - claseObj.min + 1);
  const relative = span === 0 ? 1 : ((Math.max(0, poder - claseObj.min)) / span);
  if (relative >= 0.9) clasificacion = 'S';
  else if (relative >= 0.6) clasificacion = 'A';
  else if (relative >= 0.25) clasificacion = 'B';
  else clasificacion = 'C';

  return { rango: clase, clase: clase, clasificacion: clasificacion };
}

// Sistema de experiencia y niveles
function expToNext(level) {
  // Crecimiento muy pronunciado: nivel^2.8 * 1000
  return Math.max(1000, Math.floor(1000 * Math.pow(level, 2.8)));
}

function addExp(user, amount) {
  if (!user) return { gained: 0 };
  if (!user.exp) user.exp = 0;
  if (!user.nivel) user.nivel = 1;
  let gainedLevels = 0;
  user.exp += Math.floor(amount);
  while (user.exp >= expToNext(user.nivel)) {
    user.exp -= expToNext(user.nivel);
    user.nivel += 1;
    // bonus small boost to poder cada nivel
    user.poder = (user.poder || 0) + Math.floor(user.nivel * 25);
    gainedLevels += 1;
  }
  return { gained: gainedLevels };
}

// --- LOGROS / ACHIEVEMENTS ---
const ACHIEVEMENTS = {
  registrado: { id: 'registrado', name: 'Bienvenido', desc: 'Te registraste en el sistema', icon: '🎉' },
  primer_daily: { id: 'primer_daily', name: 'Diario reclamado', desc: 'Reclamaste tu primera recompensa diaria', icon: '📅' },
  entrenador: { id: 'entrenador', name: 'Entrenador', desc: 'Entrenaste 10 veces', icon: '💪' },
  duelista: { id: 'duelista', name: 'Duelista', desc: 'Ganaste 5 duelos', icon: '⚔️' },
  coleccionista: { id: 'coleccionista', name: 'Coleccionista', desc: 'Obtuviste un drop raro', icon: '🏅' },
  rico: { id: 'rico', name: 'Acomodado', desc: 'Alcanzaste 100000 coins', icon: '💰' }
};

// Añadir logros solicitados (progreso, actividad, temporada, juegos, prestigio)
Object.assign(ACHIEVEMENTS, {
  // Progreso / rangos
  primer_paso: { id: 'primer_paso', name: 'Primer Paso', desc: 'Ganar 10 puntos', icon: '🪨', goal: { field: 'seasonPoints', value: 10 } },
  alcance_aprendiz: { id: 'alcance_aprendiz', name: 'En Marcha', desc: 'Llegar al rango Aprendiz', icon: '🌱', goal: { seasonRank: '🌱 Aprendiz' } },
  alcance_recluta: { id: 'alcance_recluta', name: 'Entrando en calor', desc: 'Llegar al rango Recluta', icon: '⚔️', goal: { seasonRank: '⚔️ Recluta' } },
  alcance_maestro: { id: 'alcance_maestro', name: 'Pulido', desc: 'Llegar al rango Maestro', icon: '💎', goal: { seasonRank: '💎 Maestro' } },
  alcance_leyenda: { id: 'alcance_leyenda', name: 'Más allá del límite', desc: 'Llegar al rango Leyenda', icon: '🌌', goal: { seasonRank: '🌌 Leyenda' } },
  alcance_eterno: { id: 'alcance_eterno', name: 'El fin del camino', desc: 'Llegar al rango Eterno', icon: '🌠', goal: { seasonRank: '🌠 Eterno' } },

  // Actividad
  hablador: { id: 'hablador', name: 'Hablador', desc: 'Enviar 100 mensajes válidos', icon: '💬', goal: { field: 'messagesCount', value: 100 } },
  charlatan: { id: 'charlatan', name: 'Charlatán', desc: 'Enviar 500 mensajes válidos', icon: '🗣️', goal: { field: 'messagesCount', value: 500 } },
  imparable: { id: 'imparable', name: 'Imparable', desc: 'Enviar 1000 mensajes válidos', icon: '📢', goal: { field: 'messagesCount', value: 1000 } },
  siempre_presente: { id: 'siempre_presente', name: 'Siempre presente', desc: 'Estar activo 7 días seguidos', icon: '🔥', goal: { field: 'consecutiveDays', value: 7 } },
  no_tengo_vida: { id: 'no_tengo_vida', name: 'No tengo vida', desc: 'Estar activo 30 días seguidos', icon: '💀', goal: { field: 'consecutiveDays', value: 30 } },

  // Temporada
  participar_temporada: { id: 'participar_temporada', name: 'Recién llegado', desc: 'Participar en una temporada', icon: '⏱️', goal: { field: 'seasonsParticipated', value: 1 } },
  constante_temporada: { id: 'constante_temporada', name: 'Constante', desc: 'Participar en 3 temporadas', icon: '🔁', goal: { field: 'seasonsParticipated', value: 3 } },
  veterano_temporada: { id: 'veterano_temporada', name: 'Veterano del bot', desc: 'Participar en 5 temporadas', icon: '🏅', goal: { field: 'seasonsParticipated', value: 5 } },
  rey_temporada: { id: 'rey_temporada', name: 'Rey de la temporada', desc: 'Finalizar Top 1 de una temporada', icon: '👑' },
  podio_temporada: { id: 'podio_temporada', name: 'Podio', desc: 'Finalizar Top 3 de una temporada', icon: '🥉' },

  // Juegos / eventos
  primera_victoria: { id: 'primera_victoria', name: 'Primera victoria', desc: 'Ganar 1 juego', icon: '🎯', goal: { field: 'duelWins', value: 1 } },
  tryhard: { id: 'tryhard', name: 'Tryhard', desc: 'Ganar 10 juegos', icon: '🕹️', goal: { field: 'duelWins', value: 10 } },
  maquina: { id: 'maquina', name: 'Máquina', desc: 'Ganar 50 juegos', icon: '👾', goal: { field: 'duelWins', value: 50 } },
  campeon_evento: { id: 'campeon_evento', name: 'Campeón', desc: 'Ganar un torneo o evento especial', icon: '🏆' },

  // Prestigio
  prestigio_i: { id: 'prestigio_i', name: 'Renacer', desc: 'Alcanzar Prestigio I', icon: '🔱', goal: { field: 'prestige', value: 1 } },
  prestigio_iii: { id: 'prestigio_iii', name: 'Otra vez yo', desc: 'Alcanzar Prestigio III', icon: '🔥', goal: { field: 'prestige', value: 3 } },
  prestigio_v: { id: 'prestigio_v', name: 'Nunca es suficiente', desc: 'Alcanzar Prestigio V', icon: '💀', goal: { field: 'prestige', value: 5 } }
});

function getUserAchievementProgress(user, ach) {
  if (!ach.goal) return null;
  const g = ach.goal;
  if (g.field === 'messagesCount') return { cur: user.messagesCount || 0, goal: g.value };
  if (g.field === 'consecutiveDays') return { cur: user.consecutiveDays || 0, goal: g.value };
  if (g.field === 'seasonsParticipated') return { cur: (user.seasonsParticipated || []).length || 0, goal: g.value };
  if (g.field === 'duelWins') return { cur: (user.stats && user.stats.duelWins) || 0, goal: g.value };
  if (g.field === 'seasonPoints') return { cur: g.value <= 0 ? 0 : (user.seasonPoints || 0), goal: g.value };
  if (g.field === 'prestige') return { cur: user.prestige || 0, goal: g.value };
  return null;
}

function buildAchievementsText(user, mention) {
  const lines = [];
  lines.push(`🏆 LOGROS DE ${mention || user.nombre || ''}`);
  lines.push('');
  let unlocked = 0, total = 0;
  for (const id in ACHIEVEMENTS) {
    const a = ACHIEVEMENTS[id];
    total++;
    const has = (user.achievements || []).includes(a.id);
    if (has) { unlocked++; lines.push(`✅ ${a.icon} ${a.name}`); }
    else {
      const prog = getUserAchievementProgress(user, a);
      if (prog) lines.push(`❌ ${a.icon} ${a.name} — ${prog.cur} / ${prog.goal}`);
      else lines.push(`❌ ${a.icon} ${a.name}`);
    }
  }
  lines.push('');
  lines.push(`📊 ${unlocked} / ${total} desbloqueados`);
  return lines.join('\n');
}

function grantAchievement(user, id, sock = null, chatId = null) {
  if (!user) return false;
  if (!user.achievements) user.achievements = [];
  if (user.achievements.includes(id)) return false;
  if (!ACHIEVEMENTS[id]) return false;
  user.achievements.push(id);
  const ach = ACHIEVEMENTS[id];
  if (sock && chatId) {
    const msg = `🏆 *LOGRO DESBLOQUEADO*\n\n${ach.icon} ${ach.name}\n${ach.desc}\n\n⭐ +100 XP especial`;
    sock.sendMessage(chatId, { text: msg }).catch(() => {});
  }
  guardarBD();
  return true;
}

function getAchievementIcons(user) {
  if (!user || !Array.isArray(user.achievements)) return '';
  return user.achievements.map(id => (ACHIEVEMENTS[id] ? ACHIEVEMENTS[id].icon : '🔸')).join(' ');
}

// Barra de progreso ASCII
function getProgressBar(cur, total, len = 20) {
  const pct = total > 0 ? Math.min(1, cur / total) : 0;
  const filled = Math.round(pct * len);
  const empty = len - filled;
  return '╺' + '█'.repeat(filled) + '░'.repeat(empty) + '╸ ' + Math.round(pct * 100) + '%';
}

// --- SISTEMA DE MISIONES DIARIAS ---
const DAILY_MISSIONS = {
  gana_duelos: { id: 'gana_duelos', nombre: '⚔️ Duelista del día', desc: 'Gana 3 duelos', meta: 3, campo: 'duelWinsDaily', reward: { dinero: 5000, exp: 500, puntos: 25 } },
  entrena_veces: { id: 'entrena_veces', nombre: '💪 Entrenamiento intenso', desc: 'Entrena 2 veces', meta: 2, campo: 'trainCountDaily', reward: { dinero: 3000, exp: 300, puntos: 15 } },
  derrota_bosses: { id: 'derrota_bosses', nombre: '🐉 Cazador de dragones', desc: 'Derrota 2 bosses', meta: 2, campo: 'bossKillsDaily', reward: { dinero: 7000, exp: 700, puntos: 35 } },
  gana_dinero: { id: 'gana_dinero', nombre: '💰 Capitalista', desc: 'Gana $50.000', meta: 50000, campo: 'dineroGanedDaily', reward: { dinero: 2000, exp: 200, puntos: 10 } },
  mensajes: { id: 'mensajes', nombre: '💬 Comunicador', desc: 'Envía 50 mensajes', meta: 50, campo: 'messagesDaily', reward: { dinero: 2000, exp: 250, puntos: 12 } }
};

function initMissionsForUser(user) {
  if (!user.missions) {
    user.missions = {};
    const today = new Date().toDateString();
    for (const missionId in DAILY_MISSIONS) {
      user.missions[missionId] = {
        id: missionId,
        progress: 0,
        completed: false,
        completedDate: null,
        lastReset: today
      };
    }
    // Inicializar racha
    user.streakDays = 0;
    user.lastStreakDate = null;
    user.streakBroken = false;
  }
  // Resetear misiones si es un nuevo día
  const today = new Date().toDateString();
  if (!user.missions.lastDailyReset || user.missions.lastDailyReset !== today) {
    // Verificar y actualizar racha
    if (!user.streakDays) user.streakDays = 0;
    if (user.missions.lastDailyReset) {
      const lastDate = new Date(user.missions.lastDailyReset);
      const currentDate = new Date(today);
      const timeDiff = currentDate - lastDate;
      const daysDiff = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
      
      if (daysDiff === 1) {
        // Racha continúa
        user.streakDays = (user.streakDays || 0) + 1;
        user.lastStreakDate = today;
        user.streakBroken = false;
      } else if (daysDiff > 1) {
        // Racha rota
        user.streakDays = 0;
        user.lastStreakDate = null;
        user.streakBroken = true;
      }
    } else {
      // Primer día
      user.streakDays = 1;
      user.lastStreakDate = today;
      user.streakBroken = false;
    }
    
    user.missions.lastDailyReset = today;
    for (const missionId in DAILY_MISSIONS) {
      user.missions[missionId] = {
        id: missionId,
        progress: 0,
        completed: false,
        completedDate: null,
        lastReset: today
      };
    }
  }
}

function updateMissionProgress(user, missionId, amount = 1) {
  if (!user.missions) initMissionsForUser(user);
  if (!user.missions[missionId] || user.missions[missionId].completed) return false;
  const mission = DAILY_MISSIONS[missionId];
  if (!mission) return false;
  user.missions[missionId].progress = Math.min(mission.meta, user.missions[missionId].progress + amount);
  if (user.missions[missionId].progress >= mission.meta && !user.missions[missionId].completed) {
    user.missions[missionId].completed = true;
    user.missions[missionId].completedDate = Date.now();
    return true; // misión completada
  }
  return false;
}

function buildMissionsText(user) {
  initMissionsForUser(user);
  const lines = [];
  lines.push('📋 *MISIONES DIARIAS*');
  lines.push('');
  
  // Mostrar racha
  const dineroBonus = getStreakDineroBonus(user.streakDays);
  const expBonus = getStreakExpBonus(user.streakDays);
  const poderBonus = getStreakPoderBonus(user.streakDays);
  if (user.streakDays > 0) {
    lines.push(`🔥 RACHA: ${user.streakDays} días consecutivos`);
    lines.push(`💰 Bonus dinero: +$${dineroBonus.toLocaleString()}`);
    lines.push(`📚 Bonus EXP: +${expBonus}`);
    lines.push(`⚡ Bonus PODER: +${poderBonus}`);
    lines.push('');
  }
  
  let completed = 0, total = 0;
  for (const missionId in user.missions) {
    const missionData = user.missions[missionId];
    const mission = DAILY_MISSIONS[missionId];
    if (!mission) continue;
    total++;
    if (missionData.completed) {
      completed++;
      const multipliedExp = Math.floor(mission.reward.exp + expBonus);
      const multipliedDinero = Math.floor(mission.reward.dinero + dineroBonus);
      const multipliedPuntos = Math.floor(mission.reward.puntos + (mission.reward.puntos * user.streakDays * 0.1));
      lines.push(`✅ ${mission.nombre}`);
      lines.push(`   💰 +$${multipliedDinero.toLocaleString()} | 📚 +${multipliedExp} exp | 📊 +${multipliedPuntos} pts`);
    } else {
      const bar = getProgressBar(missionData.progress, mission.meta, 15);
      lines.push(`⏳ ${mission.nombre}`);
      lines.push(`   ${bar}`);
      lines.push(`   ${missionData.progress}/${mission.meta}`);
    }
    lines.push('');
  }
  lines.push(`📊 Completadas: ${completed}/${total}`);
  if (completed === total) {
    lines.push('🎉 ¡Todas las misiones del día completadas!');
    lines.push(`${user.streakDays > 0 ? '🔥 ¡Mantén tu racha!' : '🔥 ¡Comienza tu racha mañana!'}`);
  }
  return lines.join('\n');
}

function getStreakMultiplier(streakDays) {
  if (streakDays <= 0) return 1.0;
  // Multiplicador basado en días de racha
  // Día 1: 1.0x, Día 2: 1.1x, Día 3: 1.2x, etc
  // Máximo: 3.0x en día 20+
  return Math.min(3.0, 1.0 + (streakDays * 0.1));
}

// Recompensas escalables por racha para dinero
function getStreakDineroBonus(streakDays) {
  if (streakDays <= 0) return 0;
  // Día 1: 30000, Día 2: 35000, Día 3: 40000, etc
  // Base: 30000, Incremento: 5000 por día
  // Día 100: $525,000
  return 30000 + ((streakDays - 1) * 5000);
}

// Recompensas escalables por racha para experiencia (mucho más que dinero)
function getStreakExpBonus(streakDays) {
  if (streakDays <= 0) return 0;
  // Día 1: 30000, Día 2: 33000, Día 3: 36000, etc
  // Base: 30000, Incremento: 3000 por día
  // Día 100: +327,000 EXP
  return 30000 + ((streakDays - 1) * 3000);
}

// Recompensas escalables por racha para poder (más que exp)
function getStreakPoderBonus(streakDays) {
  if (streakDays <= 0) return 0;
  // Día 1: 50000, Día 2: 55000, Día 3: 60000, etc
  // Base: 50000, Incremento: 5000 por día
  // Día 100: +545,000 PODER
  return 50000 + ((streakDays - 1) * 5000);
}

// --- SISTEMA DE MASCOTAS/ALIADOS ---
const PETS = {
  lobo_feroz: { id: 'lobo_feroz', nombre: '🐺 Lobo Feroz', desc: 'Compañero leal', precio: 15000, poder: 50, exp_multiplier: 1.1 },
  dragon_joven: { id: 'dragon_joven', nombre: '🐉 Dragón Joven', desc: 'Pequeño pero poderoso', precio: 50000, poder: 150, exp_multiplier: 1.25 },
  fenix_renacer: { id: 'fenix_renacer', nombre: '🔥 Fénix Renacido', desc: 'Inmortal en batalla', precio: 150000, poder: 400, exp_multiplier: 1.5 },
  cerberus: { id: 'cerberus', nombre: '🌑 Cérbero', desc: 'Guardián del abismo', precio: 500000, poder: 1000, exp_multiplier: 2.0 }
};

function getPetById(petId) {
  return PETS[petId] || null;
}

// --- SISTEMA DE MERCADO P2P ---
let marketplace = [];
if (fs.existsSync('marketplace.json')) {
  try { marketplace = JSON.parse(fs.readFileSync('marketplace.json')); } catch (e) { marketplace = []; }
}

function saveMarketplace() {
  fs.writeFileSync('marketplace.json', JSON.stringify(marketplace, null, 2));
}

function listItemOnMarketplace(sellerId, itemId, itemName, itemRarity, precio) {
  const listing = {
    id: 'market_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    sellerId,
    itemId,
    itemName,
    itemRarity,
    precio,
    listedAt: Date.now(),
    estado: 'activo'
  };
  marketplace.push(listing);
  saveMarketplace();
  return listing;
}

function buyFromMarketplace(buyerId, listingId, user, sock, chatId) {
  const listing = marketplace.find(l => l.id === listingId);
  if (!listing || listing.estado !== 'activo') return { success: false, msg: '❌ Anuncio no disponible.' };
  if ((user.dinero || 0) < listing.precio) return { success: false, msg: `❌ Dinero insuficiente ($${listing.precio.toLocaleString()})` };
  
  const seller = usuarios[listing.sellerId];
  if (!seller) return { success: false, msg: '❌ Vendedor no encontrado.' };
  
  // transferir dinero
  user.dinero -= listing.precio;
  seller.dinero = (seller.dinero || 0) + listing.precio;
  
  // transferir item
  if (!user.inventario) user.inventario = {};
  user.inventario[listing.itemId] = (user.inventario[listing.itemId] || 0) + 1;
  
  // marcar anuncio como vendido
  listing.estado = 'vendido';
  listing.buyerId = buyerId;
  listing.vendidoEn = Date.now();
  
  saveMarketplace();
  guardarBD();
  
  if (sock && chatId) {
    sock.sendMessage(chatId, { text: `✅ ¡Compra exitosa!\n\n${listing.itemName} (${listing.itemRarity})\n💰 -$${listing.precio.toLocaleString()}` }).catch(() => {});
  }
  
  return { success: true, msg: 'Compra realizada.' };
}

function getPetById(petId) {
  return PETS[petId] || null;
}

function buyPet(user, petId, sock, chatId) {
  if (!user) return false;
  const pet = getPetById(petId);
  if (!pet) return false;
  if ((user.dinero || 0) < pet.precio) return false;
  if (!user.pets) user.pets = [];
  if (user.pets.some(p => p.id === petId)) return false; // solo una mascota de cada tipo
  user.dinero -= pet.precio;
  user.pets.push({
    id: petId,
    nivel: 1,
    exp: 0,
    compradaEn: Date.now()
  });
  if (sock && chatId) {
    sock.sendMessage(chatId, { text: `${pet.nombre} *ADQUIRIDA*\n💰 -$${pet.precio.toLocaleString()}\n⚔️ +${pet.poder} poder` }).catch(() => {});
  }
  guardarBD();
  return true;
}

function buildPetsText(user) {
  if (!user.pets || user.pets.length === 0) {
    return '🐾 No tienes mascotas aún.\nCompra una con #comprarmascotas';
  }
  let txt = '🐾 TUS MASCOTAS 🐾\n\n';
  for (const petData of user.pets) {
    const pet = getPetById(petData.id);
    if (!pet) continue;
    txt += `${pet.nombre}\n`;
    txt += `   Nivel: ${petData.nivel} (${petData.exp} exp)\n`;
    txt += `   ⚔️ Poder: +${pet.poder * petData.nivel}\n\n`;
  }
  return txt;
}

// --- EVENTO MENSUAL (INVASIÓN) ---
let invasionEvent = null;
const invasionBossPath = 'invasion_event.json';
if (fs.existsSync(invasionBossPath)) {
  try { invasionEvent = JSON.parse(fs.readFileSync(invasionBossPath)); } catch (e) { invasionEvent = null; }
}

function createInvasionBoss(sock, chatId) {
  const hoje = new Date();
  const monthKey = `${hoje.getFullYear()}-${hoje.getMonth()}`;
  
  if (invasionEvent && invasionEvent.monthKey === monthKey && invasionEvent.vidaActual > 0) {
    return invasionEvent; // ya existe para este mes
  }
  
  const boss = {
    bossId: 'invasion_' + monthKey,
    nombre: '👹 Invasión Interdimensional',
    vidaMax: 5000000,
    vidaActual: 5000000,
    dificultad: 'imposible',
    rankingDaño: {},
    activo: true,
    inicio: Date.now(),
    monthKey: monthKey
  };
  
  invasionEvent = boss;
  fs.writeFileSync(invasionBossPath, JSON.stringify(invasionEvent, null, 2));
  
  if (sock && chatId) {
    sock.sendMessage(chatId, { text: `⚠️ *INVASIÓN INTERDIMENSIONAL*\n\n👹 Un portal se abre en el cielo...\n\n${boss.nombre}\n❤️ ${boss.vidaActual.toLocaleString()} HP\n\nUsa #invasión para atacar` }).catch(() => {});
  }
  
  return boss;
}

// Evento Mensual (simple)
let seasons = {};
let currentSeason = null;
if (fs.existsSync('seasons.json')) {
  try { const s = JSON.parse(fs.readFileSync('seasons.json')); seasons = s.seasons || {}; currentSeason = s.current || null; } catch (e) { seasons = {}; currentSeason = null; }
}

// Si no hay temporada activa al arrancar, iniciar una ahora y programar su fin para el día 1 del mes siguiente
if (!currentSeason) {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const start = Date.now();
    const next = new Date(year, month + 1, 1).getTime();
    const id = `Temporada_${Object.keys(seasons).length + 1}`;
    const name = `Temporada ${year}-${String(month + 1).padStart(2, '0')}`;
    seasons[id] = { standings: {}, started: start, ends: next - 1, archived: false, name };
    currentSeason = id;
    saveSeasons();
    logger.info('Season started immediately on init:', id);
  } catch (e) { logger.warn('Could not auto-start season on init: ' + (e.message || e)); }
}
// Reload seasons.json if changed on disk (so external UI can control seasons)
function reloadSeasonsFromDisk() {
  try {
    if (!fs.existsSync('seasons.json')) return;
    const data = JSON.parse(fs.readFileSync('seasons.json'));
    seasons = data.seasons || {};
    currentSeason = data.current || null;
    logger.info('Seasons reloaded from disk. currentSeason=', currentSeason);
  } catch (e) { logger.error('Error reloading seasons.json', e.message); }
}
fs.watchFile('seasons.json', { interval: 2000 }, (curr, prev) => { reloadSeasonsFromDisk(); });

// Scheduler: iniciar/terminar temporadas automáticamente el día 1 de cada mes
function setupSeasonScheduler() {
  // revisión cada 30 minutos
  setInterval(() => {
    try {
      const now = new Date();
      // terminar temporada si llegó su fecha
      if (currentSeason && seasons[currentSeason] && seasons[currentSeason].ends && seasons[currentSeason].ends < Date.now()) {
        try { endSeason(); saveSeasons(); logger.info('Season auto-ended:', currentSeason); } catch (e) { logger.error('auto endSeason error', e.message); }
      }
      // iniciar nueva temporada el día 1 si no hay una activa
      if (now.getDate() === 1 && (!currentSeason || (seasons[currentSeason] && seasons[currentSeason].ended))) {
        try {
          const year = now.getFullYear();
          const month = now.getMonth();
          const name = `Temporada ${year}-${String(month + 1).padStart(2, '0')}`;
          const start = new Date(year, month, 1).getTime();
          const next = new Date(year, month + 1, 1).getTime();
          const id = `Temporada_${Object.keys(seasons).length + 1}`;
          seasons[id] = { standings: {}, started: start, ends: next - 1, archived: false, name };
          currentSeason = id;
          saveSeasons();
          logger.info('Season auto-started:', id);
        } catch (e) { logger.error('auto startSeason error', e.message); }
      }
    } catch (e) { /* ignore */ }
  }, 30 * 60 * 1000);
}

// arrancar scheduler ahora
try { setupSeasonScheduler(); } catch (e) { logger.error('No se pudo iniciar scheduler de temporadas', e.message); }

// Sistemas adicionales: raids, torneos, trivia, expediciones, skilltrees, enigmas, clanboss
let raids = {};
let tournaments = {};
let trivias = {};
let expeditions = {};
let skilltrees = {};
let enigmas = {};
let clanBosses = {};

function loadJsonIfExists(name, def) {
  // Mantener para compatibilidad con config/ pero usar SQLite para datos
  try {
    if (fs.existsSync(name)) return JSON.parse(fs.readFileSync(name));
  } catch (e) { /* ignore */ }
  return def;
}

// Cargar desde SQLite
raids = db.getAllRaids() || {};
tournaments = db.getAllTournaments() || {};
trivias = db.getAllTrivias() || {};
expeditions = db.getAllExpeditions() || {};
skilltrees = db.getAllSkilltrees() || {};
enigmas = db.getAllEnigmas() || {};
clanBosses = db.getAllClanBosses() || {};

function saveJson(name, obj) {
  // Usar SQLite en lugar de archivos
  if (name === 'raids.json') db.saveAllRaids(obj);
  else if (name === 'tournaments.json') db.saveAllTournaments(obj);
  else if (name === 'trivias.json') db.saveAllTrivias(obj);
  else if (name === 'expeditions.json') db.saveAllExpeditions(obj);
  else if (name === 'skilltrees.json') db.saveAllSkilltrees(obj);
  else if (name === 'enigmas.json') db.saveAllEnigmas(obj);
  else if (name === 'clanbosses.json') db.saveAllClanBosses(obj);
  else if (name === 'events.json') db.saveAllEvents(obj);
  else try { fs.writeFileSync(name, JSON.stringify(obj, null, 2)); } catch (e) { logger.warn('No se pudo guardar', name, e?.message || e); }
}

function addSeasonPoints(uid, pts) {
  if (!uid || !pts || pts <= 0) return;
  try {
    if (!usuarios[uid]) usuarios[uid] = usuarios[uid] || {};
    // Ajustar puntos según el rango actual del jugador (a mayor rango, menos puntos otorgados)
    function computeAdjustedPoints(userId, basePts) {
      const curPts = (usuarios[userId] && usuarios[userId].seasonPoints) ? usuarios[userId].seasonPoints : 0;
      const rank = getSeasonRank(curPts);
      const tier = (typeof rank.tier === 'number') ? rank.tier : 0;
      // Aplicar decaimiento exponencial por tier: cada tier reduce ~10% (configurable)
      const decayPerTier = 0.10; // 10% menos por tier
      let multiplier = Math.pow(1 - decayPerTier, tier);
      if (multiplier < 0.12) multiplier = 0.12; // tope mínimo del 12%
      const adjusted = Math.max(1, Math.floor(basePts * multiplier));
      return { adjusted, multiplier, tier };
    }

    const info = computeAdjustedPoints(uid, pts);
    const applied = info.adjusted;
    usuarios[uid].seasonPoints = (usuarios[uid].seasonPoints || 0) + applied;
    if (currentSeason) {
      seasons[currentSeason] = seasons[currentSeason] || {};
      seasons[currentSeason].standings = seasons[currentSeason].standings || {};
      seasons[currentSeason].standings[uid] = (seasons[currentSeason].standings[uid] || 0) + applied;
      saveJson('seasons.json', { seasons, current: currentSeason });
    }
  } catch (e) { logger.warn('addSeasonPoints error', e?.message || e); }
}

// RANGOS DE TEMPORADA (por puntos)
const SEASON_RANKS = [
  { pts: 0, name: '· Novato' },
  { pts: 200, name: '• Aprendiz' },
  { pts: 700, name: '▦ Recluta' },
  { pts: 1500, name: '▣ Explorador' },
  { pts: 3000, name: '◆ Combatiente' },
  { pts: 6000, name: '✦ Estratega' },
  { pts: 10000, name: '✹ Veterano' },
  { pts: 16000, name: '✪ Élite' },
  { pts: 24000, name: '✫ Maestro' },
  { pts: 34000, name: '✺ Gran Maestro' },
  { pts: 46000, name: '♛ Leyenda' },
  { pts: 60000, name: '✵ Titán' },
  { pts: 76000, name: '✸ Mítico' },
  { pts: 94000, name: '✼ Inmortal' },
  { pts: 114000, name: '✶ Dios Antiguo' },
  { pts: 136000, name: '✷ Eterno' }
];

function getSeasonRank(points) {
  let rank = SEASON_RANKS[0];
  for (const r of SEASON_RANKS) {
    if (points >= r.pts) rank = r;
    else break;
  }
  const index = SEASON_RANKS.findIndex(r => r.name === rank.name);
  return { name: rank.name, pts: rank.pts, tier: index };
}

function saveSeasons() { fs.writeFileSync('seasons.json', JSON.stringify({ seasons, current: currentSeason }, null, 2)); }

// ---------- Comandos de temporada / puntos ----------
async function handleSeasonCommands({ body, senderId, chatId, sock, msg }) {
  if (body === '#puntos') {
    const userKey = findUsuarioKeyByAnyId(senderId) || senderId;
    let pts = 0;
    if (currentSeason && seasons[currentSeason] && seasons[currentSeason].standings) {
      pts = seasons[currentSeason].standings[userKey] || seasons[currentSeason].standings[senderId] || 0;
    }
    if ((!pts || pts === 0) && usuarios[userKey] && usuarios[userKey].seasonPoints) {
      pts = usuarios[userKey].seasonPoints || pts;
    }
    const rankName = currentSeason ? getSeasonRank(pts).name : '— Sin temporada —';
    // calcular posición
    let posStr = 'N/A';
    try {
      if (currentSeason && seasons[currentSeason] && seasons[currentSeason].standings) {
        const arr = Object.entries(seasons[currentSeason].standings).map(([uid, p]) => ({ uid, p }));
        arr.sort((a, b) => b.p - a.p);
        const idx = arr.findIndex(e => e.uid === userKey || e.uid === senderId);
        if (idx >= 0) posStr = `#${idx + 1}`;
      }
    } catch (e) {}
    await sock.sendMessage(chatId, { text: `📊 *TEMPORADA*\nPuntos: ${pts}  |  Rango: ${rankName}  |  Pos: ${posStr}` }, { quoted: msg });
    return true;
  }

  if (body.startsWith('#ganarpuntos')) {
    const parts = body.split(' ');
    const n = parseInt(parts[1] || '0', 10) || 0;
    const maxPerCall = 500;
    if (n <= 0) { await sock.sendMessage(chatId, { text: '❌ Uso: #ganarpuntos <cantidad> (n debe ser positivo)' }, { quoted: msg }); return true; }
    if (n > maxPerCall) { await sock.sendMessage(chatId, { text: `❌ Límite por llamada: ${maxPerCall}` }, { quoted: msg }); return true; }
    if (!psychCooldownCheck(senderId, 'gainpts', 30 * 1000)) return true;
    addSeasonPoints(senderId, n);
    guardarBD();
    await sock.sendMessage(chatId, { text: `✅ Has ganado ${n} pts de temporada (ajustados según tu rango).` }, { quoted: msg });
    return true;
  }

  if (body === '#top' || body === '#toptemporada') {
    if (!currentSeason || !seasons[currentSeason] || !seasons[currentSeason].standings) {
      await sock.sendMessage(chatId, { text: 'No hay temporada activa.' }, { quoted: msg });
      return true;
    }
    const arr = Object.entries(seasons[currentSeason].standings).map(([uid, pts]) => ({ uid, pts }));
    arr.sort((a, b) => b.pts - a.pts);
    const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    const lines = ['🏆 TOP 10 TEMPORADA\n'];
    for (let i = 0; i < Math.min(10, arr.length); i++) {
      const e = arr[i];
      const name = (findUsuarioByAnyId(e.uid) || { user: { nombre: e.uid.split('@')[0] } }).user.nombre;
      lines.push(`${romanos[i]}. ${name} — ⭐ ${e.pts} pts`);
    }
    await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
    return true;
  }
  return false;
}

function seasonAddPoints(userId, pts) {
  // Delegar a addSeasonPoints para aplicar la lógica de ajuste por rango
  addSeasonPoints(userId, pts);
}

// Extender seasonAddPoints para registrar participación y otorgar logros
function seasonAddPointsAndRegister(userId, pts) {
  seasonAddPoints(userId, pts);
  try {
    // obtener nuevos puntos tras el añadido
    const newPts = (seasons[currentSeason] && seasons[currentSeason].standings && seasons[currentSeason].standings[userId]) ? seasons[currentSeason].standings[userId] : 0;
    const userKey = findUsuarioKeyByAnyId(userId);
    if (!userKey) return;
    const u = usuarios[userKey];
    if (!u) return;
    if (!u.seasonsParticipated) u.seasonsParticipated = [];
    if (!u.seasonsParticipated.includes(currentSeason)) {
      u.seasonsParticipated.push(currentSeason);
      grantAchievement(u, 'participar_temporada');
      const cnt = u.seasonsParticipated.length;
      if (cnt >= 3) grantAchievement(u, 'constante_temporada');
      if (cnt >= 5) grantAchievement(u, 'veterano_temporada');
      guardarBD();
    }
    // Progreso por puntos y rangos de temporada
    if (newPts >= 10) grantAchievement(u, 'primer_paso');
    const rankInfo = getSeasonRank(newPts);
    if (rankInfo.name && rankInfo.name.includes('Aprendiz')) grantAchievement(u, 'alcance_aprendiz');
    if (rankInfo.name && rankInfo.name.includes('Recluta')) grantAchievement(u, 'alcance_recluta');
    if (rankInfo.name && rankInfo.name.includes('Maestro')) grantAchievement(u, 'alcance_maestro');
    if (rankInfo.name && rankInfo.name.includes('Leyenda')) grantAchievement(u, 'alcance_leyenda');
    if (rankInfo.name && rankInfo.name.includes('Eterno')) grantAchievement(u, 'alcance_eterno');
    guardarBD();
  } catch (e) { logger.error('seasonAddPointsAndRegister error', e); }
}

// Iniciar una nueva temporada (automática o manual). durationDays por defecto 30.
function startSeason(name, durationDays = 30, carryPointsMap = {}) {
  if (currentSeason) return false;
  const id = `Temporada_${Object.keys(seasons).length + 1}`;
  const now = Date.now();
  const ends = now + durationDays * 24 * 3600 * 1000;
  seasons[id] = { standings: {}, started: now, ends: ends, archived: false, name: name || id, top: [] };
  // cargar carries (puntos reducidos de la temporada anterior)
  for (const uid in carryPointsMap) {
    seasons[id].standings[uid] = carryPointsMap[uid];
  }
  currentSeason = id;
  saveSeasons();
  return id;
}

// Finalizar temporada actual: archivar, asignar insignias y calcular carry para la siguiente
function endSeason() {
  if (!currentSeason) return false;
  const s = seasons[currentSeason];
  s.ended = Date.now();
  // recuperar standings ordenados
  const arr = Object.entries(s.standings || {}).map(([uid, pts]) => ({ uid, pts }));
  arr.sort((a, b) => b.pts - a.pts);
  // top 10
  s.top = arr.slice(0, 10);
  // asignar insignias y mejores historicos
  for (let i = 0; i < arr.length; i++) {
    const { uid, pts } = arr[i];
    const rankInfo = getSeasonRank(pts);
    const userKey = findUsuarioKeyByAnyId(uid) || uid;
    const u = usuarios[userKey];
    if (!u) continue;
    if (!u.seasonHistory) u.seasonHistory = [];
    u.seasonHistory.push({ season: currentSeason, points: pts, rank: rankInfo.name });
    // actualizar mejor clase histórica (antes llamado rango/eterno -> ahora 'clase')
    const bestTier = (u.bestSeasonTier || -1);
    if (rankInfo.tier > bestTier) {
      u.bestSeasonTier = rankInfo.tier;
      u.bestSeasonRank = rankInfo.name; // nombre del mejor rank histórico
    }
    // otorgar insignia simple
    if (!u.seasonBadges) u.seasonBadges = [];
    u.seasonBadges.push({ season: currentSeason, rank: rankInfo.name, awardedAt: Date.now() });
    // otorgar logros por podio
    if (i === 0) grantAchievement(u, 'rey_temporada');
    if (i < 3) grantAchievement(u, 'podio_temporada');
  }
  // crear carry: reducción aleatoria entre 20% y 30% de puntos para la nueva temporada
  const carry = {};
  const reductionPercent = Math.floor(20 + Math.random() * 11); // 20..30
  for (const { uid, pts } of arr) {
    carry[uid] = Math.floor(pts * (reductionPercent / 100));
  }
  s.archived = true;
  s.carryPercent = reductionPercent;
  s.carry = carry;
  // guardar archive
  saveSeasons();
  const finishedSeason = currentSeason;
  currentSeason = null;
  saveSeasons();
  // iniciar nueva temporada automáticamente con carry
  const next = startSeason(null, 30, carry);
  // devolver resumen
  return { finished: finishedSeason, next };
}

// Chequear caducidad (se ejecuta periódicamente)
setInterval(() => {
  try {
    if (!currentSeason) return;
    const s = seasons[currentSeason];
    if (!s || !s.ends) return;
    if (Date.now() >= s.ends) {
      logger.info('Temporada finalizada automáticamente:', currentSeason);
      endSeason();
    }
    // Auto-rotación mensual: reiniciar cada día 1 (una vez por mes)
    try {
      const now = new Date();
      const todayDay = now.getDate();
      const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const metaPath = 'season_meta.json';
      let meta = {};
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (e) { meta = {}; }
      }
      if (todayDay === 1) {
        if (meta.lastMonthly !== ym) {
          logger.info('Monthly season rotation triggered for', ym);
          if (currentSeason) {
            const res = endSeason();
            logger.info('Monthly rotation ended season', res && res.finished);
          } else {
            const id = startSeason(`Temporada_${ym}`, 30, {});
            logger.info('Monthly rotation started season', id);
          }
          meta.lastMonthly = ym;
          try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch (e) { logger.warn('Could not write season_meta.json', e.message || e); }
        }
      }
    } catch (e) { logger.error('Error en rotación mensual de temporadas', e); }
  } catch (e) { logger.error('Error en checkSeasonExpiry', e); }
}, 60 * 60 * 1000); // cada hora

// Eventos globales simples
let events = [];
const loadedEvents = db.getAllEvents();
if (loadedEvents && Object.keys(loadedEvents).length > 0) {
  events = Object.values(loadedEvents).map(v => v.event || v).filter(Boolean);
} else if (fs.existsSync('events.json')) {
  try { 
    events = JSON.parse(fs.readFileSync('events.json')); 
    // Migrar a SQLite
    const eventsObj = events.reduce((o, e, i) => { o[i] = { event: e }; return o; }, {});
    db.saveAllEvents(eventsObj);
  } catch (e) { events = []; }
}
function saveEvents() { 
  const eventsObj = events.reduce((o, e, i) => { o[i] = { event: e }; return o; }, {});
  db.saveAllEvents(eventsObj);
}

// --- SISTEMA DE CASAS/PROPIEDADES ---
const PROPIEDADES = {
  cabaña: { id: 'cabaña', nombre: '🏡 Cabaña', precio: 50000, ingresoBase: 500, mejoras: 3, emoji: '🏡' },
  casa: { id: 'casa', nombre: '🏠 Casa', precio: 150000, ingresoBase: 1500, mejoras: 5, emoji: '🏠' },
  mansion: { id: 'mansion', nombre: '🏘️ Mansión', precio: 500000, ingresoBase: 5000, mejoras: 8, emoji: '🏘️' },
  castillo: { id: 'castillo', nombre: '🏰 Castillo', precio: 2000000, ingresoBase: 15000, mejoras: 10, emoji: '🏰' }
};

let propiedades = {}; // { userId: { tipo, nivelMejora, proximoIngreso } }
if (fs.existsSync('propiedades.json')) {
  try { propiedades = JSON.parse(fs.readFileSync('propiedades.json')); } catch (e) { propiedades = {}; }
}

function savePropiedades() {
  try {
    if (db && typeof db.saveAllPropiedades === 'function') {
      db.saveAllPropiedades(propiedades);
    } else {
      fs.writeFileSync('propiedades.json', JSON.stringify(propiedades, null, 2));
    }
  } catch (e) { logger.warn('No se pudo guardar propiedades:', e.message); }
}

function obtenerPropiedadDeUsuario(userId) {
  return propiedades[userId] || null;
}

function calcularIngresoPropiedad(tipo, nivelMejora) {
  const prop = PROPIEDADES[tipo];
  if (!prop) return 0;
  const ingresoBase = prop.ingresoBase;
  const multiplicadorMejora = 1 + (nivelMejora * 0.15); // +15% por nivel
  return Math.floor(ingresoBase * multiplicadorMejora);
}

function procesarIngresosPropiedad() {
  const ahora = Date.now();
  for (const userId in propiedades) {
    const prop = propiedades[userId];
    if (!prop || !prop.proximoIngreso) continue;
    if (ahora >= prop.proximoIngreso) {
      const user = usuarios[userId];
      if (user) {
        const ingreso = calcularIngresoPropiedad(prop.tipo, prop.nivelMejora || 0);
        user.dinero = (user.dinero || 0) + ingreso;
        prop.proximoIngreso = ahora + 3600000; // próximo en 1 hora
      }
    }
  }
  savePropiedades();
  guardarBD();
}

// Procesar ingresos cada 10 minutos
setInterval(procesarIngresosPropiedad, 10 * 60 * 1000);

// --- SISTEMA DE ALIANZAS/MATRIMONIO 💍 ---
let alianzas = {}; // { userId: { pareja: userId, fechaBoda: timestamp, hijos: [], bancoComun: amount } }
let propuestasMatrimonio = {}; // { userId: { propuestaHecha: userId, fechaPropuesta: timestamp } }

if (fs.existsSync('alianzas.json')) {
  try { alianzas = JSON.parse(fs.readFileSync('alianzas.json')); } catch (e) { alianzas = {}; }
}

if (fs.existsSync('propuestas_matrimonio.json')) {
  try { propuestasMatrimonio = JSON.parse(fs.readFileSync('propuestas_matrimonio.json')); } catch (e) { propuestasMatrimonio = {}; }
}

function saveAlianzas() {
  try {
    if (db && typeof db.saveAllAlianzas === 'function') {
      db.saveAllAlianzas(alianzas);
    } else {
      fs.writeFileSync('alianzas.json', JSON.stringify(alianzas, null, 2));
    }
  } catch (e) { logger.warn('No se pudo guardar alianzas:', e.message); }
}

function savePropuestasMatrimonio() {
  try {
    fs.writeFileSync('propuestas_matrimonio.json', JSON.stringify(propuestasMatrimonio, null, 2));
  } catch (e) { logger.warn('No se pudo guardar propuestas:', e.message); }
}

function obtenerPareja(userId) {
  return alianzas[userId] || null;
}

function obtenerBonusAlianza(userId) {
  const alianza = obtenerPareja(userId);
  if (!alianza) return { poder: 0, defensa: 0, multiplicadorDaño: 1.0 };
  
  const diasCasados = Math.floor((Date.now() - alianza.fechaBoda) / (1000 * 60 * 60 * 24));
  const hijos = (alianza.hijos || []).length;
  
  return {
    poder: 500 + (diasCasados * 10) + (hijos * 200),
    defensa: 100 + (diasCasados * 2) + (hijos * 50),
    multiplicadorDaño: 1.0 + (hijos * 0.1), // +10% daño por hijo
    diasCasados,
    hijos
  };
}

// Procesar intentos de matrimonio expirados (después de 2 horas sin respuesta)
setInterval(() => {
  const ahora = Date.now();
  for (const userId in propuestasMatrimonio) {
    const prop = propuestasMatrimonio[userId];
    if (ahora - prop.fechaPropuesta > 2 * 60 * 60 * 1000) {
      delete propuestasMatrimonio[userId];
    }
  }
  savePropuestasMatrimonio();
}, 60 * 60 * 1000);

// --- MERCADO AVANZADO CON SUBASTAS 🏪 ---
let mercadoItems = []; // { id, vendedor, itemId, nombre, rareza, precioBase, listaEn, estado }
let subastas = []; // { id, vendedor, itemId, nombre, rareza, precioBase, ofertas: [{comprador, monto, fecha}], fin, estado }
let historialTransacciones = []; // { id, vendedor, comprador, itemId, nombre, precio, fecha, tipo }

if (fs.existsSync('mercado_items.json')) {
  try { mercadoItems = JSON.parse(fs.readFileSync('mercado_items.json')); } catch (e) { mercadoItems = []; }
}
if (fs.existsSync('subastas.json')) {
  try { subastas = JSON.parse(fs.readFileSync('subastas.json')); } catch (e) { subastas = []; }
}
if (fs.existsSync('historial_transacciones.json')) {
  try { historialTransacciones = JSON.parse(fs.readFileSync('historial_transacciones.json')).slice(-200); } catch (e) { historialTransacciones = []; }
}

function saveMercadoItems() {
  try { fs.writeFileSync('mercado_items.json', JSON.stringify(mercadoItems, null, 2)); } catch (e) { logger.warn('Error guardando mercado:', e.message); }
}

function saveSubastas() {
  try { fs.writeFileSync('subastas.json', JSON.stringify(subastas, null, 2)); } catch (e) { logger.warn('Error guardando subastas:', e.message); }
}

function saveHistorialTransacciones() {
  try { fs.writeFileSync('historial_transacciones.json', JSON.stringify(historialTransacciones.slice(-500), null, 2)); } catch (e) { logger.warn('Error guardando historial:', e.message); }
}

function crearListadoMercado(vendedor, itemId, nombre, rareza, precio) {
  const listing = {
    id: 'mkt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    vendedor,
    itemId,
    nombre,
    rareza,
    precioBase: precio,
    listaEn: Date.now(),
    estado: 'activo'
  };
  mercadoItems.push(listing);
  saveMercadoItems();
  return listing;
}

function crearSubasta(vendedor, itemId, nombre, rareza, precioBase, duracionMinutos = 60) {
  const subasta = {
    id: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    vendedor,
    itemId,
    nombre,
    rareza,
    precioBase,
    ofertas: [],
    fin: Date.now() + (duracionMinutos * 60 * 1000),
    estado: 'activa'
  };
  subastas.push(subasta);
  saveSubastas();
  return subasta;
}

function procesarSubastasFinalizadas() {
  const ahora = Date.now();
  for (const subasta of subastas) {
    if (subasta.estado === 'activa' && ahora >= subasta.fin) {
      subasta.estado = 'finalizada';
      if (subasta.ofertas.length > 0) {
        const ofertaGanadora = subasta.ofertas[subasta.ofertas.length - 1];
        const vendedor = usuarios[subasta.vendedor];
        const comprador = usuarios[ofertaGanadora.comprador];
        const comision = Math.floor(ofertaGanadora.monto * 0.05); // 5% comisión
        const montoFinal = ofertaGanadora.monto - comision;
        
        if (vendedor) vendedor.dinero = (vendedor.dinero || 0) + montoFinal;
        if (comprador) {
          comprador.dinero = (comprador.dinero || 0) - ofertaGanadora.monto;
          if (!comprador.inventario) comprador.inventario = {};
          comprador.inventario[subasta.itemId] = (comprador.inventario[subasta.itemId] || 0) + 1;
        }
        
        historialTransacciones.push({
          id: 'trx_' + Date.now(),
          vendedor: subasta.vendedor,
          comprador: ofertaGanadora.comprador,
          itemId: subasta.itemId,
          nombre: subasta.nombre,
          precio: ofertaGanadora.monto,
          fecha: Date.now(),
          tipo: 'subasta'
        });
        
        guardarBD();
      }
      saveSubastas();
      saveHistorialTransacciones();
    }
  }
}

// Procesar subastas cada 5 minutos
setInterval(procesarSubastasFinalizadas, 5 * 60 * 1000);

// --------- Mercado / Guerras de Clanes, Misiones dinámicas ---------
let clanWars = [];
let quests = { daily: [], weekly: [], lastDailyRefresh: 0, lastWeeklyRefresh: 0 };
if (fs.existsSync('auctions.json')) {
  try { auctions = JSON.parse(fs.readFileSync('auctions.json')); } catch (e) { auctions = []; }
}
if (fs.existsSync('clanwars.json')) {
  try { clanWars = JSON.parse(fs.readFileSync('clanwars.json')); } catch (e) { clanWars = []; }
}
if (fs.existsSync('quests.json')) {
  try { quests = JSON.parse(fs.readFileSync('quests.json')); } catch (e) { quests = { daily: [], weekly: [], lastDailyRefresh: 0, lastWeeklyRefresh: 0 }; }
}
function saveMarket() { fs.writeFileSync('market.json', JSON.stringify(market, null, 2)); }
function saveAuctions() { fs.writeFileSync('auctions.json', JSON.stringify(auctions, null, 2)); }
function saveClanWars() { fs.writeFileSync('clanwars.json', JSON.stringify(clanWars, null, 2)); }
function saveQuests() { fs.writeFileSync('quests.json', JSON.stringify(quests, null, 2)); }

function genId(prefix) { return prefix + '_' + Math.random().toString(36).slice(2,9); }

// Generar misiones diarias/semana si hace falta
// ===== SISTEMA MEJORADO DE MISIONES DIARIAS Y SEMANALES =====
const MISSION_POOL = {
  daily: [
    { id: 'send_messages', nombre: 'Envía 5 mensajes', target: 5, rewards: { dinero: 500, exp: 50 } },
    { id: 'win_duels', nombre: 'Gana 2 duelos', target: 2, rewards: { dinero: 1000, exp: 100 } },
    { id: 'complete_raids', nombre: 'Completa 1 raid', target: 1, rewards: { dinero: 800, exp: 75 } },
    { id: 'defeat_boss', nombre: 'Derrota 1 jefe', target: 1, rewards: { dinero: 1200, exp: 150 } },
    { id: 'craft_items', nombre: 'Crea 2 items', target: 2, rewards: { dinero: 600, exp: 60 } },
    { id: 'open_chests', nombre: 'Abre 3 cofres', target: 3, rewards: { dinero: 700, exp: 70 } },
    { id: 'trade_mercado', nombre: 'Realiza 1 compra en mercado', target: 1, rewards: { dinero: 400, exp: 40 } },
    { id: 'earn_money', nombre: 'Gana $5000', target: 5000, rewards: { dinero: 300, exp: 30 } }
  ],
  weekly: [
    { id: 'win_duels_w', nombre: 'Gana 10 duelos', target: 10, rewards: { dinero: 5000, exp: 500 } },
    { id: 'complete_raids_w', nombre: 'Completa 5 raids', target: 5, rewards: { dinero: 4500, exp: 450 } },
    { id: 'defeat_boss_w', nombre: 'Derrota 5 jefes', target: 5, rewards: { dinero: 6000, exp: 600 } },
    { id: 'market_sales', nombre: 'Vende 3 items en mercado', target: 3, rewards: { dinero: 3000, exp: 300 } },
    { id: 'craft_items_w', nombre: 'Crea 10 items', target: 10, rewards: { dinero: 2500, exp: 250 } },
    { id: 'earn_money_w', nombre: 'Gana $50000', target: 50000, rewards: { dinero: 2000, exp: 200 } }
  ]
};

function refreshQuestsIfNeeded() {
  const now = Date.now();
  const dayMillis = 24*3600*1000;
  
  // Refrescar misiones diarias
  if (!quests.lastDailyRefresh || now - quests.lastDailyRefresh >= dayMillis) {
    quests.daily = [];
    // Seleccionar 4 misiones diarias aleatorias
    const shuffled = MISSION_POOL.daily.sort(() => Math.random() - 0.5);
    for (let i = 0; i < 4; i++) {
      const mission = shuffled[i];
      quests.daily.push({
        mid: 'd_' + Date.now() + '_' + i,
        ...mission,
        createdAt: now
      });
    }
    quests.lastDailyRefresh = now;
  }
  
  // Refrescar misiones semanales
  if (!quests.lastWeeklyRefresh || now - quests.lastWeeklyRefresh >= 7*24*3600*1000) {
    quests.weekly = [];
    // Seleccionar 3 misiones semanales aleatorias
    const shuffled = MISSION_POOL.weekly.sort(() => Math.random() - 0.5);
    for (let i = 0; i < 3; i++) {
      const mission = shuffled[i];
      quests.weekly.push({
        mid: 'w_' + Date.now() + '_' + i,
        ...mission,
        createdAt: now
      });
    }
    quests.lastWeeklyRefresh = now;
  }
  
  saveQuests();
}

// Refrescar al iniciar
refreshQuestsIfNeeded();

// ===== SISTEMA DE LEADERBOARDS AVANZADOS =====
let leaderboards = {
  dinero: [],
  poder: [],
  duelos: [],
  mercancias: [],
  lastReset: Date.now()
};

if (fs.existsSync('leaderboards.json')) {
  try { leaderboards = JSON.parse(fs.readFileSync('leaderboards.json')); } catch (e) { }
}

function saveLeaderboards() {
  try {
    fs.writeFileSync('leaderboards.json', JSON.stringify(leaderboards, null, 2));
    if (db && typeof db.saveAllLeaderboards === 'function') {
      db.saveAllLeaderboards(leaderboards);
    }
  } catch (e) { logger.error('Error guardando leaderboards:', e); }
}

function actualizarLeaderboards() {
  const now = Date.now();
  
  // Refrescar cada semana (7 días)
  if (now - leaderboards.lastReset >= 7 * 24 * 3600 * 1000) {
    leaderboards = {
      dinero: [],
      poder: [],
      duelos: [],
      mercancias: [],
      lastReset: now
    };
  }
  
  // Compilar datos de todos los usuarios
  const rankings = {
    dinero: [],
    poder: [],
    duelos: [],
    mercancias: []
  };
  
  for (const [userId, user] of Object.entries(usuarios)) {
    if (!user || user.bloqueado) continue;
    
    // Dinero: dinero + banco
    const totalDinero = (user.dinero || 0) + (user.banco || 0);
    rankings.dinero.push({
      userId,
      nombre: user.nombre || 'Anónimo',
      valor: totalDinero,
      badge: 'Multimillonario'
    });
    
    // Poder: stats de poder general
    const poder = (user.poder || 0) + (user.defensa || 0) + (user.vida || 100);
    rankings.poder.push({
      userId,
      nombre: user.nombre || 'Anónimo',
      valor: poder,
      badge: 'Guerrero Supremo'
    });
    
    // Duelos ganados
    const duelosGanados = (user.stats && user.stats.duelWins) || 0;
    rankings.duelos.push({
      userId,
      nombre: user.nombre || 'Anónimo',
      valor: duelosGanados,
      badge: 'Campeón'
    });
    
    // Mercader: items vendidos
    const ventasRealizadas = (user.stats && user.stats.itemsSold) || 0;
    rankings.mercancias.push({
      userId,
      nombre: user.nombre || 'Anónimo',
      valor: ventasRealizadas,
      badge: 'Mercader Legendario'
    });
  }
  
  // Ordenar y guardar top 10
  leaderboards.dinero = rankings.dinero.sort((a, b) => b.valor - a.valor).slice(0, 10);
  leaderboards.poder = rankings.poder.sort((a, b) => b.valor - a.valor).slice(0, 10);
  leaderboards.duelos = rankings.duelos.sort((a, b) => b.valor - a.valor).slice(0, 10);
  leaderboards.mercancias = rankings.mercancias.sort((a, b) => b.valor - a.valor).slice(0, 10);
  leaderboards.lastReset = now;
  
  saveLeaderboards();
}

// Actualizar leaderboards cada 30 minutos
setInterval(actualizarLeaderboards, 30 * 60 * 1000);
actualizarLeaderboards(); // ejecutar al iniciar

// Pending clan creations (espera foto para logo por tiempo limitado)
let pendingClans = {};
if (fs.existsSync('pending_clans.json')) {
  try { pendingClans = JSON.parse(fs.readFileSync('pending_clans.json')); } catch (e) { pendingClans = {}; }
}
function savePendingClans() { fs.writeFileSync('pending_clans.json', JSON.stringify(pendingClans, null, 2)); }
// limpiar pendings expirados cada minuto
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const uid of Object.keys(pendingClans)) {
    if (pendingClans[uid].expiresAt && now > pendingClans[uid].expiresAt) {
      delete pendingClans[uid]; changed = true;
    }
  }
  if (changed) savePendingClans();
}, 60*1000);

// Enviar recibo enriquecido (texto + imagen perfil si existe)
async function sendReceipt(uid, title, lines) {
  // Función mantenida por compatibilidad pero no envía mensajes privados
  // Los datos se registran en logs en su lugar
  try {
    if (!uid || !title || !Array.isArray(lines)) return;
    const message = `[RECEIPT] ${title}: ${lines.join(' | ')}`;
    logger.info(`[sendReceipt] ${message}`);
  } catch (e) { logger.warn('sendReceipt error', e?.message || e); }
}
// Worker de eventos: revisa events.json y procesa eventos finalizados cada minuto
setInterval(() => {
  try {
    const now = Date.now();
    // recargar events desde disco por si la UI los modificó
    try { if (fs.existsSync('events.json')) events = JSON.parse(fs.readFileSync('events.json')); } catch (e) { /* ignore parse errors */ }
    let changed = false;
    for (const ev of events) {
      if (ev.processed) continue;
      if (ev.end && now >= new Date(ev.end).getTime()) {
        // procesar el evento: distribuir recompensas basadas en misiones
        for (const uid in usuarios) {
          const user = usuarios[uid];
          if (!user) continue;
          const counters = user.counters || {};
          let userGotSomething = false;
          // Recolectar recompensas aplicadas por usuario para notificar después
          const rewardLines = [];
          for (const m of ev.missions || []) {
            const id = m.id;
            const target = Number(m.target || 0);
            // soporte para distintos lugares donde guardamos contadores
            const totalMessages = (counters.messages || user.messagesCount || (user.stats && user.stats.messagesCount) || 0);
            const totalDuels = (counters.duelWins || (user.stats && user.stats.duelWins) || user.duelWins || 0);
            const totalRaids = (counters.raidsParticipated || (user.stats && user.stats.raidsParticipated) || user.raidsParticipated || 0);
            const crafted = (counters.craftedItems || user.craftedItems || (user.stats && user.stats.craftedItems) || []);
            const invites = (counters.invites || (user.stats && user.stats.invites) || user.invites || 0);
            let met = false;
            if (id === 'send_messages') met = totalMessages >= target;
            else if (id === 'win_duels') met = totalDuels >= target;
            else if (id === 'complete_raids') met = totalRaids >= target;
            else if (id === 'craft_item') {
              if (m.itemId) {
                met = (Array.isArray(crafted) && crafted.includes(m.itemId));
                if (!met && user.inventario && typeof user.inventario === 'object') {
                  met = (user.inventario[m.itemId] && user.inventario[m.itemId] > 0);
                }
              }
            } else if (id === 'invite_members') met = invites >= target;

            logger.info(`[EVENT_WORKER] Evaluando evento='${ev.name}' misión='${id}' user='${uid}' => met=${met} (msgs=${totalMessages}, duels=${totalDuels}, raids=${totalRaids}, invites=${invites})`);

            if (met) {
              const r = m.rewards || {};
              const coins = Number(r.coins || 0);
              const exp = Number(r.exp || 0);
              const season = Number(r.season || 0);
              if (coins) {
                user.dinero = (user.dinero || 0) + coins;
                rewardLines.push(`💰 +${coins} coins`);
              }
              if (exp) {
                addExp(user, exp);
                rewardLines.push(`📚 +${exp} EXP`);
              }
              if (season) {
                addSeasonPoints(uid, season);
                rewardLines.push(`⏱️ +${season} seasonPoints`);
              }
              userGotSomething = true;
            }
          }
          if (userGotSomething) usuarios[uid] = user;
        }
        ev.processed = true;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync('events.json', JSON.stringify(events, null, 2));
      fs.writeFileSync('usuarios.json', JSON.stringify(usuarios, null, 2));
      guardarBD();
    }
  } catch (e) {
    logger.error('Error procesando eventos:', e);
  }
}, 60 * 1000);

// Generar tarjeta de perfil (SVG -> PNG si sharp disponible)
async function generateProfileCard(user) {
  const nombre = user.nombre || 'Usuario';
  const nivel = user.nivel || 1;
  const poder = user.poder || 0;
  const dinero = user.dinero || 0;
  const curExp = user.exp || 0;
  const need = expToNext(nivel || 1);
  const bar = getProgressBar(curExp, need, 20).replace(/ /g,' ');
  const ach = getAchievementIcons(user);
  // intentar resolver JID del usuario para puntos de temporada
  let uid = null;
  for (const k in usuarios) {
    if (usuarios[k] === user) { uid = k; break; }
  }
  if (!uid && user.id) uid = user.id;
  const seasonPts = (currentSeason && uid && seasons[currentSeason] && seasons[currentSeason].standings && seasons[currentSeason].standings[uid]) ? seasons[currentSeason].standings[uid] : 0;
  const seasonRank = currentSeason ? getSeasonRank(seasonPts).name : '—';
  const clase = user.bestSeasonRank || '—';
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="800" height="420">
    <rect width="100%" height="100%" fill="#0b1226" rx="20" />
    <text x="40" y="70" fill="#fff" font-size="36" font-weight="700">${nombre}</text>
    <text x="40" y="115" fill="#bcd" font-size="18">Nivel ${nivel} • Poder ${poder.toLocaleString()} • $${dinero.toLocaleString()}</text>
    <text x="40" y="160" fill="#fff" font-size="16">EXP: ${curExp} / ${need}</text>
    <text x="40" y="190" fill="#34d399" font-family="monospace" font-size="18">${bar}</text>
    <text x="40" y="230" fill="#ffd700" font-size="22">Logros: ${ach || '—'}</text>
    <text x="40" y="265" fill="#9bd" font-size="18">Clase: ${clase}</text>
    <text x="40" y="295" fill="#9bd" font-size="18">Rango temporada: ${seasonRank} (${seasonPts} pts)</text>
  </svg>`;
  if (sharp) {
    try {
      const buf = Buffer.from(svg);
      const png = await sharp(buf).png().toBuffer();
      return png;
    } catch (e) {
      return null;
    }
  }
  return null;
}



function formatearNumero(num) {
  if (num >= 1000000000000) return (num / 1000000000000).toFixed(1) + 'T';
  if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return num.toString();
}

function procesarInversiones(user, userId) {
  if (!user.inversionesPendientes || user.inversionesPendientes.length === 0) return [];
  const ahora = Date.now();
  const inversionesListas = [];
  const inversionesRestantes = [];
  for (const inversion of user.inversionesPendientes) {
    if (ahora >= inversion.vencimiento) {
      inversionesListas.push(inversion);
      user.dinero += inversion.retorno;
    } else {
      inversionesRestantes.push(inversion);
    }
  }
  user.inversionesPendientes = inversionesRestantes;
  if (inversionesListas.length > 0) guardarBD();
  return inversionesListas;
}

const ADMIN_SUPREMO = "5492915665281@s.whatsapp.net";
const ADMIN_SECUNDARIO = "5492915207066@s.whatsapp.net";

let sentCodes = [];
const loadedCodes = db.getAllCodes();
if (loadedCodes && Object.keys(loadedCodes).length > 0) {
  sentCodes = Object.values(loadedCodes).map(v => v.code || v);
}
function saveCodes() {
  const codesObj = sentCodes.reduce((o, c, i) => { o[i] = { code: c }; return o; }, {});
  db.saveAllCodes(codesObj);
}

// Usar Utils.generateRandomCode(8) en lugar de generarCodigo8Digits()

let adminsSupremos = {};
const loadedAdmins = db.getAllAdmins();
if (loadedAdmins && Object.keys(loadedAdmins).length > 0) {
  adminsSupremos = loadedAdmins;
}
function guardarAdmins() {
  db.saveAllAdmins(adminsSupremos);
}

const TIENDA_ITEMS = {
  armas: [
    // Común: 30 espadas
    ...Array.from({length: 30}, (_, i) => ({ id: `espada_comun_${i+1}`, nombre: `Espada Común ${i+1}`, precio: 1000, poder: 50, rareza: 'Común', descripcion: 'Una espada común pero efectiva', emoji: '🗡️' })),
    // Especial: 29 espadas
    ...Array.from({length: 29}, (_, i) => ({ id: `espada_especial_${i+1}`, nombre: `Espada Especial ${i+1}`, precio: 5000, poder: 150, rareza: 'Especial', descripcion: 'Espada forjada en acero templado', emoji: '⚔️' })),
    // Épica: 25 espadas
    ...Array.from({length: 25}, (_, i) => ({ id: `espada_epica_${i+1}`, nombre: `Espada Épica ${i+1}`, precio: 15000, poder: 400, rareza: 'Épica', descripcion: 'Legendaria katana japonesa', emoji: '🔪' })),
    // Legendaria: 15 espadas
    ...Array.from({length: 15}, (_, i) => ({ id: `espada_legendaria_${i+1}`, nombre: `Espada Legendaria ${i+1}`, precio: 50000, poder: 1000, rareza: 'Legendaria', descripcion: 'Imbuida con fuego de dragón', emoji: '🐉' })),
    // Mítica: 10 espadas
    ...Array.from({length: 10}, (_, i) => ({ id: `espada_mitica_${i+1}`, nombre: `Espada Mítica ${i+1}`, precio: 1000000, poder: 1000000, rareza: 'Mítica', descripcion: 'La espada legendaria del rey Arturo', emoji: '👑' })),
    // Ultra Mítica: 4 espadas
    ...Array.from({length: 4}, (_, i) => ({ id: `espada_ultra_${i+1}`, nombre: `Espada Ultra Mítica ${i+1}`, precio: 5000000, poder: 2500000, rareza: 'Ultra Mítica', descripcion: 'Forjada en materiales cósmicos', emoji: '🌌' })),
    // Hecha por Dioses: 2 espadas
    ...Array.from({length: 2}, (_, i) => ({ id: `espada_dioses_${i+1}`, nombre: `Espada de los Dioses ${i+1}`, precio: 15000000, poder: 5000000, rareza: 'Hecha por Dioses', descripcion: 'Creada por los mismos dioses', emoji: '✨' }))
  ],
  armaduras: [
    { id: 'armadura_cuero', nombre: 'Armadura de Cuero', precio: 2000, defensa: 30, descripcion: 'Protección ligera y flexible', emoji: '🧥' },
    { id: 'armadura_hierro', nombre: 'Armadura de Hierro', precio: 8000, defensa: 100, descripcion: 'Protección sólida de hierro', emoji: '🛡️' },
    { id: 'armadura_titanio', nombre: 'Armadura de Titanio', precio: 25000, defensa: 300, descripcion: 'Ultra resistente y ligera', emoji: '🔰' },
    { id: 'armadura_celestial', nombre: 'Armadura Celestial', precio: 100000, defensa: 800, descripcion: 'Forjada por los dioses', emoji: '✨' },
    { id: 'armadura_infinita', nombre: 'Armadura Infinita', precio: 500000, defensa: 2500, descripcion: 'Protección absoluta', emoji: '💠' }
  ],
  consumibles: [
    { id: 'pocion_vida', nombre: 'Poción de Vida', precio: 500, efecto: 'vida', valor: 100, descripcion: 'Restaura 100 de vida', emoji: '❤️' },
    { id: 'pocion_poder', nombre: 'Poción de Poder', precio: 1000, efecto: 'poder_temp', valor: 200, duracion: 3600000, descripcion: '+200 poder por 1 hora', emoji: '💪' },
    { id: 'elixir_experiencia', nombre: 'Elixir de Experiencia', precio: 3000, efecto: 'exp', valor: 500, descripcion: '+500 de experiencia', emoji: '📚' },
    { id: 'pergamino_suerte', nombre: 'Pergamino de Suerte', precio: 5000, efecto: 'suerte', valor: 2, duracion: 7200000, descripcion: 'x2 suerte por 2 horas', emoji: '🍀' },
    { id: 'cristal_resurrecion', nombre: 'Cristal de Resurrección', precio: 20000, efecto: 'revivir', valor: 1, descripcion: 'Revive si pierdes un duelo', emoji: '💎' }
  ],
  especiales: [
    { id: 'ticket_loteria', nombre: 'Ticket de Lotería', precio: 2500, efecto: 'loteria', descripcion: 'Participa en la lotería diaria', emoji: '🎫' },
    { id: 'caja_misteriosa', nombre: 'Caja Misteriosa', precio: 10000, efecto: 'misterio', descripcion: 'Contiene items aleatorios', emoji: '📦' },
    { id: 'boost_trabajo', nombre: 'Boost de Trabajo', precio: 15000, efecto: 'trabajo_x2', duracion: 86400000, descripcion: 'x2 ganancias trabajo 24h', emoji: '💼' },
    { id: 'escudo_robo', nombre: 'Escudo Anti-Robo', precio: 25000, efecto: 'proteccion', duracion: 172800000, descripcion: 'Protege de robos 48h', emoji: '🛡️' },
    { id: 'onza_oro', nombre: 'Onza de Oro', precio: 50000, efecto: 'inversion', descripcion: 'Se puede vender a mejor precio', emoji: '🪙' }
  ],
  clan: [
    { id: 'banner_clan', nombre: 'Banner de Clan', precio: 30000, efecto: 'decoracion', descripcion: 'Banner personalizado para tu clan', emoji: '🚩' },
    { id: 'expansion_miembros', nombre: 'Expansión de Miembros', precio: 75000, efecto: 'expansion', valor: 5, descripcion: '+5 slots de miembros', emoji: '👥' },
    { id: 'fortaleza_clan', nombre: 'Fortaleza de Clan', precio: 150000, efecto: 'defensa_clan', valor: 500, descripcion: '+500 defensa al clan', emoji: '🏰' },
    { id: 'estandarte_guerra', nombre: 'Estandarte de Guerra', precio: 100000, efecto: 'poder_clan', valor: 1000, descripcion: '+1000 poder al clan', emoji: '⚔️' },
    { id: 'tesoro_clan', nombre: 'Cofre del Tesoro', precio: 200000, efecto: 'banco_clan', valor: 50000, descripcion: '+50k capacidad banco clan', emoji: '💰' }
  ]
};

let estadisticasTienda = {};
const loadedStats = db.getAllStatsTienda();
if (loadedStats && Object.keys(loadedStats).length > 0) {
  estadisticasTienda = loadedStats;
}

// ===== CONFIGURACIÓN CARGADA DESDE config/ =====
// QUESTS, FACCIONES, DUNGEONS, MONTURAS se cargan al inicio del archivo

function guardarEstadisticasTienda() {
  try {
    db.saveAllStatsTienda(estadisticasTienda);
  } catch (e) {
    logger.warn('Error guardando estadisticasTienda:', e.message);
  }
}

function obtenerEspadasPorRareza(rareza) {
  return TIENDA_ITEMS.armas.filter(e => e.rareza === rareza);
}

// Posesiones de espadas integradas en objeto usuario
// (No necesita persistencia separada)

function guardarPosesionesEspadas() {
  // Integrada en guardarBD() con usuarios
}

function obtenerCategoriasTienda() {
  return Object.keys(TIENDA_ITEMS);
}

function obtenerItemsPorCategoria(categoria) {
  return TIENDA_ITEMS[categoria] || [];
}

function buscarItem(itemId) {
  for (const categoria of Object.keys(TIENDA_ITEMS)) {
    const item = TIENDA_ITEMS[categoria].find(i => i.id === itemId);
    if (item) return { ...item, categoria };
  }
  return null;
}

function generarIdClan() {
  return 'clan_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function obtenerClanDeUsuario(userId) {
  for (const clanId of Object.keys(clanes)) {
    const clan = clanes[clanId];
    if (!clan) continue;
    const miembros = Array.isArray(clan.miembros) ? clan.miembros : [];
    if (clan.lider === userId || miembros.includes(userId)) {
      return { ...clan, id: clanId };
    }
  }
  return null;
}

function calcularPoderClan(clanId) {
  const clan = clanes[clanId];
  if (!clan) return 0;
  let poderTotal = 0;
  const miembros = Array.isArray(clan.miembros) ? clan.miembros : [];
  const todosLosMiembros = [clan.lider, ...miembros];
  for (const miembroId of todosLosMiembros) {
    if (usuarios[miembroId]) {
      poderTotal += usuarios[miembroId].poder || 0;
    }
  }
  poderTotal += clan.poderExtra || 0;
  return poderTotal;
}

function obtenerRankingClanes() {
  const clanesConPoder = Object.entries(clanes).map(([id, clan]) => ({
    id,
    ...clan,
    poderTotal: calcularPoderClan(id)
  }));
  return clanesConPoder.sort((a, b) => b.poderTotal - a.poderTotal);
}

let isReconnecting = false;
let currentSocket = null;
let pairingRequested = false;
let salesVerifierInterval = null;

async function startBot() {
  if (currentSocket) {
    currentSocket.ev.removeAllListeners();
    currentSocket.end();
  }
  if (salesVerifierInterval) {
    clearInterval(salesVerifierInterval);
    salesVerifierInterval = null;
  }
  pairingRequested = false;

  const { state, saveCreds: baileysSaveCreds } = await useMultiFileAuthState("auth");
  // Asegurar que la carpeta auth/ exista y sea escribible
  try {
    const authDir = path.join(process.cwd(), 'auth');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  } catch (e) {
    logger.warn('⚠️ No se pudo asegurar auth/ directory:', e?.message || e);
  }
  // Envolver saveCreds para obtener logging y capturar errores de persistencia
  async function saveCredsWrapper() {
    try {
      await baileysSaveCreds();
      try {
        const files = fs.readdirSync(path.join(process.cwd(), 'auth'));
        logger.info('✅ Credenciales guardadas en auth/. Archivos:', files.join(', ') || '(vacío)');
      } catch (e) {
        logger.info('✅ Credenciales intentadas guardar (no se pudo listar auth/):', e?.message || e);
      }
    } catch (e) {
      logger.warn('❌ Error guardando credenciales (saveCreds):', e?.message || e);
    }
  }
  // Obtener la versión más reciente de WA Web para la conexión (ayuda a evitar fallos 401/handshake)
  let waVersion = undefined;
  try {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    logger.info('Usando versión WA Web:', version.join('.'));
  } catch (e) {
    logger.warn('No se pudo obtener versión WA Web, usando la por defecto:', e.message);
  }

  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: false,
    version: waVersion,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false
  });

  currentSocket = sock;
  // Control global: si true, el bot sólo enviará mensajes cuando haya un contexto (ej. { quoted: msg })
  // Para permitir envíos automáticos desde código explícito, pasar opciones { forceAllow: true }
  const RESPOND_ONLY_ON_COMMANDS = true;
  try {
    const _origSend = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, message, options = {}) => {
      try {
        if (RESPOND_ONLY_ON_COMMANDS) {
          const allowed = options && (options.quoted || options.contextInfo || options.forceAllow);
          if (!allowed) {
            // No enviar: log breve para depuración
            logger.info('Bloqueado envío automático a', jid, '- use { forceAllow: true } para forzar.');
            return { status: 'blocked' };
          }
        }
      } catch (e) { /* si falla la comprobación, no bloquear por seguridad */ }
      return _origSend(jid, message, options);
    };
  } catch (e) { logger.warn('No se pudo parchear sendMessage para limitar envíos:', e?.message || e); }
  try {
    sock.ev.on("creds.update", saveCredsWrapper);
  } catch (e) {
    logger.warn('⚠️ No pude registrar listener de creds.update:', e?.message || e);
  }

  // Log breve de updates de conexión para depuración (muestra estados: connecting/open/close/error)
  try {
    sock.ev.on('connection.update', (u) => {
      try { logger.info('🔁 connection.update', u.connection || u); } catch (e) {}
    });
  } catch (e) {}

  // Si no está registrado, iniciar el proceso de emparejado según PAIRING_METHOD
  // Añadimos `FORCE_PAIR_CODE=true` para forzar el flujo de emparejado por código en desarrollo
  let pairingMode = null;
  if ((process.env.FORCE_PAIR_CODE === 'true' || !state.creds?.registered) && !pairingRequested) {
    pairingRequested = true;
    const method = (process.env.PAIRING_METHOD || 'code').toLowerCase();
    pairingMode = method;
    // Mostrar cualquier pairingCode ya guardado para que el usuario lo pueda usar inmediatamente
    try {
      const credsPath = path.join(process.cwd(), 'auth', 'creds.json');
      if (fs.existsSync(credsPath)) {
        const rawCreds = fs.readFileSync(credsPath, 'utf8');
        try {
          const parsedCreds = JSON.parse(rawCreds);
          if (parsedCreds?.pairingCode) logger.info('🔎 pairingCode encontrado en auth/creds.json:', parsedCreds.pairingCode);
        } catch (e) { /* ignore parse errors */ }
      }
    } catch (e) { /* ignore */ }
    const rawPairingNumber = process.env.PAIRING_NUMBER || '5492915665281';
    let phoneNumber = '5492915665281';
    try {
      phoneNumber = String(rawPairingNumber).replace(/\D+/g, '');
      if (!phoneNumber) {
        logger.info('⚠️ PAIRING_NUMBER vacío tras normalizar; usando por defecto 5492915665281');
        phoneNumber = '5492915665281';
      }
    } catch (e) {
      phoneNumber = '5492915665281';
    }
    logger.info('🔧 DEBUG: pairing phoneNumber normalized ->', phoneNumber);
    if (method === 'code') {
      logger.info('\n🔗 Emparejado por código seleccionado. No solicitaré el código hasta que la conexión esté \"open\".');
      logger.info('📱 Número de pairing (normalizado):', phoneNumber);
      logger.info('🔧 DEBUG: FORCE_PAIR_CODE=', process.env.FORCE_PAIR_CODE || 'false');
      logger.info('🔧 DEBUG: PAIRING_METHOD=', process.env.PAIRING_METHOD || 'undefined');
      // pairingRequested ya está en true, esperaremos connection.update === 'open' para solicitar el código
    } else {
      logger.info("\n🔗 Esperando QR para emparejar (se imprimirá en terminal)...");
      logger.info("📱 Ve a WhatsApp > Configuración > Dispositivos vinculados > Vincular dispositivo y escanea el QR");
    }
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      if (pairingMode === 'code') {
        logger.info('ℹ️ Se recibió QR mientras pairingMode=code; mostrando QR como fallback.');
      }
      if (qrcode) {
        qrcode.generate(qr, { small: true });
      } else {
        logger.info('QR (texto):', qr);
      }
      // Intentar guardar el QR como imagen PNG y como texto para facilitar el escaneo desde otro dispositivo
      try {
        const authDir = path.join(process.cwd(), 'auth');
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        const txtPath = path.join(authDir, 'qr.txt');
        try { fs.writeFileSync(txtPath, qr); } catch (e) { logger.warn('No se pudo guardar auth/qr.txt:', e.message); }
        if (qrcodeImageLib) {
          const pngPath = path.join(authDir, 'qr.png');
          try {
            await qrcodeImageLib.toFile(pngPath, qr, { width: 480 });
            logger.info('📷 QR guardado en', pngPath, ' — ábrelo y escanéalo con tu teléfono.');
          } catch (e) {
            logger.warn('No se pudo generar imagen QR:', e.message);
          }
        } else {
          logger.info('Para generar una imagen QR instala el paquete "qrcode" (npm i qrcode).');
        }
      } catch (e) {
        logger.warn('Error guardando QR en disco:', e.message);
      }
      logger.info('Escanea el QR desde WhatsApp > Dispositivos vinculados');
    }
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.info("❌ Conexión cerrada debido a:", lastDisconnect?.error);
      if (salesVerifierInterval) {
        clearInterval(salesVerifierInterval);
        salesVerifierInterval = null;
      }
      if (statusCode === 401) {
        logger.info("🔐 Sesión expirada, limpiando autenticación...");
        pairingRequested = false;
        try {
          const authDir = path.join(process.cwd(), 'auth');
          if (fs.existsSync(authDir)) {
            const files = fs.readdirSync(authDir);
            for (const f of files) {
              const p = path.join(authDir, f);
              try { fs.unlinkSync(p); } catch (e) { /* ignore individual unlink errors */ }
            }
            logger.info('🧹 auth/ limpiado para forzar nuevo emparejado.');
          }
        } catch (e) {
          logger.warn('No se pudo limpiar auth/:', e.message);
        }
        // reiniciar para iniciar flujo de emparejado nuevo
        setTimeout(() => startBot(), 1200);
      } else if (!isReconnecting) {
        logger.info("🔄 Reconectando...");
        isReconnecting = true;
        setTimeout(() => {
          isReconnecting = false;
          startBot();
        }, 3000);
      }
    } else if (connection === "open") {
      logger.info("✅ ¡Bot conectado exitosamente a WhatsApp!");
      isReconnecting = false;
      try {
        const authDir = path.join(process.cwd(), 'auth');
        const files = fs.existsSync(authDir) ? fs.readdirSync(authDir) : [];
        logger.info('ℹ️ auth/ contiene:', files.join(', ') || '(vacío)');
        logger.info('ℹ️ state.creds.registered =', !!state?.creds?.registered);
      } catch (e) {
        logger.warn('⚠️ No se pudo listar auth/ tras open:', e?.message || e);
      }
      // Si estamos en modo pairing por código, solicitar el código sólo cuando la conexión esté OPEN
      try {
        if (pairingMode === 'code' && pairingRequested && !state.creds?.registered) {
          logger.info('🔔 connection is open y pairingMode=code -> solicitando pairing code ahora');
          const rawPairingNumber = process.env.PAIRING_NUMBER || '5492915665281';
          const phoneNumber = String(rawPairingNumber).replace(/\D+/g, '') || '5492915665281';
          // Esperar un poco tras open para evitar race conditions que cierran el WebSocket
          await new Promise(r => setTimeout(r, 1000));
          if (typeof sock.requestPairingCode === 'function') {
            try {
              logger.info('🔧 DEBUG: typeof sock.requestPairingCode =', typeof sock.requestPairingCode);
              await new Promise(r => setTimeout(r, 1000));
              const code = await sock.requestPairingCode(phoneNumber);
              logger.info('🎯 CÓDIGO DE EMPAREJAMIENTO (8 dígitos):', code);
              logger.info('💬 Usa este código en WhatsApp > Dispositivos vinculados > Vincular dispositivo');
              pairingRequested = false;
            } catch (e) {
              logger.info('❌ Error pidiendo pairingCode tras open (post-wait):', e?.message || e);
            }
          } else {
            // fallback: leer pairingCode desde state.creds o auth/creds.json
            const existing = state?.creds?.pairingCode;
            if (existing) {
              logger.info('🎯 CÓDIGO DE EMPAREJAMIENTO (desde state.creds):', existing);
              pairingRequested = false;
            } else {
              try {
                const credsPath = path.join(process.cwd(), 'auth', 'creds.json');
                if (fs.existsSync(credsPath)) {
                  const raw = fs.readFileSync(credsPath, 'utf8');
                  try {
                    const parsed = JSON.parse(raw);
                    if (parsed?.pairingCode) {
                      logger.info('🎯 CÓDIGO DE EMPAREJAMIENTO (desde auth/creds.json):', parsed.pairingCode);
                      pairingRequested = false;
                    } else {
                      // generar pairingCode de fallback y guardarlo
                      try {
                        const gen = generarCodigo8Digits();
                        parsed.pairingCode = gen;
                        fs.writeFileSync(credsPath, JSON.stringify(parsed, null, 2));
                        logger.info('🎯 pairingCode de fallback generado y guardado en auth/creds.json:', gen);
                        pairingRequested = false;
                      } catch (e) { logger.warn('⚠️ No pude generar pairingCode de fallback:', e.message); }
                    }
                  } catch (e) { /* ignore parse error */ }
                }
              } catch (e) { logger.warn('⚠️ Fallback leyendo auth/creds.json falló:', e.message); }
            }
          }
        }
      } catch (e) {
        logger.warn('Error en flujo de pairing tras open:', e?.message || e);
      }
      if (!salesVerifierInterval) {
        salesVerifierInterval = setInterval(() => {
          const ahora = Date.now();
          let ventasRealizadas = false;
          Object.entries(usuarios).forEach(([userId, user]) => {
            if (user.ventasPendientes && user.ventasPendientes.length > 0) {
              const ventasOriginales = user.ventasPendientes.length;
              user.ventasPendientes = user.ventasPendientes.filter(venta => {
                if (ahora >= venta.tiempoVenta) {
                  if (venta.item === 'onzaOro' && user.inventario && user.inventario.onzaOro > 0) {
                    user.inventario.onzaOro -= 1;
                    user.dinero += venta.precio;
                    ventasRealizadas = true;
                  }
                  return false;
                }
                return true;
              });
              if (user.ventasPendientes.length !== ventasOriginales) ventasRealizadas = true;
            }
          });
          if (ventasRealizadas) guardarBD();
        }, 60000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    // Evitar procesar mensajes duplicados (múltiples eventos para la misma id)
    try {
      let dedupKey = null;
      if (msg.key && msg.key.id) {
        dedupKey = `${msg.key.remoteJid || 'unknown'}_${msg.key.id}`;
      } else {
        // fallback: usar chat + remitente + timestamp + fragmento del cuerpo
        const fallbackBody = (msg.message && (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption)) || '';
        const ts = (msg.messageTimestamp || msg.message?.timestamp || msg.timestamp || 0);
        dedupKey = `${msg.key && msg.key.remoteJid ? msg.key.remoteJid : 'unknown'}_${msg.key && (msg.key.participant || msg.key.remoteJid) ? (msg.key.participant || msg.key.remoteJid) : 'unknown'}_${ts}_${fallbackBody.slice(0,80)}`;
      }
      if (dedupKey) {
        if (processedMessageIds.has(dedupKey)) return;
        processedMessageIds.set(dedupKey, Date.now());
      }
    } catch (e) { /* no bloquear por errores de deduplicación */ }

    // Ignorar mensajes antiguos (previos al arranque del bot) y mensajes sin timestamp
    const msgTimestamp = (msg.messageTimestamp || msg.message?.timestamp || msg.timestamp || 0) * 1000;
    if (!msgTimestamp || msgTimestamp < botStartTime) return;
    // Ignorar mensajes originados por el propio socket/bot
    if (msg.key && msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const senderId = msg.key.participant || chatId;
    let user = usuarios[senderId];

      // Manejo: si existe una petición pendiente de crear clan y se recibe una imagen, procesarla
      try {
        if (msg.message.imageMessage && pendingClans[senderId]) {
          const pending = pendingClans[senderId];
          if (Date.now() > pending.expiresAt) {
            delete pendingClans[senderId]; savePendingClans();
            try {
              if (chatId && chatId.endsWith('@g.us')) {
                await sock.sendMessage(chatId, { text: `⏳ @${senderId.split('@')[0]} tu solicitud de creación de clan expiró. Usa #crearclan [nombre] para iniciar de nuevo.`, mentions: [senderId] }, { quoted: msg });
              }
            } catch (e) {}
            } else {
              // confirmar fondos antes de crear
            const costo = pending.costo || 50000;
            if (!usuarios[senderId] || (usuarios[senderId].dinero || 0) < costo) {
              delete pendingClans[senderId]; savePendingClans();
              try {
                  if (chatId && chatId.endsWith('@g.us')) {
                    await sock.sendMessage(chatId, { text: `❌ Fondos insuficientes para confirmar. Solicitud cancelada.`, mentions: [senderId] }, { quoted: msg });
                  }
              } catch (e) {}
            } else {
              // consumir dinero, crear clan y guardar logo (validar/recortar si sharp disponible)
              usuarios[senderId].dinero -= costo;
              const clanId = generarIdClan();
              const nombreClan = pending.nombre;
              clanes[clanId] = {
                nombre: nombreClan,
                lider: senderId,
                miembros: [],
                banco: 0,
                capacidadBanco: 100000,
                maxMiembros: pending.maxMiembros || 10,
                poderExtra: 0,
                defensaExtra: 0,
                fechaCreacion: Date.now(),
                descripcion: pending.descripcion || null,
                invitaciones: []
              };
              usuarios[senderId].clanId = clanId;
              // guardar logo
              try {
                const logosDir = path.join(process.cwd(), 'clan_logos');
                if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir, { recursive: true });
                let buffer = await downloadMediaMessage(msg);
                const logoPath = path.join(logosDir, `${clanId}.png`);
                if (sharp) {
                  try {
                    const png = await sharp(buffer).resize(512, 512, { fit: 'cover' }).png().toBuffer();
                    fs.writeFileSync(logoPath, png);
                  } catch (e) {
                    // fallback to raw buffer
                    fs.writeFileSync(logoPath, buffer);
                  }
                } else {
                  fs.writeFileSync(logoPath, buffer);
                }
                clanes[clanId].logo = `clan_logos/${clanId}.png`;
              } catch (e) {
                logger.warn('No se pudo guardar logo del clan:', e?.message || e);
              }
              guardarClanes(); guardarBD(); savePendingClans();
              delete pendingClans[senderId];
              try {
                if (chatId && chatId.endsWith('@g.us')) {
                  await sock.sendMessage(chatId, { text: `✅ @${senderId.split('@')[0]} clan creado: *${nombreClan}* — Logo guardado. ¡Felicidades!`, mentions: [senderId] }, { quoted: msg });
                }
              } catch (e) {}
            }
          }
        }
      } catch (e) { logger.warn('Error manejando imagen para clan pendiente:', e); }

    if (chatId.includes("status@broadcast") || chatId.includes("@newsletter")) return;

    // Registrar estadísticas de mensajes por chat
    try {
      if (!chatStats[chatId]) chatStats[chatId] = { totalMessages: 0, firstSeen: Date.now() };
      chatStats[chatId].totalMessages = (chatStats[chatId].totalMessages || 0) + 1;
      saveChatStats();
    } catch (e) {
      logger.warn('No se pudo actualizar chatStats:', e.message);
    }

    // Chequear si el remitente está muteado en este grupo; si lo está, eliminar su mensaje
    try {
      if (chatId && chatId.endsWith('@g.us') && mutes[chatId] && mutes[chatId][senderId]) {
        const until = mutes[chatId][senderId].until;
        if (Date.now() < until) {
          try {
            await sock.sendMessage(chatId, { delete: msg.key }, { forceAllow: true });
            // incrementar contador de mensajes eliminados (si el usuario está registrado)
            if (user) {
              if (!user.mensajesEliminados) user.mensajesEliminados = {};
              user.mensajesEliminados[chatId] = (user.mensajesEliminados[chatId] || 0) + 1;
              const count = user.mensajesEliminados[chatId];
              const tiempoRestante = Math.ceil((until - Date.now()) / 1000);
              const minutos = Math.ceil(tiempoRestante / 60);
              
              if (count === 15) {
                await sock.sendMessage(chatId, { text: `⚠️ *ADVERTENCIA CRÍTICA* ⚠️\n\n@${senderId.split('@')[0]}\n\nHas alcanzado *15 mensajes* mientras estabas *SILENCIADO*.\n\n*Te quedan solo 5 mensajes* antes de ser expulsado del grupo.\n\n⏱️ Tiempo de silencio: *${minutos} minutos restantes*\n\n⛔ Si alcanzas 20 mensajes, serás eliminado automáticamente.`, mentions: [senderId] });
              } else if (count === 18) {
                await sock.sendMessage(chatId, { text: `🔴 *ÚLTIMO AVISO* 🔴\n\n@${senderId.split('@')[0]}\n\n*¡ESTÁS POR EXCEDER EL LÍMITE!*\n\nMensajes: *${count}/20*\n\n*Solo te quedan 2 intentos* antes de la expulsión.\n\n🚫 Si envías 2 mensajes más, serás eliminado automáticamente del grupo.`, mentions: [senderId] });
              } else if (count >= 20) {
                try {
                  await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
                  await sock.sendMessage(chatId, { text: `*🚫 USUARIO EXPULSADO 🚫*\n\n@${senderId.split('@')[0]} ha sido eliminado del grupo por *exceder 20 mensajes mientras estaba silenciado*.\n\n*Razón:* Violación del sistema de mute.\n\nℹ️ Contacta con un administrador si fue un error.`, mentions: [senderId] });
                  try { addHistorialNegro(senderId, 'Expulsado', 'Exceso de mensajes silenciado (20/20)'); } catch (e) {}
                } catch (e) {
                  logger.warn('No se pudo eliminar usuario:', e.message);
                }
              }
              guardarBD();
            }
          } catch (delErr) {
            logger.warn('No se pudo eliminar mensaje de usuario muteado:', delErr.message);
          }
          return; // no procesar comandos del usuario muteado
        } else {
          // mute expirado, limpiar
          delete mutes[chatId][senderId];
          if (user && user.mensajesEliminados && user.mensajesEliminados[chatId]) {
            delete user.mensajesEliminados[chatId];
            guardarBD();
          }
          saveMutes();
        }
      }
    } catch (e) {
      logger.warn('Error comprobando mutes:', e.message);
    }

    // Eliminar mensajes con fotos SOLO si el remitente está muteado en este grupo
    if (msg.message.imageMessage && !msg.key.fromMe) {
      try {
        if (chatId && chatId.endsWith('@g.us') && mutes[chatId] && mutes[chatId][senderId]) {
          const untilImg = mutes[chatId][senderId].until;
          if (Date.now() < untilImg) {
            await sock.sendMessage(chatId, { delete: msg.key }, { forceAllow: true });
            // incrementar contador de mensajes eliminados (si el usuario está registrado)
            if (user) {
              if (!user.mensajesEliminados) user.mensajesEliminados = {};
              user.mensajesEliminados[chatId] = (user.mensajesEliminados[chatId] || 0) + 1;
              const count = user.mensajesEliminados[chatId];
              const tiempoRestante = Math.ceil((untilImg - Date.now()) / 1000);
              const minutos = Math.ceil(tiempoRestante / 60);
              
              if (count === 15) {
                await sock.sendMessage(chatId, { text: `⚠️ *ADVERTENCIA CRÍTICA* ⚠️\n\n@${senderId.split('@')[0]}\n\nHas alcanzado *15 mensajes* mientras estabas *SILENCIADO*.\n\n*Te quedan solo 5 mensajes* antes de ser expulsado del grupo.\n\n⏱️ Tiempo de silencio: *${minutos} minutos restantes*\n\n⛔ Si alcanzas 20 mensajes, serás eliminado automáticamente.`, mentions: [senderId] });
              } else if (count === 18) {
                await sock.sendMessage(chatId, { text: `🔴 *ÚLTIMO AVISO* 🔴\n\n@${senderId.split('@')[0]}\n\n*¡ESTÁS POR EXCEDER EL LÍMITE!*\n\nMensajes: *${count}/20*\n\n*Solo te quedan 2 intentos* antes de la expulsión.\n\n🚫 Si envías 2 mensajes más, serás eliminado automáticamente del grupo.`, mentions: [senderId] });
              } else if (count >= 20) {
                try {
                  await sock.groupParticipantsUpdate(chatId, [senderId], 'remove');
                  await sock.sendMessage(chatId, { text: `*🚫 USUARIO EXPULSADO 🚫*\n\n@${senderId.split('@')[0]} ha sido eliminado del grupo por *exceder 20 mensajes mientras estaba silenciado*.\n\n*Razón:* Violación del sistema de mute.\n\nℹ️ Contacta con un administrador si fue un error.`, mentions: [senderId] });
                  try { addHistorialNegro(senderId, 'Expulsado', 'Exceso de mensajes silenciado (20/20)'); } catch (e) {}
                } catch (e) {
                  logger.warn('No se pudo eliminar usuario:', e.message);
                }
              }
              guardarBD();
            }
            return;
          }
        }
      } catch (delErr) {
        logger.warn('No se pudo eliminar mensaje con foto:', delErr.message);
      }
    }

    const body = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption ||
                 msg.message.videoMessage?.caption;
    if (!body) return;

    // Registrar comportamiento/memoria social en TODOS los mensajes (no solo comandos)
    try { recordMessageBehavior(msg, chatId, senderId); } catch (e) { logger.warn('recordMessageBehavior fallo:', e.message); }

    // --- ANTI-ABUSO: chequear mute ---
    // El envío de mensajes automáticos sobre silencios se eliminó para evitar spam.
    // Si existen mutes aplicados manualmente, no se notificará ni se bloqueará automáticamente aquí.

    // --- ANTI-ABUSO: detectar abuso en comandos ---
    if (user) {
      // Inicializar mochila y fragmentos
      if (!user.mochila) user.mochila = { cofre_comun: 0, cofre_raro: 0, cofre_mitologico: 0, llave_comun: 0, llave_dorada: 0, llave_mitologica: 0 };
      if (!user.fragmentos) user.fragmentos = {};
      if (!user.inventario) user.inventario = {};
      if (!user.equipo) user.equipo = { weapon: null };
      // Inicializar sistemas nuevos
      if (!user.quests) user.quests = {};
      if (!user.faccion) user.faccion = null;
      if (!user.reputacionFaccion) user.reputacionFaccion = 0;
      if (!user.battlePass) user.battlePass = { tier: 0, puntos: 0, recompensasReclamadas: 0 };
      if (!user.dungeonProgress) user.dungeonProgress = { completados: [], enProgreso: null, nivelActual: 0 };
      if (!user.montura) user.montura = null;
      if (!user.monturas) user.monturas = [];
      // Inicializar contadores para quests
      if (!user.questCounters) user.questCounters = { dinero_total: 0, bosses_derrotados: 0, items_comprados: 0, duelos_ganados: 0, trabajos_realizados: 0 };
          // --- COMANDOS MOCHILA, INVENTARIO, ABRIR, VENDER ---
                if (body === '#mochila') {
            const m = user.mochila;
            let txt = '🎒 MOCHILA:\n';
            txt += `Cofre Común: ${m.cofre_comun} | Cofre Raro: ${m.cofre_raro} | Cofre Mitológico: ${m.cofre_mitologico}\n`;
            txt += `Llave Común: ${m.llave_comun} | Llave Dorada: ${m.llave_dorada} | Llave Mitológica: ${m.llave_mitologica}`;
            await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
            return;
          }
          if (body === '#fragmentos' || body === '#invfrag') {
            const inv = user.fragmentos;
            let txt = '📦 INVENTARIO DE FRAGMENTOS:\n';
            for (const fid in inv) {
              const f = getFragmentoById(fid);
              if (f) {
                let rarezaIcon = '';
                if (f.rareza === 'comun') rarezaIcon = '🔹';
                else if (f.rareza === 'poco_comun') rarezaIcon = '🔸';
                else if (f.rareza === 'raro') rarezaIcon = '🔵';
                else if (f.rareza === 'epico') rarezaIcon = '🟣';
                else if (f.rareza === 'legendario') rarezaIcon = '🟡';
                else if (f.rareza === 'mitico') rarezaIcon = '🔴';
                else if (f.rareza === 'ultra_mitico') rarezaIcon = '🔥';
                else if (f.rareza === 'ancestral') rarezaIcon = '🗿';
                else if (f.rareza === 'divino') rarezaIcon = '✨';
                else if (f.rareza === 'eterno') rarezaIcon = '♾️';
                else if (f.rareza === 'primordial') rarezaIcon = '🌌';
                else if (f.rareza === 'prohibido') rarezaIcon = '☠️';
                else if (f.rareza === 'absoluto') rarezaIcon = '👁️';
                txt += `${rarezaIcon} ${f.nombre} (${f.rareza}) x${inv[fid]} — Valor: ${precioFinal(f)}\n`;
              }
            }
            if (txt === '📦 INVENTARIO DE FRAGMENTOS:\n') txt += 'Vacío.';
            await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
            return;
          }
          if (body.startsWith('#abrir ')) {
            const tipo = body.split(' ')[1];
            let cofreKey = '';
            if (tipo === 'comun') cofreKey = 'cofre_comun';
            if (tipo === 'raro') cofreKey = 'cofre_raro';
            if (tipo === 'mitologico') cofreKey = 'cofre_mitologico';
            if (!cofreKey || user.mochila[cofreKey] <= 0) {
              await sock.sendMessage(chatId, { text: 'No tienes ese cofre.' }, { quoted: msg });
              return;
            }
            // Requisitos de llaves
            if (tipo === 'comun' && user.mochila.llave_comun < 3) {
              await sock.sendMessage(chatId, { text: '❌ Necesitas 3 Llaves Comunes' }, { quoted: msg });
              return;
            }
            if (tipo === 'raro' && user.mochila.llave_dorada < 5) {
              await sock.sendMessage(chatId, { text: '❌ Necesitas 5 Llaves Doradas' }, { quoted: msg });
              return;
            }
            if (tipo === 'mitologico' && (user.mochila.llave_comun < 5 || user.mochila.llave_dorada < 5 || user.mochila.llave_mitologica < 1)) {
              await sock.sendMessage(chatId, { text: '❌ Necesitas: 5 Comunes, 5 Doradas, 1 Mitológica' }, { quoted: msg });
              return;
            }
            // Consumir cofres y llaves
            user.mochila[cofreKey]--;
            if (tipo === 'comun') user.mochila.llave_comun -= 3;
            if (tipo === 'raro') user.mochila.llave_dorada -= 5;
            if (tipo === 'mitologico') { user.mochila.llave_comun -= 5; user.mochila.llave_dorada -= 5; user.mochila.llave_mitologica -= 1; }
            // Drop fragmentos según rareza
            let posibles = [];
            if (tipo === 'comun') posibles = fragmentosData.fragmentos.filter(f => ['comun','poco_comun','raro'].includes(f.rareza));
            if (tipo === 'raro') posibles = fragmentosData.fragmentos.filter(f => ['raro','epico','legendario','mitico'].includes(f.rareza));
            if (tipo === 'mitologico') posibles = fragmentosData.fragmentos.filter(f => ['divino','eterno','primordial','prohibido','absoluto'].includes(f.rareza));
            // Probabilidad extrema para rarezas altas
            let drop = null;
            if (tipo === 'comun') drop = posibles[Math.floor(Math.random()*8)];
            if (tipo === 'raro') drop = posibles[Math.floor(Math.random()*posibles.length)];
            if (tipo === 'mitologico') drop = posibles[Math.floor(Math.random()*posibles.length* Math.random() * Math.random())];
            if (!drop) drop = posibles[0];
            user.fragmentos[drop.id] = (user.fragmentos[drop.id]||0) + 1;
            guardarBD();
            let feedback = `¡Abriste un cofre y obtuviste: ${drop.nombre} (${drop.rareza})!`;
            let viral = false;
            if (['ultra_mitico','ancestral','divino','eterno','primordial','prohibido','absoluto'].includes(drop.rareza)) {
              feedback += '\n🌟 ¡Has conseguido un fragmento extremadamente raro!';
              viral = true;
              if (drop.rareza === 'absoluto') feedback += '\n👁️ ¡Fragmento Absoluto! Esto es leyenda viva. No se puede vender.';
            }
            await sock.sendMessage(chatId, { text: feedback }, { quoted: msg });
            // Anuncio global viral
            if (viral) {
              let globalMsg = `🚨 ¡${user.nombre || senderId.split('@')[0]} acaba de obtener un fragmento ${drop.rareza.toUpperCase()} (${drop.nombre})!`;
              if (drop.rareza === 'absoluto') globalMsg += '\n👁️ ¡Fragmento Absoluto! Leyenda viva desbloqueada.';
              // Enviar a todos los chats activos (puedes ajustar el array de chats)
              for (const cid of Object.keys(usuarios)) {
                if (cid !== chatId) {
                  try { await sock.sendMessage(cid, { text: globalMsg }, { forceAllow: true }); } catch(e){}
                }
              }
            }
            // Registrar logro visual (puedes expandir esto para un sistema de logros)
            if (!user.logros) user.logros = [];
            if (viral && !user.logros.includes(drop.rareza)) {
              user.logros.push(drop.rareza);
              guardarBD();
              await sock.sendMessage(chatId, { text: `🏆 ¡Logro desbloqueado: ${drop.rareza.toUpperCase()}!` }, { quoted: msg });
            }
            return;
          }
          if (body.startsWith('#venderfrag ')) {
            const args = body.split(' ');
            const id = args[1];
            const cant = parseInt(args[2]);
            if (!id || isNaN(cant) || cant <= 0) {
              await sock.sendMessage(chatId, { text: 'Uso: #venderfrag <id> <cantidad>' }, { quoted: msg });
              return;
            }
            const frag = getFragmentoById(id);
            if (!frag) {
              await sock.sendMessage(chatId, { text: 'Fragmento no válido.' }, { quoted: msg });
              return;
            }
            if (!user.fragmentos[id] || user.fragmentos[id] < cant) {
              await sock.sendMessage(chatId, { text: 'No tienes esa cantidad.' }, { quoted: msg });
              return;
            }
            if (frag.rareza === 'absoluto') {
              await sock.sendMessage(chatId, { text: '¡Los fragmentos absolutos no se pueden vender! Solo subastas/eventos especiales.' }, { quoted: msg });
              return;
            }
            if (frag.rareza === 'prohibido' && cant > 1) {
              await sock.sendMessage(chatId, { text: 'Solo puedes vender 1 fragmento prohibido a la vez. Venta limitada.' }, { quoted: msg });
              return;
            }
            const valor = precioFinal(frag) * cant;
            user.fragmentos[id] -= cant;
            user.dinero = (user.dinero||0) + valor;
            guardarBD();
            await sock.sendMessage(chatId, { text: `Vendiste ${cant}x ${frag.nombre} por $${valor.toLocaleString()}` }, { quoted: msg });
            return;
          }

          // --- SISTEMA DE CASAS/PROPIEDADES ---
          if (body === '#mihogar' || body === '#micasa') {
            const prop = obtenerPropiedadDeUsuario(senderId);
            if (!prop) {
              await sock.sendMessage(chatId, { text: `🏡 No tienes una propiedad aún.\n\nUsa *#comprarcat [tipo]* para comprar una:\n  • cabaña\n  • casa\n  • mansion\n  • castillo` }, { quoted: msg });
              return;
            }
            const propiedadInfo = PROPIEDADES[prop.tipo];
            const ingresoActual = calcularIngresoPropiedad(prop.tipo, prop.nivelMejora || 0);
            const tiempoRestante = Math.max(0, Math.ceil((prop.proximoIngreso - Date.now()) / 60000));
            const precioMejora = Math.floor(propiedadInfo.precio * 0.1 * ((prop.nivelMejora || 0) + 1));
            let texto = `${propiedadInfo.emoji} *MI HOGAR*\n\n`;
            texto += `Propiedad: ${propiedadInfo.nombre}\n`;
            texto += `Nivel: ${prop.nivelMejora || 0}/${propiedadInfo.mejoras}\n`;
            texto += `Ingreso/h: $${ingresoActual.toLocaleString()}\n`;
            texto += `Próximo: ${tiempoRestante}m\n`;
            if ((prop.nivelMejora || 0) < propiedadInfo.mejoras) {
              texto += `💡 Mejora disponible: $${precioMejora.toLocaleString()}\n`;
              texto += `Usa #mejorarcat para mejorar\n`;
            } else {
              texto += `✨ ¡Propiedad al máximo nivel!\n`;
            }
            await sock.sendMessage(chatId, { text: texto }, { quoted: msg });
            return;
          }

          if (body === '#propiedades') {
            let texto = `🏘️ CATÁLOGO DE PROPIEDADES\n\n`;
            for (const tipo in PROPIEDADES) {
              const prop = PROPIEDADES[tipo];
              texto += `${prop.emoji} *${prop.nombre}*\n`;
              texto += `   💰 Precio: $${prop.precio.toLocaleString()}\n`;
              texto += `   💸 Ingreso/hora: $${prop.ingresoBase.toLocaleString()}\n`;
              texto += `   🔧 Niveles de mejora: ${prop.mejoras}\n`;
              texto += `   ID: ${tipo}\n\n`;
            }
            texto += `Usa *#comprarcat [id]* para comprar\n`;
            texto += `Ejemplo: *#comprarcat cabaña*`;
            await sock.sendMessage(chatId, { text: texto }, { quoted: msg });
            return;
          }

          if (body.startsWith('#comprarcat ')) {
            const tipo = body.split(' ')[1]?.toLowerCase();
            const propiedadInfo = PROPIEDADES[tipo];
            if (!propiedadInfo) {
              await sock.sendMessage(chatId, { text: `❌ Tipo de propiedad inválido.\n\nDisponibles: cabaña, casa, mansion, castillo` }, { quoted: msg });
              return;
            }
            const prop = obtenerPropiedadDeUsuario(senderId);
            if (prop) {
              await sock.sendMessage(chatId, { text: `❌ Ya tienes: ${PROPIEDADES[prop.tipo].nombre}` }, { quoted: msg });
              return;
            }
            if (user.dinero < propiedadInfo.precio) {
              await sock.sendMessage(chatId, { text: `❌ Dinero insuficiente ($${propiedadInfo.precio.toLocaleString()})` }, { quoted: msg });
              return;
            }
            user.dinero -= propiedadInfo.precio;
            propiedades[senderId] = {
              tipo: tipo,
              nivelMejora: 0,
              proximoIngreso: Date.now() + 3600000
            };
            guardarBD();
            savePropiedades();
            const ingresoHora = calcularIngresoPropiedad(tipo, 0);
            await sock.sendMessage(chatId, { text: `🏠 *PROPIEDAD COMPRADA*\n\n${propiedadInfo.nombre}\n💰 $${propiedadInfo.precio.toLocaleString()}\n💸 Ingreso/h: $${ingresoHora.toLocaleString()}\n\n🎉 ¡Ingresos pasivos activados!\n\nUsa #mihogar para ver detalles.` }, { quoted: msg });
            return;
          }

          if (body === '#mejorarcat') {
            const prop = obtenerPropiedadDeUsuario(senderId);
            if (!prop) {
              await sock.sendMessage(chatId, { text: `❌ No tienes propiedad. Usa #comprarcat` }, { quoted: msg });
              return;
            }
            const propiedadInfo = PROPIEDADES[prop.tipo];
            if ((prop.nivelMejora || 0) >= propiedadInfo.mejoras) {
              await sock.sendMessage(chatId, { text: `✨ Tu propiedad ya está al máximo nivel!` }, { quoted: msg });
              return;
            }
            const precioMejora = Math.floor(propiedadInfo.precio * 0.1 * ((prop.nivelMejora || 0) + 1));
            if (user.dinero < precioMejora) {
              await sock.sendMessage(chatId, { text: `❌ Dinero insuficiente para mejorar ($${precioMejora.toLocaleString()})` }, { quoted: msg });
              return;
            }
            user.dinero -= precioMejora;
            prop.nivelMejora = (prop.nivelMejora || 0) + 1;
            const ingresoAnterior = calcularIngresoPropiedad(prop.tipo, prop.nivelMejora - 1);
            const ingresoNuevo = calcularIngresoPropiedad(prop.tipo, prop.nivelMejora);
            guardarBD();
            savePropiedades();
            await sock.sendMessage(chatId, { text: `*✦ MEJORA COMPLETADA ✦*\n\n${propiedadInfo.emoji} ${propiedadInfo.nombre}\n\n▸ Nivel: ${prop.nivelMejora}/${propiedadInfo.mejoras}\n▸ Costo: $${precioMejora.toLocaleString()}\n\n▸ Ingreso anterior: $${ingresoAnterior.toLocaleString()}/h\n▸ Ingreso nuevo: $${ingresoNuevo.toLocaleString()}/h (+${ingresoNuevo - ingresoAnterior})\n\n✨ ¡Disfruta de mayores ganancias!` }, { quoted: msg });
            return;
          }

          // --- SISTEMA DE ALIANZAS/MATRIMONIO 💍 ---
          if (body.startsWith('#proposer ')) {
            const ext = msg.message?.extendedTextMessage?.contextInfo;
            const mentions = ext?.mentionedJid || [];
            if (mentions.length === 0) {
              await sock.sendMessage(chatId, { text: '❌ Debes mencionar a alguien.\n\nUso: #proposer @usuario' }, { quoted: msg });
              return;
            }
            const parejaId = mentions[0];
            if (parejaId === senderId) {
              await sock.sendMessage(chatId, { text: '❌ No puedes casarte contigo' }, { quoted: msg });
              return;
            }
            if (!usuarios[parejaId]) {
              await sock.sendMessage(chatId, { text: '❌ La persona no está registrada en el bot.' }, { quoted: msg });
              return;
            }
            if (alianzas[senderId]) {
              await sock.sendMessage(chatId, { text: '❌ Ya estás casado(a).' }, { quoted: msg });
              return;
            }
            if (alianzas[parejaId]) {
              await sock.sendMessage(chatId, { text: '❌ Esa persona ya está casada.' }, { quoted: msg });
              return;
            }
            if (propuestasMatrimonio[parejaId]) {
              await sock.sendMessage(chatId, { text: '❌ Esa persona ya tiene una propuesta pendiente.' }, { quoted: msg });
              return;
            }
            propuestasMatrimonio[parejaId] = {
              propuestaHecha: senderId,
              fechaPropuesta: Date.now()
            };
            savePropuestasMatrimonio();
            await sock.sendMessage(chatId, { text: `💍 @${senderId.split('@')[0]} le propone matrimonio a @${parejaId.split('@')[0]}!\n\nTiene 2 horas para responder con:\n#aceptarmatrimonio o #rechazarmatrimonio`, mentions: [senderId, parejaId] }, { forceAllow: true });
            return;
          }

          if (body === '#aceptarmatrimonio') {
            const prop = propuestasMatrimonio[senderId];
            if (!prop) {
              await sock.sendMessage(chatId, { text: '❌ Sin propuestas pendientes' }, { quoted: msg });
              return;
            }
            const parejaId = prop.propuestaHecha;
            const ahora = Date.now();
            
            alianzas[senderId] = {
              pareja: parejaId,
              fechaBoda: ahora,
              hijos: [],
              bancoComun: 0
            };
            alianzas[parejaId] = {
              pareja: senderId,
              fechaBoda: ahora,
              hijos: [],
              bancoComun: 0
            };
            
            delete propuestasMatrimonio[senderId];
            savePropuestasMatrimonio();
            saveAlianzas();
            guardarBD();
            
            const bonus = obtenerBonusAlianza(senderId);
            await sock.sendMessage(chatId, { text: `*✦ MATRIMONIO ACEPTADO ✦*\n\n@${parejaId.split('@')[0]} ❤️ @${senderId.split('@')[0]}\n\n¡Se unen en matrimonio!\n\n*─ BONOS INMEDIATOS ─*\n▸ Poder: +${bonus.poder}\n▸ Defensa: +${bonus.defensa}\n\n📝 Usa #mialanza para ver detalles`, mentions: [parejaId, senderId] }, { forceAllow: true });
            return;
          }

          if (body === '#rechazarmatrimonio') {
            const prop = propuestasMatrimonio[senderId];
            if (!prop) {
              await sock.sendMessage(chatId, { text: '❌ Sin propuestas pendientes' }, { quoted: msg });
              return;
            }
            const parejaId = prop.propuestaHecha;
            delete propuestasMatrimonio[senderId];
            savePropuestasMatrimonio();
            await sock.sendMessage(chatId, { text: `😔 @${senderId.split('@')[0]} rechazó la propuesta de matrimonio de @${parejaId.split('@')[0]}.`, mentions: [senderId, parejaId] }, { forceAllow: true });
            return;
          }

          if (body === '#mialanza') {
            const alianza = obtenerPareja(senderId);
            if (!alianza) {
              await sock.sendMessage(chatId, { text: '💔 No estás casado(a) aún.\n\nUsa #proposer @usuario para proponer matrimonio.' }, { quoted: msg });
              return;
            }
            const pareja = usuarios[alianza.pareja];
            const bonus = obtenerBonusAlianza(senderId);
            let texto = `*✦ MI ALIANZA ✦*\n\n`;
            texto += `👰 Pareja: ${pareja?.nombre || alianza.pareja}\n`;
            texto += `📅 Años casados: ${Math.floor(bonus.diasCasados / 365)} años y ${bonus.diasCasados % 365} días\n`;
            texto += `👶 Hijos: ${bonus.hijos}\n\n`;
            texto += `🎁 BONOS ACTIVOS:\n`;
            texto += `⚔️ Poder adicional: +${bonus.poder}\n`;
            texto += `🛡️ Defensa adicional: +${bonus.defensa}\n`;
            texto += `💢 Multiplicador de daño: x${bonus.multiplicadorDaño.toFixed(2)}\n\n`;
            texto += `💰 Banco común: $${alianza.bancoComun.toLocaleString()}\n\n`;
            if (bonus.hijos < 3) {
              texto += `💡 Tengan más hijos para desbloquear más bonos!\n`;
            }
            texto += `\nUsa #divorciar para terminar la alianza.`;
            await sock.sendMessage(chatId, { text: texto }, { quoted: msg });
            return;
          }

          if (body === '#divorciar') {
            const alianza = obtenerPareja(senderId);
            if (!alianza) {
              await sock.sendMessage(chatId, { text: '❌ No estás casado(a).' }, { quoted: msg });
              return;
            }
            const parejaId = alianza.pareja;
            const bancoComun = alianza.bancoComun || 0;
            const mitad = Math.floor(bancoComun / 2);
            
            // Repartir banco común
            user.dinero = (user.dinero || 0) + mitad;
            if (usuarios[parejaId]) {
              usuarios[parejaId].dinero = (usuarios[parejaId].dinero || 0) + (bancoComun - mitad);
            }
            
            // Eliminar alianza
            delete alianzas[senderId];
            delete alianzas[parejaId];
            
            guardarBD();
            saveAlianzas();
            
            await sock.sendMessage(chatId, { text: `😢 @${senderId.split('@')[0]} se divorció de @${parejaId.split('@')[0]}.\n\n💰 Se repartió el banco común.\n\nUsa #proposer para encontrar una nueva pareja.`, mentions: [senderId, parejaId] }, { forceAllow: true });
            return;
          }

          if (body === '#tengohijo') {
            const alianza = obtenerPareja(senderId);
            if (!alianza) {
              await sock.sendMessage(chatId, { text: '❌ Necesitas estar casado para tener hijos' }, { quoted: msg });
              return;
            }
            const parejaId = alianza.pareja;
            if (!usuarios[parejaId]) {
              await sock.sendMessage(chatId, { text: '❌ Tu pareja no existe.' }, { quoted: msg });
              return;
            }
            
            const hijos = alianza.hijos || [];
            if (hijos.length >= 3) {
              await sock.sendMessage(chatId, { text: '❌ Solo pueden tener máximo 3 hijos.' }, { quoted: msg });
              return;
            }
            
            const hijoId = 'hijo_' + Math.random().toString(36).slice(2, 10);
            const hijoNombre = ['Arturo', 'Beatriz', 'Carlos', 'Diana', 'Eduardo', 'Fernanda', 'Gabriel', 'Helena', 'Ignacio', 'Iris'][Math.floor(Math.random() * 10)];
            
            hijos.push({ id: hijoId, nombre: hijoNombre, nacimiento: Date.now() });
            alianza.hijos = hijos;
            alianzas[parejaId].hijos = hijos;
            
            const bonus = obtenerBonusAlianza(senderId);
            
            guardarBD();
            saveAlianzas();
            
            await sock.sendMessage(chatId, { text: `*✦ NUEVO HIJO ✦*\n\n🎉 @${senderId.split('@')[0]} y @${parejaId.split('@')[0]} tienen un hijo!\n\n👶 Nombre: ${hijoNombre}\n\n*─ NUEVOS BONOS ─*\n▸ Poder: +${bonus.poder}\n▸ Defensa: +${bonus.defensa}\n▸ Daño duelos: x${bonus.multiplicadorDaño.toFixed(2)}`, mentions: [senderId, parejaId] }, { forceAllow: true });
            return;
          }

          // --- COMANDOS BOSS MUNDIAL ---
          if (body === '#boss') {
            const active = getActiveBossByGroup(chatId);
            if (!active) {
              await sock.sendMessage(chatId, { text: 'No hay boss activo en este grupo.' }, { quoted: msg });
              return;
            }
            const tiempoRest = Math.max(0, Math.floor((active.fin - Date.now())/60000));
            const ranking = Object.entries(active.rankingDaño).sort((a,b)=>b[1]-a[1]).slice(0,5).map((e,i)=>`${i+1}. ${ (usuarios[e[0]]?.nombre || e[0].split('@')[0]) } — ${e[1]} dmg`).join('\n') || 'Sin daño registrado';
            await sock.sendMessage(chatId, { text: `📢 Boss: ${active.nombre}\nVida: ${active.vidaActual}/${active.vidaMax}\nTiempo restante: ${tiempoRest} min\n\nTop daño:\n${ranking}` }, { quoted: msg });
            return;
          }
          if (body.startsWith('#attack')) {
            const active = getActiveBossByGroup(chatId);
            if (!active) {
              await sock.sendMessage(chatId, { text: 'No hay boss activo para atacar.' }, { quoted: msg });
              return;
            }
            // daño base 15 sin espada, multiplicado por rareza de espada si tiene
            const args = body.split(' ');
            let dmg = 15; // daño base
            try {
              const wid = user.equipo && user.equipo.weapon;
              if (wid) {
                const item = getWeaponItem(wid);
                if (item) {
                  dmg = Math.floor(15 * getWeaponMultiplierByItem(item));
                }
              }
            } catch (e) {}
            const real = registerDamageToBoss(active, senderId, dmg, sock, chatId);
            await sock.sendMessage(chatId, { text: `Has infligido ${real} de daño a ${active.nombre}. Vida restante: ${active.vidaActual}/${active.vidaMax}` }, { quoted: msg });
            return;
          }
          // Atacar boss por ID (incluye bosses personales)
          if (body.startsWith('#boss atacar') || body.startsWith('#boss attack')) {
            const parts = body.split(/\s+/).filter(Boolean);
            const bid = parts[2];
            if (!bid) { await sock.sendMessage(chatId, { text: 'Uso: #boss atacar [bossId]' }, { quoted: msg }); return; }
            const boss = bossesData.bosses.find(b => b.bossId === bid || b.bossId === (bid));
            if (!boss) { await sock.sendMessage(chatId, { text: '🔕 Boss no encontrado.' }, { quoted: msg }); return; }
            // Si es personal y no es importal, solo el creador puede atacarlo
            if (boss.personal && !boss.importal && boss.ownerId && boss.ownerId !== senderId) {
              await sock.sendMessage(chatId, { text: '❌ Solo el creador de este boss puede atacarlo.' }, { quoted: msg });
              return;
            }
            // calcular daño: base 15 sin espada, multiplicado por rareza de espada si tiene
            let dmg = 15; // daño base
            try {
              const wid = user.equipo && user.equipo.weapon;
              if (wid) {
                const item = getWeaponItem(wid);
                if (item) {
                  dmg = Math.floor(15 * getWeaponMultiplierByItem(item));
                }
              }
            } catch (e) {}
            const real = registerDamageToBoss(boss, senderId, dmg, sock, chatId);
            await sock.sendMessage(chatId, { text: `Has infligido ${real} de daño a ${boss.nombre}. Vida restante: ${boss.vidaActual}/${boss.vidaMax}` }, { quoted: msg });
            return;
          }
          if (body === '#bossranking') {
            const active = getActiveBossByGroup(chatId);
            if (!active) {
              await sock.sendMessage(chatId, { text: 'No hay boss activo.' }, { quoted: msg });
              return;
            }
            const ranking = Object.entries(active.rankingDaño).sort((a,b)=>b[1]-a[1]).slice(0,10).map((e,i)=>`${i+1}. ${ (usuarios[e[0]]?.nombre || e[0].split('@')[0]) } — ${e[1]} dmg`).join('\n') || 'Sin daño registrado';
            await sock.sendMessage(chatId, { text: `🏆 Ranking de daño para ${active.nombre}:\n${ranking}` }, { quoted: msg });
            return;
          }
          if (body === '#bossloot') {
            // mostrar resumen de loot si el boss murió recientemente
            const lastDead = bossesData.bosses.slice().reverse().find(b => b.grupoId === chatId && !b.activo && b.muerteTs);
            if (!lastDead) {
              await sock.sendMessage(chatId, { text: 'No hay registro de un boss muerto recientemente en este chat.' }, { quoted: msg });
              return;
            }
            const entries = Object.entries(lastDead.rankingDaño).sort((a,b)=>b[1]-a[1]);
            const top = entries.slice(0,3).map((e,i)=>`${i+1}. ${ (usuarios[e[0]]?.nombre || e[0].split('@')[0]) } — ${e[1]} dmg`).join('\n') || 'Sin daño registrado';
            await sock.sendMessage(chatId, { text: `🧾 Loot del boss ${lastDead.nombre}:\nTop contribuyentes:\n${top}` }, { quoted: msg });
            return;
          }
      // Registrar abuso para historial sin enviar notificaciones ni aplicar bloqueo automático
      try { detectarAbuso(msg, user, chatId); } catch (e) { /* ignore */ }
    }

    // --- COMANDOS ANTI-ABUSO ---
    if (body === '#historialdisc') {
      const hist = getAbuso(senderId);
      if (!hist.length) {
        await sock.sendMessage(chatId, { text: 'No tienes historial disciplinario.' }, { quoted: msg });
        return;
      }
      let lines = ['🕵️‍♂️ HISTORIAL DISCIPLINARIO:\n'];
      hist.forEach(e => lines.push(`${e.fecha.split('T')[0]} — ${e.tipo}: ${e.detalle}`));
      await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
      return;
    }

    if (body === '#consejo') {
      const hist = getAbuso(senderId);
      const advertencias = hist.filter(e => e.tipo.includes('advertencia')).length;
      let msgTxt = '👁️ El Consejo te observa…\n';
      msgTxt += `Advertencias: ${advertencias}\n`;
      await sock.sendMessage(chatId, { text: msgTxt }, { quoted: msg });
      return;
    }

    if (!usuarios[senderId]) {
      const allowedBeforeRegister = ["#registrar", "#menu", "#ayuda", "#help"];
      const allowed = allowedBeforeRegister.some(c => body.startsWith(c));
      if (!allowed) {
        await sock.sendMessage(chatId, { text: "❌ Registrate: #registrar [nombre]" }, { quoted: msg });
        return;
      }
    }

    user = usuarios[senderId];

    if (user) {
      if (!user.inventario) user.inventario = {};
      if (!user.efectosActivos) user.efectosActivos = [];
      if (!user.mensajesEliminados) user.mensajesEliminados = {};
      if (!user.ultimaDropGratis) user.ultimaDropGratis = 0;
      if (user.vida === undefined) user.vida = 100;
      if (user.defensa === undefined) user.defensa = 0;
      if (!user.ultimoEntrenamiento) user.ultimoEntrenamiento = 0;
      if (!user.hasOwnProperty('coinsUniversal')) user.coinsUniversal = 0;
      if (!user.hasOwnProperty('dinero')) user.dinero = 1000;
      if (!user.hasOwnProperty('ultimoTrabajo')) user.ultimoTrabajo = 0;
      if (!user.hasOwnProperty('ultimoRobo')) user.ultimoRobo = 0;
      if (!user.hasOwnProperty('multiplicadorTrabajo')) user.multiplicadorTrabajo = 0;
      if (!user.hasOwnProperty('exp')) user.exp = 0;
      if (!user.hasOwnProperty('nivel')) user.nivel = 1;
      // Inicializaciones para logros y actividad
      if (!user.hasOwnProperty('messagesCount')) user.messagesCount = 0;
      if (!user.hasOwnProperty('lastActiveDay')) user.lastActiveDay = null;
      if (!user.hasOwnProperty('consecutiveDays')) user.consecutiveDays = 0;
      if (!user.hasOwnProperty('seasonsParticipated')) user.seasonsParticipated = [];
      if (!user.achievements) user.achievements = [];
      if (!user.stats) user.stats = user.stats || {};
      if (!user.hasOwnProperty('prestige')) user.prestige = 0;
      // Campos sociales inteligentes
      if (!user.hasOwnProperty('identidad') || !user.identidad) user.identidad = null; // se generará cuando sea necesario
      if (!user.historialNegro) user.historialNegro = [];
      if (!user.memoria) user.memoria = { mensajes: 0, audios: 0, silencios: 0, conflictos: 0, lastMessageTs: 0 };
      if (!user.hasOwnProperty('status')) user.status = null;
      if (!user.cooldowns) user.cooldowns = {};
      if (!user.badges) user.badges = user.badges || [];
    }

    // ---------- Comandos de temporada / puntos ----------
    if (await handleSeasonCommands({ body, senderId, chatId, sock, msg })) return;

    // Contadores de actividad por comando (mensajes válidos = comandos)
    if (body && body.startsWith('#') && user) {
      user.messagesCount = (user.messagesCount || 0) + 1;
      // días consecutivos (por fecha local)
      const today = new Date().toISOString().slice(0,10);
      const yesterday = new Date(Date.now() - 24*3600*1000).toISOString().slice(0,10);
      if (user.lastActiveDay === today) {
        // mismo día, no hacer nada
      } else if (user.lastActiveDay === yesterday) {
        user.consecutiveDays = (user.consecutiveDays || 0) + 1;
        user.lastActiveDay = today;
      } else {
        user.consecutiveDays = 1;
        user.lastActiveDay = today;
      }
      // otorgar logros por mensajes
      if (user.messagesCount >= 100) grantAchievement(user, 'hablador', sock, chatId);
      if (user.messagesCount >= 500) grantAchievement(user, 'charlatan', sock, chatId);
      if (user.messagesCount >= 1000) grantAchievement(user, 'imparable', sock, chatId);
      // otorgar logros por días consecutivos
      if (user.consecutiveDays >= 7) grantAchievement(user, 'siempre_presente', sock, chatId);
      if (user.consecutiveDays >= 30) grantAchievement(user, 'no_tengo_vida', sock, chatId);
      guardarBD();
    }

    if (body === "#menu" || body === "#ayuda" || body === "#help") {
      // Menú visual mejorado con separadores, indicadores y mejor espaciado
      const lines = [];
      lines.push('');
      lines.push('*✦ ⚡ MENU SUPREME ⚡ ✦*');
      lines.push('');
      lines.push('');
      lines.push('');
      
      lines.push('┌─ 👑 *PERFIL Y PROGRESO* ────────────────┐');
      lines.push('│ ⭐ #perfil       _tu perfil y stats_');
      lines.push('│ ⭐ #stats        _estadísticas completas_');
      lines.push('│    #puntos       _puntos de temporada_');
      lines.push('│    #top          _ranking temporada_');
      lines.push('│    #top poder    _más fuertes_');
      lines.push('│    #top dinero   _millonarios_');
      lines.push('│    #top nivel    _experiencia_');
      lines.push('│    #top duelos   _guerreros_');
      lines.push('│    #logros       _logros desbloqueados_');
      lines.push('│    #titulos      _tus títulos_');
      lines.push('│    #equipartit   _equipar título_');
      lines.push('│    #ranking      _top jugadores_');
      lines.push('│    #temporada    _info temporada_');
      lines.push('│    #consejo      _consejo diario_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ ⚔️ *BATALLA Y COMBATE* ────────────────┐');
      lines.push('│ ⭐ #duelo @user  _reta a jugador_');
      lines.push('│ ⭐ #boss         _ataca boss mundial_');
      lines.push('│    #attack       _ataque rápido_');
      lines.push('│    #bossranking  _ranking daño_');
      lines.push('│    #bossloot     _resumen loot_');
      lines.push('│    #dungeon      _dungeons disponibles_');
      lines.push('│    #expedicion   _expediciones_');
      lines.push('│    #entrar       _entrar expedición_');
      lines.push('│    #atacar       _combatir en exp_');
      lines.push('│    #exp-stats    _stats expedición_');
      lines.push('│    #continuar    _seguir combatiendo_');
      lines.push('│    #abandonar    _salir dungeon_');
      lines.push('│    #boss crear   _crear boss personal_');
      lines.push('│    #entrenar     _ganar experiencia_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 🎒 *INVENTARIO Y EQUIPO* ──────────────┐');
      lines.push('│ ⭐ #inventario   _tu inventario_');
      lines.push('│ ⭐ #fragmentos   _tus fragmentos_');
      lines.push('│    #cofres       _cofres disponibles_');
      lines.push('│    #llaves       _tus llaves_');
      lines.push('│    #mochila      _cofres y llaves_');
      lines.push('│    #equipar      _equipar item_');
      lines.push('│    #abrir <tipo> _abrir cofre_');
      lines.push('│    #usar <item>  _usar item_');
      lines.push('│    #venderfrag   _vender fragmentos_');
      lines.push('│    #craft        _fabricar items_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 💰 *ECONOMÍA Y DINERO* ────────────────┐');
      lines.push('│ ⭐ #daily        _recompensa diaria_');
      lines.push('│ ⭐ #trabajar     _ganar dinero_');
      lines.push('│    #minar        _minar dinero_');
      lines.push('│    #recolectar   _recolectar recursos_');
      lines.push('│    #caza         _cazar piezas_');
      lines.push('│    #forestal     _talar madera_');
      lines.push('│    #robar        _robar monedas_');
      lines.push('│    #bal          _balance financiero_');
      lines.push('│    #banco        _saldo bancario_');
      lines.push('│    #d <cant>     _depositar_');
      lines.push('│    #retirar      _retirar fondos_');
      lines.push('│    #apostar      _casino (55% win)_');
      lines.push('│    #invertir     _invertir dinero_');
      lines.push('│    #referral     _sistema referidos_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ � *APUESTAS Y JUEGOS DE AZAR* ────────┐');
      lines.push('│ ⭐ #apuestas     _guía de apuestas_');
      lines.push('│ ⭐ #duelo @user  _duelo con apuesta_');
      lines.push('│    #dados [cant] _lanzar dados_');
      lines.push('│    #moneda [c] _ _cara/cruz_');
      lines.push('│    #reto-ruleta  _ruleta rusa_');
      lines.push('│    #ruleta       _ruleta diaria_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ �🏪 *TIENDA Y MERCADO* ─────────────────┐');
      lines.push('│ ⭐ #tienda       _ver tienda_');
      lines.push('│ ⭐ #comprar <id> _comprar item_');
      lines.push('│    #vender       _vender items_');
      lines.push('│    #mercado      _listados activos_');
      lines.push('│    #subastas     _subastas en curso_');
      lines.push('│    #listar       _listar item_');
      lines.push('│    #compramkt    _comprar listado_');
      lines.push('│    #subasta      _crear subasta_');
      lines.push('│    #ofertar      _pujar en subasta_');
      lines.push('│    #pujar        _hacer puja_');
      lines.push('│    #historial    _transacciones_');
      lines.push('│    #mercadostats _estadísticas mkt_');
      lines.push('│    #estdtienda   _stats tienda_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 🏘️ *PROPIEDADES Y HOGAR* ──────────────┐');
      lines.push('│    #propiedades  _ver catálogo_');
      lines.push('│    #comprarcat   _comprar propiedad_');
      lines.push('│    #mihogar      _tu propiedad_');
      lines.push('│    #mejorarcat   _mejorar propiedad_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 💍 *ALIANZAS Y MATRIMONIO* ────────────┐');
      lines.push('│    #proposer @u  _proponer matrimonio_');
      lines.push('│    #aceptarmat   _aceptar propuesta_');
      lines.push('│    #rechazarmat  _rechazar propuesta_');
      lines.push('│    #mialanza     _ver tu alianza_');
      lines.push('│    #tengohijo    _tener un hijo_');
      lines.push('│    #divorciar    _terminar matrimonio_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 📋 *MISIONES Y PROGRESIÓN* ────────────┐');
      lines.push('│    #misiones     _tus misiones_');
      lines.push('│    #claimmission _reclamar misión_');
      lines.push('│    #quest        _misiones diarias_');
      lines.push('│    #reclamarquest _reclamar quest_');
      lines.push('│    #battlepass   _progreso bp_');
      lines.push('│    #retos        _retos disponibles_');
      lines.push('│    #reto_diario  _reto diario_');
      lines.push('│    #clanwar      _guerra de clanes_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 🎭 *FACCIONES Y MONTURAS* ─────────────┐');
      lines.push('│    #faccion      _facciones disponibles_');
      lines.push('│    #joinfaction  _unirse facción_');
      lines.push('│    #montura      _monturas disponibles_');
      lines.push('│    #comprarmont  _comprar montura_');
      lines.push('│    #equiparmont  _equipar montura_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 🏰 *SISTEMA DE CLANES* ────────────────┐');
      lines.push('│ ⭐ #crearclan    _crear clan_');
      lines.push('│ ⭐ #miclan       _info tu clan_');
      lines.push('│    #unirclan     _unirse a clan_');
      lines.push('│    #salirclan    _abandonar clan_');
      lines.push('│    #invitar      _invitar miembro_');
      lines.push('│    #expulsar     _expulsar miembro_');
      lines.push('│    #donar        _donar al clan_');
      lines.push('│    #rankclanes   _top clanes_');
      lines.push('│    #claninfo     _info del clan_');
      lines.push('│    #topclanes    _ranking clanes_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 🎉 *EVENTOS Y ENTRETENIMIENTO* ────────┐');
      lines.push('│ ⭐ #eventos      _eventos activos_');
      lines.push('│ ⭐ #ruleta       _ruleta diaria (24h)_');
      lines.push('│ ⭐ #adivinanza   _adivinanza diaria_');
      lines.push('│ ⭐ #respuesta    _responder adivinanza_');
      lines.push('│ ⭐ #bruja        _consulta mística_');
      lines.push('│    #torneos      _torneos disponibles_');
      lines.push('│    #torneo       _sistema torneos_');
      lines.push('│    #trivia       _pregunta trivia_');
      lines.push('│    #sorteo       _sistema sorteos_');
      lines.push('│    #registrar    _unirte a evento_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 🏅 *RANKINGS Y LEADERBOARDS* ─────────┐');
      lines.push('│    #rank         _top por poder_');
      lines.push('│    #rankbal      _top por dinero_');
      lines.push('│    #ranklevel    _top por nivel_');
      lines.push('│    #ranks        _todos rankings_');
      lines.push('│    #leaderboards _ver leaderboards_');
      lines.push('│    #lb <cat>     _top semanal_');
      lines.push('│    #mi-rango     _tu posición_');
      lines.push('│    #listamute    _usuarios muted_');
      lines.push('│    #historialdisc _historial disc_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ ⚡ *PODERES ESPECIALES* ────────────────┐');
      lines.push('│    #identidad    _tu identidad_');
      lines.push('│    #memoria      _memoria sistem_');
      lines.push('│    #status       _insignias_');
      lines.push('│    #ascender     _subir ascensión_');
      lines.push('│    #aura         _tu aura_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ ⚙️ *SISTEMA Y CONFIGURACIÓN* ─────────┐');
      lines.push('│ ⭐ #registrar    _crear cuenta_');
      lines.push('│    #setlang      _cambiar idioma_');
      lines.push('│    #setdesc      _descripción_');
      lines.push('│    #setgenero    _cambiar género_');
      lines.push('│    #setcumple    _cumpleaños_');
      lines.push('│    #info         _info del bot_');
      lines.push('│    #ping         _latencia bot_');
      lines.push('│    #ayuda        _este menú_');
      lines.push('│    #reglas       _reglas grupo_');
      lines.push('│    #advertencia  _avisos grupo_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('┌─ 🔐 *ADMINISTRACIÓN* ───────────────────┐');
      lines.push('│ 🔒 #mute @user [tiempo]');
      lines.push('│    _silenciar usuario (límite 20 msg)_');
      lines.push('│ 🔒 #unmute @user');
      lines.push('│    _dessilenciar_');
      lines.push('│ 🔒 ⭐ #kick @user | responder');
      lines.push('│    _expulsar del grupo (requiere admin)_');
      lines.push('│ 🔒 #listamute');
      lines.push('│    _ver usuarios silenciados_');
      lines.push('│ 🔒 #ganarpuntos <cant>');
      lines.push('│    _ganar puntos (admin)_');
      lines.push('│ 🔒 #boss crear <name>');
      lines.push('│    _crear boss (admin)_');
      lines.push('│ 🔒 #globalevent <accion>');
      lines.push('│    _eventos globales_');
      lines.push('│ 🔒 #addpts       _añadir puntos_');
      lines.push('│ 🔒 #seasonstart  _iniciar temporada_');
      lines.push('│ 🔒 #seasonend    _terminar temporada_');
      lines.push('│ 🔒 #badwords     _palabras prohibidas_');
      lines.push('│ 🔒 #alertthresh  _configurar alertas_');
      lines.push('└────────────────────────────────────────┘');
      lines.push('');
      
      lines.push('');
      lines.push('*⭐ = Popular  |  🔒 = Admin  |  ⚡ RPG BOT*');
      lines.push('');
      
      await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
      return;
    }
      

    if (body.startsWith("#registrar ")) {
      const nombreNuevo = body.split(" ").slice(1).join(" ").trim();
      if (!nombreNuevo || nombreNuevo.length < 2) {
        await sock.sendMessage(chatId, { text: "❌ Usa un nombre válido\n💡 Ejemplo: #registrar Mi Nombre" }, { quoted: msg });
        return;
      }
      if (nombreNuevo.length > 25) {
        await sock.sendMessage(chatId, { text: "❌ Nombre muy largo. Máximo 25 caracteres." }, { quoted: msg });
        return;
      }
      if (!usuarios[senderId]) {
        usuarios[senderId] = {
          nombre: nombreNuevo,
          lang: 'es',
          nivel: 1,
          exp: 0,
          poder: 100,
          rayo: null,
          ultimaDaily: 0,
          ultimoEntrenamiento: 0,
          coinsUniversal: 0,
          dinero: 1000,
          banco: 0,
          ultimoTrabajo: 0,
          ultimoRobo: 0,
          ultimaApuesta: 0,
          ultimaInversion: 0,
          ultimaMineria: 0,
          negocio: null,
          ultimoNegocio: 0,
          multiplicadorTrabajo: 0,
          inversionesPendientes: [],
          descripcion: null,
          genero: null,
          cumpleanos: null,
          ruletaChallenge: null,
          inventario: {},
          clanId: null,
          vida: 100,
          defensa: 0,
          efectosActivos: [],
          mensajesEliminados: {},
          ultimaDropGratis: 0
        };
      } else {
        usuarios[senderId].nombre = nombreNuevo;
      }
      saveBosses();
      grantAchievement(usuarios[senderId], 'registrado', sock, chatId);
      await sock.sendMessage(chatId, { text: `✅ Registrado como *${nombreNuevo}*` }, { quoted: msg });
    }

    if (body.startsWith("#setlang") || body.startsWith("#idioma")) {
      const args = body.split(/\s+/).filter(Boolean);
      if (args.length < 2) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('setlang_invalid', lang) }, { quoted: msg });
        return;
      }
      const newLang = args[1].toLowerCase();
      if (!['es','en'].includes(newLang)) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('setlang_invalid', lang) }, { quoted: msg });
        return;
      }
      usuarios[senderId].lang = newLang;
      guardarBD();
      await sock.sendMessage(chatId, { text: t('setlang_success', newLang, { lang: newLang }) }, { quoted: msg });
      return;
    }

    if (body.startsWith("#setdesc ")) {
      const descripcion = body.split(" ").slice(1).join(" ").trim();
      if (!descripcion || descripcion.length < 1) {
        await sock.sendMessage(chatId, { text: "❌ Usa una descripción válida\n💡 Ejemplo: #setdesc Me gusta programar" }, { quoted: msg });
        return;
      }
      if (descripcion.length > 100) {
        await sock.sendMessage(chatId, { text: "❌ Descripción muy larga. Máximo 100 caracteres." }, { quoted: msg });
        return;
      }
      user.descripcion = descripcion;
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Tu descripción es: *${descripcion}*` }, { quoted: msg });
    }

    if (body.startsWith("#setgenero ")) {
      const genero = body.split(" ").slice(1).join(" ").trim().toLowerCase();
      const generosValidos = ['hombre', 'mujer'];
      if (!genero || !generosValidos.includes(genero)) {
        await sock.sendMessage(chatId, { 
          text: "❌ Género no válido\n\n💡 Opciones disponibles:\n• hombre\n• mujer\n\n📝 Ejemplo: #setgenero hombre"
        }, { quoted: msg });
        return;
      }
      user.genero = genero;
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Tu género es: *${genero}*` }, { quoted: msg });
    }

    if (body.startsWith("#setcumple ")) {
      const cumpleanos = body.split(" ").slice(1).join(" ").trim();
      if (!cumpleanos || cumpleanos.length < 1) {
        await sock.sendMessage(chatId, { text: "❌ Usa una fecha válida\n💡 Ejemplo: #setcumple 15 de Mayo" }, { quoted: msg });
        return;
      }
      if (cumpleanos.length > 50) {
        await sock.sendMessage(chatId, { text: "❌ Fecha muy larga. Máximo 50 caracteres." }, { quoted: msg });
        return;
      }
      user.cumpleanos = cumpleanos;
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Tu cumpleaños es: *${cumpleanos}*` }, { quoted: msg });
    }

    if (body.startsWith("#daily")) {
      const ahora = Date.now();
      const priorDaily = user.ultimaDaily || 0;
      const cooldown = 86400000;
      const tiempoRestante = priorDaily + cooldown - ahora;
      if (tiempoRestante > 0) {
        const horas = Math.floor(tiempoRestante / 3600000);
        const minutos = Math.floor((tiempoRestante % 3600000) / 60000);
        const barraEspera = Array(Math.floor(tiempoRestante / (cooldown / 10))).fill('█').join('') + Array(10 - Math.floor(tiempoRestante / (cooldown / 10))).fill('░').join('');
        await sock.sendMessage(chatId, { 
          text: `⏳ *YA RECLAMASTE HOY*\n\n▸ Tiempo restante: *${horas}h ${minutos}m*\n${barraEspera}\n\n▸ Vuelve en ${horas}h ${minutos}m para obtener más recompensas`
        }, { quoted: msg });
        return;
      }
      
      // Inicializar racha si no existe
      initMissionsForUser(user);
      const dineroBonus = getStreakDineroBonus(user.streakDays);
      const expBonus = getStreakExpBonus(user.streakDays);
      const poderBonus = getStreakPoderBonus(user.streakDays);
      
      const poderBase = 1200;
      const poderBonusUser = user.nivel * 120;
      const poderTotal = poderBase + poderBonusUser + Math.floor(Math.random() * 800) + poderBonus;
      user.poder += poderTotal;
      user.ultimaDaily = ahora;
      const coinsReward = Math.floor(Math.random() * 15000) + 8000 + dineroBonus;
      const expGain = Math.floor(2000 + Math.random() * 2000 + (user.nivel || 1) * 150 + expBonus);
      const lvlRes = addExp(user, expGain);
      user.dinero += coinsReward;
      
      // Drop de llaves y cofres por login diario
      if (!user.mochila) user.mochila = { cofre_comun:0, cofre_raro:0, cofre_mitologico:0, llave_comun:0, llave_dorada:0, llave_mitologica:0 };
      let itemsDropped = [];
      if (Math.random() < 0.7) { user.mochila.llave_comun += 1; itemsDropped.push('🔑 Llave Común'); }
      if (Math.random() < 0.25) { user.mochila.cofre_comun += 1; itemsDropped.push('📦 Cofre Común'); }
      if (Math.random() < 0.08) { user.mochila.llave_dorada += 1; itemsDropped.push('💛 Llave Dorada'); }
      if (Math.random() < 0.02) { user.mochila.cofre_raro += 1; itemsDropped.push('🔷 Cofre Raro'); }
      
      // Drop fragmento común (baja chance)
      let fragDropped = '';
      if (Math.random() < 0.05) {
        const frag = fragmentosData.fragmentos.filter(f => f.rareza === 'comun');
        if (frag.length) {
          const f = frag[Math.floor(Math.random()*frag.length)];
          user.fragmentos = user.fragmentos || {};
          user.fragmentos[f.id] = (user.fragmentos[f.id]||0) + 1;
          fragDropped = `\n\n✦ *FRAGMENTO ESPECIAL:*\n▸ ${f.nombre} +1`;
        }
      }
      
      guardarBD();
      if (user.dinero >= 100000) grantAchievement(user, 'rico', sock, chatId);
      if (priorDaily === 0) grantAchievement(user, 'primer_daily', sock, chatId);
      const { rango, clasificacion } = obtenerRangoClasificacion(Number(user.poder) || 0);
      
      let streakBonus = '';
      if (user.streakDays > 0) {
        const streakEmoji = user.streakDays >= 7 ? '🔥' : user.streakDays >= 3 ? '⚡' : '✨';
        streakBonus = `\n\n${streakEmoji} *BONUS RACHA (DÍA ${user.streakDays})*\n▸ Dinero: +$${dineroBonus.toLocaleString()}\n▸ EXP: +${expBonus}`;
      }
      
      let itemsText = '';
      if (itemsDropped.length > 0) {
        itemsText = `\n\n✦ *ITEMS DROPPEADOS:*\n${itemsDropped.map(i => `▸ ${i}`).join('\n')}`;
      }
      
      const mensajeDaily = `*✦ RECOMPENSA DIARIA ✦*

▸ *Poder:* +${poderTotal.toLocaleString()}
▸ *EXP:* +${expGain}
▸ *Dinero:* +$${coinsReward.toLocaleString()}${streakBonus}${itemsText}${fragDropped}

*─────────────────────*
▸ *${rango}* ${clasificacion}
▸ Poder Total: ${user.poder.toLocaleString()}
▸ Nivel: ${user.nivel}
▸ Saldo: $${user.dinero.toLocaleString()}`;
      
      await sock.sendMessage(chatId, { 
        text: mensajeDaily
      }, { quoted: msg });
    }

    if (body.startsWith("#entrenar") || body.startsWith("#train")) {
      const ahora = Date.now();
      const cooldown = 1800000;
      const tiempoRestante = user.ultimoEntrenamiento + cooldown - ahora;
      if (tiempoRestante > 0) {
        const minutos = Math.ceil(tiempoRestante / 60000);
        await sock.sendMessage(chatId, { 
          text: `⏳ Aún entrenando. Puedes en ${minutos}m`
        }, { quoted: msg });
        return;
      }
      const poderGanado = Math.floor(Math.random() * 300) + 200 + (user.nivel * 10);
      user.poder += poderGanado;
      user.ultimoEntrenamiento = ahora;
      // Estadísticas de entrenamiento
      if (!user.stats) user.stats = {};
      user.stats.trainCount = (user.stats.trainCount || 0) + 1;
      // Ganancia de experiencia por entrenar
      const expTrain = Math.floor(200 + Math.random() * 200 + (user.nivel || 1) * 30);
      const lvlResTrain = addExp(user, expTrain);
      if (user.stats.trainCount === 10) grantAchievement(user, 'entrenador', sock, chatId);
      // actualizar misión diaria
      if (updateMissionProgress(user, 'entrena_veces', 1)) {
        const mission = DAILY_MISSIONS['entrena_veces'];
        const dineroBonus = getStreakDineroBonus(user.streakDays);
        const expBonus = getStreakExpBonus(user.streakDays);
        const missionDinero = Math.floor(mission.reward.dinero + dineroBonus);
        const missionExp = Math.floor(mission.reward.exp + expBonus);
        const missionPuntos = Math.floor(mission.reward.puntos + (mission.reward.puntos * user.streakDays * 0.1));
        sock.sendMessage(chatId, { text: `✅ ¡Misión completada! ${mission.nombre}\n💰 +$${missionDinero} | 📚 +${missionExp} exp${user.streakDays > 0 ? ` | 🔥 Día ${user.streakDays}` : ''}` }).catch(() => {});
        user.dinero = (user.dinero || 0) + missionDinero;
        addExp(user, missionExp);
        if (currentSeason) seasonAddPointsAndRegister(senderId, misionPuntos);
      }
      guardarBD();
      const { rango, clasificacion } = obtenerRangoClasificacion(Number(user.poder) || 0);
      await sock.sendMessage(chatId, { 
        text: `⚡ *ENTRENAMIENTO COMPLETADO*\n\n💪 +${poderGanado.toLocaleString()} poder\n📚 +${expTrain} EXP\n🏅 Clase: ${rango} ${clasificacion}\n💥 Poder Total: ${user.poder.toLocaleString()}\n📊 Nivel: ${user.nivel}`
      }, { quoted: msg });
    }

    if (body.startsWith("#trabajar") || body.startsWith("#work")) {
      const ahora = Date.now();
      const cooldown = 120000; // 2 minutos
      const tiempoRestante = user.ultimoTrabajo + cooldown - ahora;
      if (tiempoRestante > 0) {
        const minutos = Math.ceil(tiempoRestante / 60000);
        await sock.sendMessage(chatId, { 
          text: `⏳ Ya trabajaste. Vuelve en *${minutos}m*`
        }, { quoted: msg });
        return;
      }
      
      // Profesiones con sus datos y mensajes narrativos
      const profesiones = {
        "Policía": {
          mult: 1.4,
          emoji: "👮",
          exito: [
            "Patrullaste la ciudad toda la noche, encontraste a un delincuente y lo arrestaste. 💰 +",
            "Detuviste un robo a mano armada. Los civiles te dieron una recompensa. 💰 +",
            "Resolviste un caso importante, tuviste ascenso y bonus. 💰 +",
            "Salvaste a una persona en peligro, recibiste recompensa del departamento. 💰 +",
            "Completaste el turno sin incidentes, recibiste paga + bonus. 💰 +",
            "Atrapaste a un prófugo buscado. Recompensa oficial. 💰 +",
            "Trabajaste en un evento especial, ganaste extra. 💰 +",
            "Investigación exitosa, ganaste comisión. 💰 +"
          ],
          fracaso: [
            "Perseguiste un ladrón, sus compañeros te emboscaron y te golpearon. Tuviste que pagar los daños. 💸 -",
            "Accidente durante una persecución, tuviste que pagar la reparación del auto patrulla. 💸 -",
            "Te suspendieron un día por un error en el procedimiento, sin sueldo. 💸 -",
            "Confiscaron tu arma por una denuncia falsa, tuviste que pagar para recuperarla. 💸 -",
            "Te atrapó una trampa criminal, casi te matan, gastos hospitalarios. 💸 -",
            "Perdiste evidencia en una investigación, multa interna. 💸 -",
            "Te traicionó un colega, tuviste pérdidas. 💸 -",
            "Incidente con civiles, tuviste que pagar compensación. 💸 -"
          ]
        },
        "Chef": {
          mult: 1.5,
          emoji: "👨‍🍳",
          exito: [
            "Preparaste un banquete de lujo, propinas generosas. 💰 +",
            "Creaste un nuevo plato que se volvió famoso, bonificación especial. 💰 +",
            "Ganaste un premio culinario, recibiste dinero en efectivo. 💰 +",
            "Trabajaste en un evento privado con clientes ricos, propinas enormes. 💰 +",
            "Tu restaurante tuvo un día récord de ventas. 💰 +",
            "Preparaste para una celebridad, propina de lujo. 💰 +",
            "Ganaste un concurso de cocina con premio en efectivo. 💰 +",
            "Vendiste recetas exclusivas a otros restaurantes. 💰 +"
          ],
          fracaso: [
            "Se quemó toda la comida, tuviste que pagar los ingredientes perdidos. 💸 -",
            "Accidente en la cocina, quemaduras graves, gastos médicos. 💸 -",
            "Un cliente se envenenó con tu comida, tuviste que compensarlo. 💸 -",
            "Incendio en la cocina, daños materiales. 💸 -",
            "Preparaste mal un evento importante, perdiste la reputación y clientes. 💸 -",
            "Robaron ingredientes caros durante tu turno. 💸 -",
            "Te despidieron por mala calidad, perdiste un día de trabajo. 💸 -",
            "Peleas entre cocineros, destruyeron equipos. Tu culpa, pagas. 💸 -"
          ]
        },
        "Programador": {
          mult: 1.6,
          emoji: "💻",
          exito: [
            "Terminaste un proyecto grande antes de tiempo, bonus. 💰 +",
            "Tu código fue usado en una app exitosa, regalías. 💰 +",
            "Ganaste un contrato freelance millonario. 💰 +",
            "Solucionaste un bug crítico, recompensa empresarial. 💰 +",
            "Desarrollaste una herramienta que se vendió bien. 💰 +",
            "Ascenso por tu desempeño excepcional. 💰 +",
            "Ganaste un hackathon con premio en dinero. 💰 +",
            "Consultorías pagadas a startups. 💰 +"
          ],
          fracaso: [
            "Hackers atacaron tus sistemas, tuviste que pagar el rescate. 💸 -",
            "Tu código causó un crash importante, multa de la empresa. 💸 -",
            "Pérdida de datos importante, compensación a clientes. 💸 -",
            "Espías corporativos robaron tu código, pleito legal caro. 💸 -",
            "Tu proyecto fue un fracaso total, cancela todo. 💸 -",
            "Deadline incumplido, penalización contractual. 💸 -",
            "Virus en tu máquina, tuviste que cambiarla. 💸 -",
            "Acusado falsamente de sabotaje, gastos legales. 💸 -"
          ]
        },
        "Piloto": {
          mult: 2.0,
          emoji: "✈️",
          exito: [
            "Vuelo internacional exitoso, propinas de pasajeros millonarios. 💰 +",
            "Evitaste un accidente importante, bonus de seguridad. 💰 +",
            "Ganaste un contrato premium con aerolínea de lujo. 💰 +",
            "Récord de tiempo, ganaste competencia aérea. 💰 +",
            "Transporte de carga especial, pago altísimo. 💰 +",
            "Promoción a piloto jefe, aumento de sueldo. 💰 +",
            "Vuela exclusiva para empresa importante, honorarios altos. 💰 +",
            "Entrenador de nuevos pilotos, dinero extra. 💰 +"
          ],
          fracaso: [
            "Falla en motor durante vuelo, aterrizaje de emergencia. Multa grande. 💸 -",
            "Chocaste el avión al aterrizar, daños catastróficos. 💸 -",
            "Desviación de ruta, combustible perdido, multa regulatoria. 💸 -",
            "Pasajero importante se quejó, demanda. 💸 -",
            "Revisión médica falló, suspendieron tu licencia temporal. Sin sueldo. 💸 -",
            "Colisión en tierra, daños al aeropuerto. 💸 -",
            "Equipaje perdido, compensación a pasajeros. 💸 -",
            "Error de navegación, combustible desperdiciado. Multa. 💸 -"
          ]
        },
        "Abogado": {
          mult: 1.9,
          emoji: "⚖️",
          exito: [
            "Ganaste un juicio millonario, comisión sustancial. 💰 +",
            "Clientes ricos contrataron tus servicios. 💰 +",
            "Ganaste apelación importante, bonus del bufete. 💰 +",
            "Negociación exitosa, honorarios altos. 💰 +",
            "Promovido a socio del bufete. 💰 +",
            "Ganaste caso imposible, fama y dinero. 💰 +",
            "Contrato exclusivo con corporación grande. 💰 +",
            "Mediación exitosa de alto perfil. 💰 +"
          ],
          fracaso: [
            "Perdiste un juicio importante, cliente enojado te demandó. 💸 -",
            "Error legal costoso, tuviste que pagar al cliente. 💸 -",
            "Desacato al tribunal, multa importante. 💸 -",
            "Secreto profesional revelado, juicio. 💸 -",
            "Colegio de abogados investigación, suspensión temporal. 💸 -",
            "Conflicto de interés, caso anulado, pérdida total. 💸 -",
            "Cliente falso, estafa, perdiste dinero. 💸 -",
            "Documentos falsificados encontrados, castigo profesional. 💸 -"
          ]
        },
        "Médico": {
          mult: 1.8,
          emoji: "👨‍⚕️",
          exito: [
            "Operación exitosa, paciente ricos dejó herencia. 💰 +",
            "Diagnóstico que salvó vidas, recompensa institucional. 💰 +",
            "Investigación médica premiada con dinero. 💰 +",
            "Consultas privadas lucrativos día. 💰 +",
            "Promovido a director del hospital. 💰 +",
            "Publicación científica que generó royalties. 💰 +",
            "Procedimiento innovador, honorarios especiales. 💰 +",
            "Cirugía de emergencia bien pagada. 💰 +"
          ],
          fracaso: [
            "Cometiste error médico, demanda millonaria. 💸 -",
            "Paciente murió bajo tu cuidado, investigación. 💸 -",
            "Prescripción incorrecta causó daño, compensación. 💸 -",
            "Infección hospitalaria por negligencia, multa. 💸 -",
            "Colegio médico investigación, suspensión. 💸 -",
            "Diagnostico errado, paciente se agravó. 💸 -",
            "Equipo médico dañado durante cirugía. 💸 -",
            "Contagio a ti mismo, gastos médicos propios. 💸 -"
          ]
        },
        "Ingeniero": {
          mult: 1.7,
          emoji: "🔧",
          exito: [
            "Proyecto de construcción terminado exitosamente. 💰 +",
            "Diseño innovador aprobado, bonus de ejecución. 💰 +",
            "Ganaste licitación para obra grande. 💰 +",
            "Solución técnica que ahorró millones. 💰 +",
            "Promovido a jefe de proyectos. 💰 +",
            "Consultoría bien pagada para empresa grande. 💰 +",
            "Patente tecnológica que se vende. 💰 +",
            "Inspección de seguridad aprobada sin problemas. 💰 +"
          ],
          fracaso: [
            "Colapso estructural, investigación y multa. 💸 -",
            "Error de cálculo causó accident, responsabilidad civil. 💸 -",
            "Proyecto atrasado, penalización contractual. 💸 -",
            "Falla de equipo caro, tuviste que reemplazarlo. 💸 -",
            "Accidente laboral en tu obra, compensación. 💸 -",
            "Violación de códigos de construcción, multa. 💸 -",
            "Sísmo dañó estructura durante construcción. 💸 -",
            "Error de diseño costoso, rehacer todo. 💸 -"
          ]
        },
        "Streamer": {
          mult: 1.8,
          emoji: "📱",
          exito: [
            "Stream viral, sponsorships y donaciones enormes. 💰 +",
            "Contrato con plataforma exclusivo. 💰 +",
            "Torneo ganado con premio en efectivo. 💰 +",
            "Colaboración con otros streamers famosos, ingresos. 💰 +",
            "Publicidad de marca pagada bien. 💰 +",
            "Merchandise vendido muy bien. 💰 +",
            "Patreon subscribers en aumento. 💰 +",
            "Canal monetizado con excelentes ingresos. 💰 +"
          ],
          fracaso: [
            "Comentario ofensivo en directo, cancelación. 💸 -",
            "Hackeo de cuenta, perdiste todo. 💸 -",
            "Copyright strike, ingresos congelados. 💸 -",
            "Escándalo público, sponsors se retiraron. 💸 -",
            "Hardware dañado durante stream, hay que reemplazar. 💸 -",
            "Fuga de información privada, crisis de reputación. 💸 -",
            "Acusación falsa de abuso, investigación costosa. 💸 -",
            "Fin de amistad con colaborador importante. 💸 -"
          ]
        },
        "Diseñador": {
          mult: 1.8,
          emoji: "🎨",
          exito: [
            "Diseño ganador de premio internacional. 💰 +",
            "Cliente millonario contrató para proyecto enorme. 💰 +",
            "Portafolio vendido a agencia grande. 💰 +",
            "Diseño se volvió viral, ofertas de trabajo. 💰 +",
            "Promovido a director creativo. 💰 +",
            "NFT artwork vendido por mucho dinero. 💰 +",
            "Libro de designs publicado con regalías. 💰 +",
            "Freelance premium clientes de lujo. 💰 +"
          ],
          fracaso: [
            "Cliente rechazó todo tu trabajo, sin pago. 💸 -",
            "Derechos de autor infringidos, demanda. 💸 -",
            "Computadora se dañó, perdiste proyectos importantes. 💸 -",
            "Plagio acusación, reputación dañada. 💸 -",
            "Cliente se arrepintió, canceló contrato. 💸 -",
            "Hardware perdido con archivos. 💸 -",
            "Virus eliminó tu portafolio. 💸 -",
            "Acusación falsa de robo de ideas. 💸 -"
          ]
        },
        "Taxista": {
          mult: 1.3,
          emoji: "🚕",
          exito: [
            "Pasajero borracho dejó propina de 500k. 💰 +",
            "VIP te contrató para viaje especial. 💰 +",
            "Encontraste dinero en taxi, nadie lo reclama. 💰 +",
            "Día con muchos pasajeros ricos. 💰 +",
            "Pasajero importante te recomendó, cliente fijo. 💰 +",
            "Día soleado, turistas generosos. 💰 +",
            "Conduciste sin accidentes, bonus de seguridad. 💰 +",
            "Pasajero famoso dejó propina lujo. 💰 +"
          ],
          fracaso: [
            "Accidente automovilístico, reparaciones caras. 💸 -",
            "Pasajero furioso destruyó taxi, tuviste que pagar. 💸 -",
            "Multa de tránsito importante. 💸 -",
            "Pasajero sin dinero, gastos de combustible perdidos. 💸 -",
            "Robo en taxi, perdiste todo. 💸 -",
            "Neumático pinchado, reparación urgente. 💸 -",
            "Exceso de velocidad, multa pesada. 💸 -",
            "Daño al vehículo durante el turno. 💸 -"
          ]
        },
        "Repartidor": {
          mult: 1.0,
          emoji: "🚚",
          exito: [
            "Entregaste 50 paquetes sin error, bonificación. 💰 +",
            "Cliente importante satisfecho, propina generosa. 💰 +",
            "Récord de entrega rápida. 💰 +",
            "Día sin incidentes, bonus de seguridad. 💰 +",
            "Pasaje especial bien pagado. 💰 +",
            "Cliente frecuente dejó propina grande. 💰 +",
            "Entregaste rápido durante lluvia, extra. 💰 +",
            "Promoción a supervisor de entregas. 💰 +"
          ],
          fracaso: [
            "Rompiste paquete importante, compensación. 💸 -",
            "Se perdió un envío valioso bajo tu responsabilidad. 💸 -",
            "Accidente con bicicleta/moto, lesión. 💸 -",
            "Llegaste tarde, cliente enojado canceló. 💸 -",
            "Robo de paquetes durante entrega. 💸 -",
            "Ataque de perro, gastos médicos. 💸 -",
            "Lluvia extrema, paquetes mojados. 💸 -",
            "Equivocaste dirección, cliente furioso. 💸 -"
          ]
        },
        "Profesor": {
          mult: 1.5,
          emoji: "📚",
          exito: [
            "Estudiantes ganaron concurso académico, bonificación. 💰 +",
            "Clase particular bien pagada por estudiante rico. 💰 +",
            "Libro de educación publicado, regalías. 💰 +",
            "Promovido a director académico. 💰 +",
            "Conferencia pagada en universidad importante. 💰 +",
            "Tutoría privada altamente demandada. 💰 +",
            "Beca otorgada, comisión académica. 💰 +",
            "Método de enseñanza reconocido, honorarios. 💰 +"
          ],
          fracaso: [
            "Estudiante acusó bullying, investigación. 💸 -",
            "Falta de cualificación expuesta, multa. 💸 -",
            "Clase arruinada, estudiantes se retiraron. 💸 -",
            "Error en calificaciones, compensación. 💸 -",
            "Conflicto con dirección, baja salarial. 💸 -",
            "Acusación de favoritismo, denuncia. 💸 -",
            "Material educativo dañado, reemplazo costoso. 💸 -",
            "Auditoria encontró irregularidades. 💸 -"
          ]
        },
        "Vendedor": {
          mult: 1.4,
          emoji: "🏪",
          exito: [
            "Vendiste todo el stock, comisión grande. 💰 +",
            "Cliente comprando en cantidad, bonificación. 💰 +",
            "Récord de ventas mensuales, bonus. 💰 +",
            "Producto especial vendido a precio alto. 💰 +",
            "Promovido a gerente de ventas. 💰 +",
            "Contrato con mayorista importante. 💰 +",
            "Venta a corporación grande, comisión. 💰 +",
            "Día de oferta exitosa. 💰 +"
          ],
          fracaso: [
            "Producto defectuoso, clientes enojados solicitan reembolso. 💸 -",
            "Vandalismo en tienda, daños. 💸 -",
            "Robo durante tu turno, responsabilidad. 💸 -",
            "Inventario no cuadra, investigación. 💸 -",
            "Venta fraudulenta expuesta, multa. 💸 -",
            "Cliente reclama, tuviste que devolver. 💸 -",
            "Accidente en tienda, responsabilidad. 💸 -",
            "Mercancía expirada, tuviste que desechar. 💸 -"
          ]
        },
        "Plomero": {
          mult: 1.5,
          emoji: "🔌",
          exito: [
            "Reparación compleja bien hecha, cliente rico pagó mucho. 💰 +",
            "Trabajo de emergencia nocturno, tarifa premium. 💰 +",
            "Múltiples trabajos en un día. 💰 +",
            "Cliente importante contrató para renovación total. 💰 +",
            "Referencia de cliente llevó más trabajos. 💰 +",
            "Instalación de sistema costoso, comisión. 💰 +",
            "Contrato con constructora grande. 💰 +",
            "Mantenimiento preventivo regular pagado. 💰 +"
          ],
          fracaso: [
            "Dañaste una tubería importante, reparación costosa. 💸 -",
            "Inundación causada por tu error. 💸 -",
            "Cliente rechazó trabajo, sin pago. 💸 -",
            "Lesión durante reparación, gastos médicos. 💸 -",
            "Herramienta costosa dañada/perdida. 💸 -",
            "Contaminación de agua causada por negligencia. 💸 -",
            "Sistema instalado falló, responsabilidad. 💸 -",
            "Accidente causado por falta de seguridad. 💸 -"
          ]
        },
        "Electricista": {
          mult: 1.6,
          emoji: "⚡",
          exito: [
            "Instalación eléctrica compleja para edificio. 💰 +",
            "Reparación de emergencia de alta paga. 💰 +",
            "Sistema de energía renovable instalado. 💰 +",
            "Cliente satisfecho contrató para proyecto grande. 💰 +",
            "Certificación nueva, aumento de tarifa. 💰 +",
            "Trabajo en construcción lucrativo. 💰 +",
            "Contrato con empresa de infraestructura. 💰 +",
            "Mantenimiento de sistema importante. 💰 +"
          ],
          fracaso: [
            "Electrocución durante trabajo, hospitalización. 💸 -",
            "Causaste cortocircuito, incendio. 💸 -",
            "Instalación falló, daño al cliente. 💸 -",
            "No pasó inspección de seguridad. 💸 -",
            "Equipo costoso dañado. 💸 -",
            "Lesión grave en el trabajo. 💸 -",
            "Sistema falla después de instalación. 💸 -",
            "Violación de código eléctrico, multa. 💸 -"
          ]
        },
        "Guardia": {
          mult: 1.4,
          emoji: "👮",
          exito: [
            "Noche tranquila, turno completado, bonus. 💰 +",
            "Previniste robo importante, recompensa. 💰 +",
            "Cliente VIP satisfecho, propina. 💰 +",
            "Vigilancia en evento importante bien pagado. 💰 +",
            "Entrenamiento exitoso, aumento. 💰 +",
            "Seguridad privada de ejecutivo millonario. 💰 +",
            "Patrullaje sin incidentes, bonus. 💰 +",
            "Prevención de asalto, recompensa. 💰 +"
          ],
          fracaso: [
            "Intento de robo pasó bajo tu vigilancia. 💸 -",
            "Cliente importante robado, responsabilidad. 💸 -",
            "Dormir en guardia, castigo. 💸 -",
            "Pelea con intrusos, lesiones. 💸 -",
            "Fallo en sistema de seguridad. 💸 -",
            "Acusación de complicidad. 💸 -",
            "Equipo de seguridad dañado. 💸 -",
            "Abandono de puesto, multa. 💸 -"
          ]
        }
      };
      
      // Obtener profesión actual o asignar una al azar
      if (!user.profesion) {
        user.profesion = Object.keys(profesiones)[Math.floor(Math.random() * Object.keys(profesiones).length)];
      }
      
      const prof = profesiones[user.profesion];
      if (!prof) {
        user.profesion = Object.keys(profesiones)[0];
      }
      
      // Determinar éxito o fracaso (70% éxito, 30% fracaso)
      const esExitoso = Math.random() < 0.7;
      
      // Seleccionar mensaje narrativo
      const mensajes = esExitoso ? prof.exito : prof.fracaso;
      const narrativa = mensajes[Math.floor(Math.random() * mensajes.length)];
      
      // Calcular dinero
      const gananciaBase = Math.floor(Math.random() * 5000) + 4000 + (user.nivel * 80);
      const gananciaFinal = Math.floor(gananciaBase * prof.mult);
      
      let dineroFinal = gananciaFinal;
      if (!esExitoso) {
        dineroFinal = -Math.floor(gananciaFinal * 0.6); // Pierde 60% de lo que hubiera ganado
      }
      
      user.dinero += dineroFinal;
      user.ultimoTrabajo = ahora;
      
      // Agregar EXP solo si tuvo éxito
      if (esExitoso) {
        addExp(user, Math.floor(gananciaFinal / 100));
      }
      
      guardarBD();
      if (user.dinero >= 100000) grantAchievement(user, 'rico');
      
      const emoji = esExitoso ? "✅" : "❌";
      const tipoOperacion = esExitoso ? "ganaste" : "perdiste";
      const monto = Math.abs(dineroFinal);
      
      await sock.sendMessage(chatId, { 
        text: `*✦ JORNADA LABORAL ✦*\n\n${prof.emoji} *Profesión:* ${user.profesion}\n\n📖 ${narrativa}${monto.toLocaleString()}\n\n${emoji} *Resultado:* ${tipoOperacion.toUpperCase()} $${monto.toLocaleString()}\n💎 *Dinero actual:* *$${user.dinero.toLocaleString()}*\n\n💡 *Tip:* Usa *#cambiar-trabajo* para cambiar de profesión`
      }, { quoted: msg });
    }

    if (body === "#cambiar-trabajo") {
      const profesiones = {
        "Policía": { mult: 1.4, emoji: "👮" },
        "Chef": { mult: 1.5, emoji: "👨‍🍳" },
        "Programador": { mult: 1.6, emoji: "💻" },
        "Ingeniero": { mult: 1.7, emoji: "🔧" },
        "Abogado": { mult: 1.9, emoji: "⚖️" },
        "Médico": { mult: 1.8, emoji: "👨‍⚕️" },
        "Streamer": { mult: 1.8, emoji: "📱" },
        "Diseñador": { mult: 1.8, emoji: "🎨" },
        "Piloto": { mult: 2.0, emoji: "✈️" },
        "Taxista": { mult: 1.3, emoji: "🚕" },
        "Repartidor": { mult: 1.0, emoji: "🚚" },
        "Profesor": { mult: 1.5, emoji: "📚" },
        "Vendedor": { mult: 1.4, emoji: "🏪" },
        "Plomero": { mult: 1.5, emoji: "🔌" },
        "Electricista": { mult: 1.6, emoji: "⚡" },
        "Guardia": { mult: 1.4, emoji: "👮" }
      };
      
      let lista = "*✦ PROFESIONES DISPONIBLES ✦*\n\n";
      
      let index = 1;
      for (const [nombre, datos] of Object.entries(profesiones)) {
        lista += `${index}. ${datos.emoji} *${nombre}* (x${datos.mult})\n`;
        index++;
      }
      
      lista += `\n*Usa:* #trabajar-como <número>\n\n*Ejemplo:* #trabajar-como 9`;
      
      if (user.profesion && profesiones[user.profesion]) {
        lista += `\n\n👤 *Profesión actual:* ${profesiones[user.profesion]?.emoji} ${user.profesion}`;
      }
      
      await sock.sendMessage(chatId, { text: lista }, { quoted: msg });
    }

    if (body.startsWith("#trabajar-como")) {
      const profesiones = [
        { nombre: "Policía", mult: 1.4, emoji: "👮" },
        { nombre: "Chef", mult: 1.5, emoji: "👨‍🍳" },
        { nombre: "Programador", mult: 1.6, emoji: "💻" },
        { nombre: "Ingeniero", mult: 1.7, emoji: "🔧" },
        { nombre: "Abogado", mult: 1.9, emoji: "⚖️" },
        { nombre: "Médico", mult: 1.8, emoji: "👨‍⚕️" },
        { nombre: "Streamer", mult: 1.8, emoji: "📱" },
        { nombre: "Diseñador", mult: 1.8, emoji: "🎨" },
        { nombre: "Piloto", mult: 2.0, emoji: "✈️" },
        { nombre: "Taxista", mult: 1.3, emoji: "🚕" },
        { nombre: "Repartidor", mult: 1.0, emoji: "🚚" },
        { nombre: "Profesor", mult: 1.5, emoji: "📚" },
        { nombre: "Vendedor", mult: 1.4, emoji: "🏪" },
        { nombre: "Plomero", mult: 1.5, emoji: "🔌" },
        { nombre: "Electricista", mult: 1.6, emoji: "⚡" },
        { nombre: "Guardia", mult: 1.4, emoji: "👮" }
      ];
      
      const args = body.split(" ");
      const numero = parseInt(args[1]) - 1;
      
      if (isNaN(numero) || numero < 0 || numero >= profesiones.length) {
        await sock.sendMessage(chatId, { text: `❌ Número inválido\n\nUsa: #cambiar-trabajo para ver la lista` }, { quoted: msg });
        return;
      }
      
      const nuevaProf = profesiones[numero];
      user.profesion = nuevaProf.nombre;
      guardarBD();
      
      await sock.sendMessage(chatId, { text: `${nuevaProf.emoji} *Profesión cambiada a:* ${nuevaProf.nombre}\n*Multiplicador:* x${nuevaProf.mult}\n\n¡Ahora tienes 30% de riesgo pero ganas más dinero si tienes éxito!` }, { quoted: msg });
    }

    // Comandos adicionales para obtener dinero
    if (body.startsWith('#recolectar')) {
      const ahora = Date.now();
      const cooldown = 5 * 60 * 1000; // 5 minutos
      const tiempoRestante = (user.ultimaRecolecta || 0) + cooldown - ahora;
      if (tiempoRestante > 0) {
        const seg = Math.ceil(tiempoRestante / 1000);
        await sock.sendMessage(chatId, { text: `⏳ Espera ${seg}s para recolectar de nuevo.` }, { quoted: msg });
        return;
      }
      const ganancia = Math.floor(Math.random() * 1500) + 800;
      user.dinero = (user.dinero || 0) + ganancia;
      user.ultimaRecolecta = ahora;
      guardarBD();
      await sock.sendMessage(chatId, { text: `🌿 RECOLECTA COMPLETADA\n\n💰 Ganancia: +$${ganancia.toLocaleString()}\n💎 Total: *$${user.dinero.toLocaleString()}*` }, { quoted: msg });
      return;
    }

    if (body.startsWith('#minar')) {
      const ahora = Date.now();
      const cooldown = 10 * 60 * 1000; // 10 minutos
      const tiempoRestante = (user.ultimaMineria || 0) + cooldown - ahora;
      if (tiempoRestante > 0) {
        const minutos = Math.ceil(tiempoRestante / 60000);
        await sock.sendMessage(chatId, { text: `⏳ Minando. Espera ${minutos}m.` }, { quoted: msg });
        return;
      }
      const base = Math.floor(Math.random() * 8000) + 2000;
      const bonusFragment = Math.random() < 0.25;
      user.dinero = (user.dinero || 0) + base;
      user.ultimaMineria = ahora;
      let bonusText = '';
      if (bonusFragment) {
        const fragList = fragmentosData.fragmentos || [];
        if (fragList.length) {
          const f = fragList[Math.floor(Math.random() * fragList.length)];
          user.fragmentos = user.fragmentos || {};
          user.fragmentos[f.id] = (user.fragmentos[f.id] || 0) + 1;
          bonusText = `\n\n💎 ¡HALLAZGO RARO! +1 ${f.nombre || 'Fragmento'}`;
        }
      }
      guardarBD();
      await sock.sendMessage(chatId, { text: `*✦ MINERÍA COMPLETADA ✦*\n\n💰 MINADO: +$${base.toLocaleString()}${bonusText}\n\n💎 DINERO TOTAL: *$${user.dinero.toLocaleString()}*` }, { quoted: msg });
      return;
    }

    // ----- CAZA (Hunting) -----
    if (body.startsWith('#caza')) {
      const ahora = Date.now();
      const cooldown = 8 * 60 * 1000; // 8 minutos
      const tiempoRestante = (user.ultimaCaza || 0) + cooldown - ahora;
      if (tiempoRestante > 0) {
        const minutos = Math.ceil(tiempoRestante / 60000);
        await sock.sendMessage(chatId, { text: `🦌 CAZA EN PROGRESO\n\n⏱️ Tu próxima cacería estará lista en *${minutos}m*` }, { quoted: msg });
        return;
      }
      const piezas = ['Venado', 'Jabalí', 'Conejo', 'Faisán', 'Oso pardo', 'Lince', 'Zorro plateado', 'Ciervos nobles'];
      const piezaRandom = piezas[Math.floor(Math.random() * piezas.length)];
      const ganancia = Math.floor(Math.random() * 4000) + 2500;
      user.dinero = (user.dinero || 0) + ganancia;
      user.ultimaCaza = ahora;
      
      let bonusHunt = '';
      if (Math.random() < 0.20) {
        const bonusExtra = Math.floor(Math.random() * 2000) + 1000;
        user.dinero += bonusExtra;
        bonusHunt = `\n\n🌟 BONUS PIEZA RARA: +$${bonusExtra.toLocaleString()}!`;
      }
      guardarBD();
      await sock.sendMessage(chatId, { text: `*✦ CAZA COMPLETADA ✦*\n\n🎯 PIEZA: ${piezaRandom}\n💰 GANANCIA: +$${ganancia.toLocaleString()}${bonusHunt}\n\n💎 DINERO TOTAL: *$${user.dinero.toLocaleString()}*` }, { quoted: msg });
    }

    // ----- FORESTAL (Forest Logging) -----
    if (body.startsWith('#forestal') || body.startsWith('#bosque')) {
      const ahora = Date.now();
      const cooldown = 6 * 60 * 1000; // 6 minutos
      const tiempoRestante = (user.ultimaForestal || 0) + cooldown - ahora;
      if (tiempoRestante > 0) {
        const minutos = Math.ceil(tiempoRestante / 60000);
        await sock.sendMessage(chatId, { text: `🌲 TALA FORESTAL\n\n⏱️ Tu próxima sesión estará lista en *${minutos}m*` }, { quoted: msg });
        return;
      }
      const maderas = ['Roble', 'Pino dorado', 'Arce', 'Caoba', 'Teca', 'Cedro aromático', 'Ébano', 'Bambú gigante'];
      const maderaRandom = maderas[Math.floor(Math.random() * maderas.length)];
      const ganancia = Math.floor(Math.random() * 3500) + 2000;
      user.dinero = (user.dinero || 0) + ganancia;
      user.ultimaForestal = ahora;
      
      let bonusForest = '';
      if (Math.random() < 0.18) {
        const bonusExtra = Math.floor(Math.random() * 1800) + 900;
        user.dinero += bonusExtra;
        bonusForest = `\n\n🌟 BONUS MADERA PREMIUM: +$${bonusExtra.toLocaleString()}!`;
      }
      guardarBD();
      await sock.sendMessage(chatId, { text: `*✦ TALA COMPLETADA ✦*\n\n📦 MADERA: ${maderaRandom}\n💰 GANANCIA: +$${ganancia.toLocaleString()}${bonusForest}\n\n💎 DINERO TOTAL: *$${user.dinero.toLocaleString()}*` }, { quoted: msg });
    }

    // ----- SISTEMA DE REFERIDOS (referral) -----
    if (body.startsWith('#referral')) {
      const args = body.split(/\s+/).filter(Boolean);
      if (args.length === 1) {
        if (!user.referralCode) {
          user.referralCode = 'R' + Math.random().toString(36).slice(2,8).toUpperCase();
          guardarBD();
        }
        await sock.sendMessage(chatId, { text: `*✦ PROGRAMA DE REFERIDOS ✦*\n\n🔗 TU CÓDIGO: *${user.referralCode}*\n\n💰 RECOMPENSAS:\n  ▸ Amigo invitado: +$3000\n  ▸ Tú recibes: +$2000\n\n📣 Comparte tu código para ganar dinero extra\n\n📝 Para reclamar: #referral reclamar <codigo>` }, { quoted: msg });
        return;
      }
      if ((args[1] === 'claim' || args[1] === 'reclamar') && args[2]) {
        const code = args[2].toUpperCase();
        if (user.referredBy) { await sock.sendMessage(chatId, { text: '❌ Ya reclamaste un referido anteriormente.' }, { quoted: msg }); return; }
        const refUserId = Object.keys(usuarios).find(k => (usuarios[k].referralCode||'').toUpperCase() === code);
        if (!refUserId) { await sock.sendMessage(chatId, { text: '❌ Código no válido.' }, { quoted: msg }); return; }
        if (refUserId === senderId) { await sock.sendMessage(chatId, { text: '❌ No puedes usar tu propio código' }, { quoted: msg }); return; }
        usuarios[refUserId].dinero = (usuarios[refUserId].dinero||0) + 3000;
        user.dinero = (user.dinero||0) + 2000;
        user.referredBy = refUserId;
        guardarBD();
        await sock.sendMessage(chatId, { text: `✅ REFERIDO ACEPTADO!\n\n@${refUserId.split('@')[0]} recibe +$3000\nTú recibes +$2000\n\n💰 ¡Gana más dinero compartiendo tu código!`, mentions: [refUserId] }, { quoted: msg });
        return;
      }
      // ayuda
      await sock.sendMessage(chatId, { text: '📋 Referral:\n#referral → Muestra tu código\n#referral reclamar <codigo> → Reclamar referido' }, { quoted: msg });
    }

    // ----- SORTEOS (raffle) -----
    if (body.startsWith('#sorteo')) {
      const args = body.split(/\s+/).filter(Boolean);
      const cmd = args[1] || '';
      if (cmd === 'crear' && args.length >= 3) {
        const ticket = parseInt(args[2]);
        const descripcion = args.slice(3).join(' ') || 'Sorteo';
        if (isNaN(ticket) || ticket <= 0) { await sock.sendMessage(chatId, { text: 'Uso: #sorteo crear <precioTicket> <descripcion>' }, { quoted: msg }); return; }
        raffles[chatId] = { creator: senderId, ticketPrice: ticket, description: descripcion, participants: [] };
        persistRaffles();
        await sock.sendMessage(chatId, { text: `🎟️ Sorteo creado: ${descripcion}\nPrecio por ticket: $${ticket}\nParticipa con: #sorteo participar` }, { quoted: msg });
        return;
      }
      if (cmd === 'participar') {
        const r = raffles[chatId];
        if (!r) { await sock.sendMessage(chatId, { text: '❌ Sin sorteos activos aquí' }, { quoted: msg }); return; }
        if ((user.dinero || 0) < r.ticketPrice) { await sock.sendMessage(chatId, { text: `❌ Dinero insuficiente ($${r.ticketPrice})` }, { quoted: msg }); return; }
        if (r.participants.includes(senderId)) { await sock.sendMessage(chatId, { text: '❌ Ya participaste en este sorteo.' }, { quoted: msg }); return; }
        user.dinero -= r.ticketPrice;
        r.participants.push(senderId);
        guardarBD();
        persistRaffles();
        await sock.sendMessage(chatId, { text: `✅ Ticket comprado. Participantes: ${r.participants.length}` }, { quoted: msg });
        return;
      }
      if (cmd === 'cerrar') {
        const r = raffles[chatId];
        if (!r) { await sock.sendMessage(chatId, { text: '❌ Sin sorteos activos' }, { quoted: msg }); return; }
        // permitir cerrar al creador o a un admin del grupo
        let allowClose = false;
        if (r.creator === senderId) allowClose = true;
        try {
          const metadata = await sock.groupMetadata(chatId);
          const participante = metadata.participants.find(p => p.id === senderId);
          if (participante && (participante.admin === 'admin' || participante.admin === 'superadmin' || participante.isAdmin)) allowClose = true;
        } catch (e) { /* no es grupo o error */ }
        if (!allowClose) { await sock.sendMessage(chatId, { text: '❌ Solo el creador o un admin puede cerrar el sorteo.' }, { quoted: msg }); return; }
        if (!r.participants || r.participants.length === 0) { delete raffles[chatId]; await sock.sendMessage(chatId, { text: '⚠️ Sorteo cerrado sin participantes.' }, { quoted: msg }); return; }
        const winner = r.participants[Math.floor(Math.random() * r.participants.length)];
        const pot = r.participants.length * r.ticketPrice;
        const fee = Math.floor(pot * 0.05);
        const premio = pot - fee;
        usuarios[winner].dinero = (usuarios[winner].dinero||0) + premio;
        delete raffles[chatId];
        guardarBD();
        persistRaffles();
        await sock.sendMessage(chatId, { text: `🎉 Sorteo finalizado! Ganador: @${winner.split('@')[0]} — Premio: $${premio}`, mentions: [winner] }, { quoted: msg });
        return;
      }
      if (cmd === 'estado' || cmd === 'info') {
        const r = raffles[chatId];
        if (!r) { await sock.sendMessage(chatId, { text: 'No hay sorteos activos aquí.' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: `🎟️ Sorteo: ${r.description}\nTicket: $${r.ticketPrice}\nParticipantes: ${r.participants.length}` }, { quoted: msg });
        return;
      }
      // ayuda
      await sock.sendMessage(chatId, { text: 'Sorteos: #sorteo crear <precio> <desc> | #sorteo participar | #sorteo cerrar | #sorteo estado' }, { quoted: msg });
      return;
    }

    // ----- RETO DIARIO (grupo) -----
    if (body.startsWith('#reto_diario')) {
      const args = body.split(/\s+/).filter(Boolean);
      const accion = args[1] || 'estado';
      retosDiarios[chatId] = retosDiarios[chatId] || { participants: new Set() };
      if (accion === 'unirse' || accion === 'join') {
        retosDiarios[chatId].participants.add(senderId);
        const count = retosDiarios[chatId].participants.size;
        if (count >= 5) {
          const winners = Array.from(retosDiarios[chatId].participants);
          for (const p of winners) { usuarios[p].dinero = (usuarios[p].dinero||0) + 500; }
          retosDiarios[chatId] = { participants: new Set() };
          guardarBD();
          persistRetos();
          await sock.sendMessage(chatId, { text: `🏆 Reto completado! ${winners.length} participantes recibieron $500 cada uno.` }, { quoted: msg });
          return;
        }
        await sock.sendMessage(chatId, { text: `✅ Te uniste al reto diario. Participantes: ${count}/5` }, { quoted: msg });
        persistRetos();
        return;
      }
      if (accion === 'estado') {
        const count = retosDiarios[chatId].participants.size || 0;
        await sock.sendMessage(chatId, { text: `📊 Reto diario: ${count}/5 participantes. Únete con: #reto_diario unirse` }, { quoted: msg });
        return;
      }
      if (accion === 'reset') {
        retosDiarios[chatId] = { participants: new Set() };
        persistRetos();
        await sock.sendMessage(chatId, { text: '🔁 Reto diario reiniciado.' }, { quoted: msg });
        return;
      }
      await sock.sendMessage(chatId, { text: 'Uso: #reto_diario unirse | #reto_diario estado | #reto_diario reset' }, { quoted: msg });
      return;
    }

    // ----- MERCADO AVANZADO CON SUBASTAS 🏪 -----
    if (body === '#mercado' || body === '#market') {
      if (mercadoItems.length === 0) {
        await sock.sendMessage(chatId, { text: '🏪 MERCADO VACÍO\n\nUsa:\n  #listar <itemId> <precio> - Listar en mercado\n  #subasta <itemId> <precio> [minutos] - Crear subasta' }, { quoted: msg });
        return;
      }
      const activos = mercadoItems.filter(m => m.estado === 'activo').slice(-10).reverse();
      let txt = `🏪 MERCADO P2P (Últimos ${activos.length})\n\n`;
      for (const item of activos) {
        const tiempoAgo = Math.floor((Date.now() - item.listaEn) / 60000);
        txt += `${item.nombre} (${item.rareza})\n`;
        txt += `  💰 $${item.precioBase.toLocaleString()}\n`;
        txt += `  👤 Vendedor: ${(usuarios[item.vendedor]?.nombre) || 'Anónimo'}\n`;
        txt += `  🆔 ${item.id}\n`;
        txt += `  ⏱️ Hace ${tiempoAgo}m\n\n`;
      }
      txt += `💡 Usa #compramkt <id> para comprar\n`;
      txt += `📊 Usa #subastas para ver subastas activas`;
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === '#subastas') {
      const activas = subastas.filter(s => s.estado === 'activa');
      if (activas.length === 0) {
        await sock.sendMessage(chatId, { text: '🔨 Sin subastas activas en este momento.\n\nUsa #subasta <itemId> <precio> [minutos] para crear una.' }, { quoted: msg });
        return;
      }
      let txt = `🔨 SUBASTAS ACTIVAS (${activas.length})\n\n`;
      for (const sub of activas.slice(-10).reverse()) {
        const tiempoRest = Math.ceil((sub.fin - Date.now()) / 60000);
        const ofertaActual = sub.ofertas.length > 0 ? sub.ofertas[sub.ofertas.length - 1].monto : sub.precioBase;
        txt += `${sub.nombre} (${sub.rareza})\n`;
        txt += `  💵 Precio base: $${sub.precioBase.toLocaleString()}\n`;
        txt += `  📈 Oferta actual: $${ofertaActual.toLocaleString()} (${sub.ofertas.length} oferta${sub.ofertas.length !== 1 ? 's' : ''})\n`;
        txt += `  ⏱️ ${tiempoRest}m restantes\n`;
        txt += `  🆔 ${sub.id}\n\n`;
      }
      txt += `💡 Usa #ofertar <id> <monto> para pujar`;
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('#listar ')) {
      const args = body.split(' ');
      if (args.length < 3) {
        await sock.sendMessage(chatId, { text: 'Uso: #listar <itemId> <precio>' }, { quoted: msg });
        return;
      }
      const itemId = args[1];
      const precio = parseInt(args[2]);
      if (isNaN(precio) || precio <= 0) {
        await sock.sendMessage(chatId, { text: '❌ Precio inválido.' }, { quoted: msg });
        return;
      }
      const item = buscarItem(itemId);
      if (!item) {
        await sock.sendMessage(chatId, { text: '❌ Item no encontrado.' }, { quoted: msg });
        return;
      }
      if (!user.inventario[itemId] || user.inventario[itemId] < 1) {
        await sock.sendMessage(chatId, { text: `❌ No tienes ${item.nombre}.` }, { quoted: msg });
        return;
      }
      user.inventario[itemId]--;
      const listing = crearListadoMercado(senderId, itemId, item.nombre, item.rareza || item.categoria, precio);
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ ¡Item listado en mercado!\n\n${item.nombre}\n💰 Precio: $${precio.toLocaleString()}\n🆔 ID: ${listing.id}` }, { quoted: msg });
      return;
    }

    if (body.startsWith('#compramkt ')) {
      const listingId = body.split(' ')[1];
      const listing = mercadoItems.find(m => m.id === listingId && m.estado === 'activo');
      if (!listing) {
        await sock.sendMessage(chatId, { text: '❌ Listado no encontrado o vendido.' }, { quoted: msg });
        return;
      }
      if (user.dinero < listing.precioBase) {
        await sock.sendMessage(chatId, { text: `❌ Dinero insuficiente ($${listing.precioBase.toLocaleString()})` }, { quoted: msg });
        return;
      }
      const vendedor = usuarios[listing.vendedor];
      if (!vendedor) {
        await sock.sendMessage(chatId, { text: '❌ Vendedor no encontrado.' }, { quoted: msg });
        return;
      }
      const comision = Math.floor(listing.precioBase * 0.05);
      const montoVendedor = listing.precioBase - comision;
      user.dinero -= listing.precioBase;
      vendedor.dinero = (vendedor.dinero || 0) + montoVendedor;
      if (!user.inventario) user.inventario = {};
      user.inventario[listing.itemId] = (user.inventario[listing.itemId] || 0) + 1;
      listing.estado = 'vendido';
      historialTransacciones.push({
        id: 'trx_' + Date.now(),
        vendedor: listing.vendedor,
        comprador: senderId,
        itemId: listing.itemId,
        nombre: listing.nombre,
        precio: listing.precioBase,
        fecha: Date.now(),
        tipo: 'venta_directa'
      });
      guardarBD();
      saveMercadoItems();
      saveHistorialTransacciones();
      await sock.sendMessage(chatId, { text: `✅ ¡Compra exitosa!\n\n${listing.nombre}\n💰 Precio: $${listing.precioBase.toLocaleString()}\n🎉 Item agregado a tu inventario` }, { quoted: msg });
      return;
    }

    if (body.startsWith('#subasta ')) {
      const args = body.split(' ');
      if (args.length < 3) {
        await sock.sendMessage(chatId, { text: 'Uso: #subasta <itemId> <precio> [duración_minutos]' }, { quoted: msg });
        return;
      }
      const itemId = args[1];
      const precioBase = parseInt(args[2]);
      const duracion = parseInt(args[3]) || 60; // 1 hora por defecto
      if (isNaN(precioBase) || precioBase <= 0 || isNaN(duracion) || duracion < 5) {
        await sock.sendMessage(chatId, { text: '❌ Valores inválidos. Duración mínima: 5 minutos.' }, { quoted: msg });
        return;
      }
      if (duracion > 1440) {
        await sock.sendMessage(chatId, { text: '❌ Duración máxima: 1440 minutos (24 horas).' }, { quoted: msg });
        return;
      }
      const item = buscarItem(itemId);
      if (!item) {
        await sock.sendMessage(chatId, { text: '❌ Item no encontrado.' }, { quoted: msg });
        return;
      }
      if (!user.inventario[itemId] || user.inventario[itemId] < 1) {
        await sock.sendMessage(chatId, { text: `❌ No tienes ${item.nombre}.` }, { quoted: msg });
        return;
      }
      user.inventario[itemId]--;
      const subasta = crearSubasta(senderId, itemId, item.nombre, item.rareza || item.categoria, precioBase, duracion);
      guardarBD();
      await sock.sendMessage(chatId, { text: `🔨 ¡Subasta creada!\n\n${item.nombre}\n💰 Precio base: $${precioBase.toLocaleString()}\n⏱️ Duración: ${duracion}m\n🆔 ID: ${subasta.id}\n\n💡 Usa #ofertar <id> <monto> para pujar` }, { quoted: msg });
      return;
    }

    if (body.startsWith('#ofertar ')) {
      const args = body.split(' ');
      if (args.length < 3) {
        await sock.sendMessage(chatId, { text: 'Uso: #ofertar <id_subasta> <monto>' }, { quoted: msg });
        return;
      }
      const subastaId = args[1];
      const monto = parseInt(args[2]);
      const subasta = subastas.find(s => s.id === subastaId && s.estado === 'activa');
      if (!subasta) {
        await sock.sendMessage(chatId, { text: '❌ Subasta no encontrada o finalizada.' }, { quoted: msg });
        return;
      }
      const montoMinimo = subasta.ofertas.length > 0 
        ? subasta.ofertas[subasta.ofertas.length - 1].monto + 100
        : subasta.precioBase;
      if (isNaN(monto) || monto < montoMinimo) {
        await sock.sendMessage(chatId, { text: `❌ Monto inválido.\n\nMínimo: $${montoMinimo.toLocaleString()}` }, { quoted: msg });
        return;
      }
      if (user.dinero < monto) {
        await sock.sendMessage(chatId, { text: `❌ Dinero insuficiente ($${monto.toLocaleString()})` }, { quoted: msg });
        return;
      }
      subasta.ofertas.push({
        comprador: senderId,
        monto,
        fecha: Date.now()
      });
      saveSubastas();
      const tiempoRest = Math.ceil((subasta.fin - Date.now()) / 60000);
      await sock.sendMessage(chatId, { text: `✅ ¡Oferta registrada!\n\n${subasta.nombre}\n💵 Tu oferta: $${monto.toLocaleString()}\n👤 Ofertas totales: ${subasta.ofertas.length}\n⏱️ ${tiempoRest}m restantes` }, { quoted: msg });
      return;
    }

    if (body === '#historial') {
      if (historialTransacciones.length === 0) {
        await sock.sendMessage(chatId, { text: '📊 Sin transacciones registradas aún.' }, { quoted: msg });
        return;
      }
      let txt = `📊 HISTORIAL DE TRANSACCIONES (Últimas 10)\n\n`;
      const miasTransacciones = historialTransacciones.filter(t => t.vendedor === senderId || t.comprador === senderId).slice(-10).reverse();
      for (const trx of miasTransacciones) {
        const esVenta = trx.vendedor === senderId;
        const otro = esVenta ? usuarios[trx.comprador] : usuarios[trx.vendedor];
        txt += `${esVenta ? '📤 VENTA' : '📥 COMPRA'} - ${trx.nombre}\n`;
        txt += `  💰 $${trx.precio.toLocaleString()}\n`;
        txt += `  👤 ${otro?.nombre || 'Anónimo'}\n`;
        txt += `  ${trx.tipo === 'subasta' ? '🔨 Por subasta' : '🛒 Venta directa'}\n\n`;
      }
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    // mostrar banco (alias de #bal con foco en banco)
    if (body === '#banco') {
      user.dinero = typeof user.dinero === 'number' ? user.dinero : 0;
      user.banco = typeof user.banco === 'number' ? user.banco : 0;
      const total = user.dinero + user.banco;
      const interesEstimado = Math.floor(user.banco * 0.01);
      await sock.sendMessage(chatId, { text: `*✦ BANCO ✦*\n\n💰 EN MANO: *$${user.dinero.toLocaleString()}*\n🏦 EN BANCO: *$${user.banco.toLocaleString()}*\n💎 TOTAL: *$${total.toLocaleString()}*\n\n📈 Interés estimado diario: +$${interesEstimado.toLocaleString()}` }, { quoted: msg });
      return;
    }

    if (body.startsWith("#bal") || body.startsWith("#balance") || body.startsWith("#dinero")) {
      // Asegurar que los campos existen y son números
      user.dinero = typeof user.dinero === 'number' ? user.dinero : 0;
      user.banco = typeof user.banco === 'number' ? user.banco : 0;
      user.inversionesPendientes = Array.isArray(user.inversionesPendientes) ? user.inversionesPendientes : [];
      procesarInversiones(user, senderId);
      const total = user.dinero + user.banco;
      const interesEstimado = Math.floor(user.banco * 0.01);
      let inversionesTexto = "";
      if (user.inversionesPendientes.length > 0 && user.inversionesPendientes[0].vencimiento) {
        const tiempoRestante = user.inversionesPendientes[0].vencimiento - Date.now();
        const minutosRestantes = Math.ceil(tiempoRestante / 60000);
        inversionesTexto = `\n\n💼 INVERSIONES PENDIENTES: *${user.inversionesPendientes.length}*\n⏱️ Próxima lista en: *${minutosRestantes}m*`;
      }
      await sock.sendMessage(chatId, { 
        text: `💰 *BALANCE FINANCIERO*\n\n💵 En mano: $${user.dinero.toLocaleString()}\n🏦 En banco: $${user.banco.toLocaleString()}\n💎 Total: $${total.toLocaleString()}\n\n📈 Interés diario: +$${interesEstimado.toLocaleString()}${inversionesTexto}`
      }, { quoted: msg });
    }

    if (body.startsWith("#d ")) {
      const args = body.split(" ");
      if (args.length < 2) {
        await sock.sendMessage(chatId, { text: `◈ Uso correcto: *#d [cantidad]*\n\nEjemplo: *#d 1000*` }, { quoted: msg });
        return;
      }
      const cantidad = parseInt(args[1]);
      if (isNaN(cantidad) || cantidad <= 0) {
        await sock.sendMessage(chatId, { text: `◈ Cantidad inválida\n\nDebe ser un número positivo` }, { quoted: msg });
        return;
      }
      if (user.dinero < cantidad) {
        await sock.sendMessage(chatId, { 
          text: `❌ Dinero insuficiente. Tienes $${user.dinero.toLocaleString()}`
        }, { quoted: msg });
        return;
      }
      user.dinero -= cantidad;
      user.banco += cantidad;
      guardarBD();
      await sock.sendMessage(chatId, { 
        text: `*✦ DEPÓSITO EXITOSO ✦*\n\n✅ DEPOSITASTE: *$${cantidad.toLocaleString()}*\n\n💵 EN MANO: *$${user.dinero.toLocaleString()}*\n🏦 EN BANCO: *$${user.banco.toLocaleString()}*\n💎 TOTAL: *$${(user.dinero + user.banco).toLocaleString()}*`
      }, { quoted: msg });
    }

    if (body.startsWith("#retirar ")) {
      const args = body.split(" ");
      if (args.length < 2) {
        await sock.sendMessage(chatId, { text: `❌ Uso: #retirar [cantidad]\n\nEj: #retirar 1000` }, { quoted: msg });
        return;
      }
      const cantidad = parseInt(args[1]);
      if (isNaN(cantidad) || cantidad <= 0) {
        await sock.sendMessage(chatId, { text: `◈ Cantidad inválida\n\nDebe ser un número positivo` }, { quoted: msg });
        return;
      }
      if (user.banco < cantidad) {
        await sock.sendMessage(chatId, { 
          text: `❌ Saldo insuficiente. Tienes $${user.banco.toLocaleString()} en el banco`
        }, { quoted: msg });
        return;
      }
      user.banco -= cantidad;
      user.dinero += cantidad;
      guardarBD();
      await sock.sendMessage(chatId, { 
        text: `*✦ RETIRO EXITOSO ✦*\n\n✅ RETIRASTE: *$${cantidad.toLocaleString()}*\n\n💵 EN MANO: *$${user.dinero.toLocaleString()}*\n🏦 EN BANCO: *$${user.banco.toLocaleString()}*\n💎 TOTAL: *$${(user.dinero + user.banco).toLocaleString()}*`
      }, { quoted: msg });
    }

    if (body.startsWith("#robar") || body.startsWith("#rob")) {
      const ahora = Date.now();
      const cooldown = 120000; // cooldown reducido a 2 minutos
      const tiempoRestante = user.ultimoRobo + cooldown - ahora;
      if (tiempoRestante > 0) {
        const horas = Math.ceil(tiempoRestante / 3600000);
        await sock.sendMessage(chatId, { 
          text: `◊ Las autoridades te están vigilando\n※ Podrás hacer actividades ilegales en *${horas}* horas`
        }, { quoted: msg });
        return;
      }
      const exito = Math.random() > 0.3;
      if (exito) {
        const ganancia = Math.floor(Math.random() * 3000) + 1500 + (user.nivel * 30);
        user.dinero += ganancia;
        user.ultimoRobo = ahora;
        guardarBD();
        const actividades = [
          "robaste un banco",
          "hackeaste una empresa",
          "vendiste información",
          "robaste un auto de lujo",
          "estafaste una tienda",
          // opciones chistosas
          "robaste una heladería clandestina",
          "hurtaste el carrito de hot dogs del parque",
          "te llevaste la contraseña WiFi del vecino",
          "intercambiaste cromos raros por efectivo",
          "robaste un dron de reparto",
          "sustraiste un peluche gigante de feria",
          "hackeaste la impresora fiscal (solo folios)",
          "robaste un pañuelo de la reina (metafórico)",
          "hurtaste una colección de stickers vintage",
          "te comiste la última porción del pastel de la oficina"
        ];
        const actividadRandom = actividades[Math.floor(Math.random() * actividades.length)];
        await sock.sendMessage(chatId, { 
          text: `◈ ¡Robo exitoso!\n\n◉ Actividad: *${actividadRandom}*\n▲ Ganaste: *$${ganancia.toLocaleString()}* coins universal\n◉ Tus coins universal: *$${user.dinero.toLocaleString()}*\n◊ ¡Lograste escapar!`
        }, { quoted: msg });
      } else {
        const perdida = Math.floor(user.dinero * 0.1);
        user.dinero = Math.max(0, user.dinero - perdida);
        user.ultimoRobo = ahora;
        guardarBD();
        await sock.sendMessage(chatId, { 
          text: `❌ ¡Robo fallido!\n\n◉ Te atraparon robando\n▼ Perdiste: *$${perdida.toLocaleString()}* coins universal en multas\n◉ Tus coins universal: *$${user.dinero.toLocaleString()}*\n◊ ¡La próxima vez ten más cuidado!`
        }, { quoted: msg });
      }
    }

    if (body.startsWith("#apostar") || body.startsWith("#bet")) {
      const ahora = Date.now();
      const cooldown = 600000; // 10 minutos
      const tiempoRestante = user.ultimaApuesta + cooldown - ahora;
      if (tiempoRestante > 0) {
        const minutos = Math.ceil(tiempoRestante / 60000);
        await sock.sendMessage(chatId, { 
          text: `🎰 CASINO CERRADO TEMPORALMENTE\n\n⏱️ Vuelve en *${minutos}* minutos`
        }, { quoted: msg });
        return;
      }
      const args = body.split(" ");
      if (args.length < 2) {
        await sock.sendMessage(chatId, { 
          text: `🎰 CASINO ONLINE\n\n💰 Uso: *#apostar [cantidad]*\n\nEjemplo: *#apostar 5000*\n\n▪ Mínimo: 500 coins\n▪ Probabilidad de ganar: 55%\n▪ Ganancia: 2.5x tu apuesta`
        }, { quoted: msg });
        return;
      }
      const cantidad = parseInt(args[1]);
      if (isNaN(cantidad) || cantidad < 500) {
        await sock.sendMessage(chatId, { text: `⚠️ Cantidad inválida\n\nMínimo: 500 coins universal` }, { quoted: msg });
        return;
      }
      if (user.dinero < cantidad) {
        await sock.sendMessage(chatId, { 
          text: `❌ Fondos insuficientes. Tienes $${user.dinero.toLocaleString()}`
        }, { quoted: msg });
        return;
      }
      user.ultimaApuesta = ahora;
      const gano = Math.random() < 0.55;
      if (gano) {
        const ganancia = Math.floor(cantidad * 2.5);
        user.dinero += ganancia;
        guardarBD();
        await sock.sendMessage(chatId, { 
          text: `*✦ ¡GANASTE! ✦*\n\n💵 APUESTA: *$${cantidad.toLocaleString()}*\n💎 GANANCIA: *+$${ganancia.toLocaleString()}*\n\n💰 TOTAL ACTUAL: *$${user.dinero.toLocaleString()}*\n\n🎉 ¡JACKPOT!`
        }, { quoted: msg });
      } else {
        user.dinero -= cantidad;
        guardarBD();
        await sock.sendMessage(chatId, { 
          text: `*✦ ¡PERDISTE! ✦*\n\n💸 APUESTA PERDIDA: *$${cantidad.toLocaleString()}*\n\n💰 TOTAL ACTUAL: *$${user.dinero.toLocaleString()}*\n\n😢 Mejor suerte en la próxima...`
        }, { quoted: msg });
      }
    }

    if (body.startsWith("#invertir") || body.startsWith("#invest")) {
      const ahora = Date.now();
      const cooldown = 1200000; // 20 minutos
      const tiempoRestante = user.ultimaInversion + cooldown - ahora;
      if (tiempoRestante > 0) {
        const minutos = Math.ceil(tiempoRestante / 60000);
        await sock.sendMessage(chatId, { 
          text: `💼 MERCADO DE INVERSIONES\n\n⏱️ Tu próxima inversión estará disponible en *${minutos}* minutos`
        }, { quoted: msg });
        return;
      }
      const args = body.split(" ");
      if (args.length < 2) {
        await sock.sendMessage(chatId, { 
          text: `💼 MERCADO DE INVERSIONES\n\n💰 Uso: *#invertir [cantidad]*\n\nEjemplo: *#invertir 5000*\n\n▪ Mínimo: 1000 coins\n▪ Retorno: 1.3x a 1.5x\n▪ Tiempo: 20 minutos`
        }, { quoted: msg });
        return;
      }
      const cantidad = parseInt(args[1]);
      if (isNaN(cantidad) || cantidad < 1000) {
        await sock.sendMessage(chatId, { text: `⚠️ Cantidad inválida\n\nMínimo: 1000 coins universal` }, { quoted: msg });
        return;
      }
      if (user.dinero < cantidad) {
        await sock.sendMessage(chatId, { 
          text: `❌ Fondos insuficientes. Tienes $${user.dinero.toLocaleString()}`
        }, { quoted: msg });
        return;
      }
      user.dinero -= cantidad;
      user.ultimaInversion = ahora;
      const multiplicador = 1.3 + (Math.random() * 0.2);
      const retorno = Math.floor(cantidad * multiplicador);
      const ganancia = retorno - cantidad;
      const tiempoVencimiento = ahora + 1200000; // 20 minutos
      if (!user.inversionesPendientes) user.inversionesPendientes = [];
      user.inversionesPendientes.push({
        cantidad: cantidad,
        retorno: retorno,
        vencimiento: tiempoVencimiento
      });
      guardarBD();
      await sock.sendMessage(chatId, { 
        text: `*✦ INVERSIÓN REALIZADA ✦*\n\n💵 INVERTIDO: *$${cantidad.toLocaleString()}*\n📈 RETORNO ESPERADO: *$${retorno.toLocaleString()}*\n💎 GANANCIA: +*$${ganancia.toLocaleString()}* (${Math.floor((multiplicador - 1) * 100)}%)\n\n⏱️ Se acreditará en: *20 minutos*\n💰 Coins actuales: *$${user.dinero.toLocaleString()}*`
      }, { quoted: msg });
    }

    if (body === "#tienda" || body === "#shop") {
      let tiendaTexto = `🏪 *TIENDA - CATEGORÍAS* 🏪\n\n`;
      const categorias = obtenerCategoriasTienda();
      const emojis = { armas: '⚔️', armaduras: '🛡️', consumibles: '🧪', especiales: '✨', clan: '🏰' };
      categorias.forEach(cat => {
        const items = obtenerItemsPorCategoria(cat);
        tiendaTexto += `${emojis[cat] || '📦'} *${cat.toUpperCase()}* - ${items.length} items\n`;
      });
      tiendaTexto += `\n💡 Usa *#tienda [categoría]* para ver items\nEjemplo: *#tienda armas*`;
      await sock.sendMessage(chatId, { text: tiendaTexto }, { quoted: msg });
    }

    if (body.startsWith("#tienda ")) {
      const categoria = body.split(" ")[1].toLowerCase();
      const items = obtenerItemsPorCategoria(categoria);
      if (items.length === 0) {
        await sock.sendMessage(chatId, { 
          text: `❌ Categoría no encontrada\n\n💡 Categorías disponibles:\n• armas\n• armaduras\n• consumibles\n• especiales\n• clan`
        }, { quoted: msg });
        return;
      }
      let tiendaTexto = `🏪 *TIENDA - ${categoria.toUpperCase()}* 🏪\n\n`;
      items.forEach(item => {
        tiendaTexto += `${item.emoji} *${item.nombre}*\n`;
        tiendaTexto += `   💰 Precio: *$${item.precio.toLocaleString()}*\n`;
        if (item.poder) tiendaTexto += `   ⚡ Poder: +${item.poder}\n`;
        if (item.rareza) tiendaTexto += `   📊 Rareza: ${item.rareza}\n`;
        if (item.defensa) tiendaTexto += `   🛡️ Defensa: +${item.defensa}\n`;
        if (item.categoria === 'armas') {
          const mult = getWeaponMultiplierByItem(item);
          tiendaTexto += `   ⚔️ Daño: ${mult.toFixed(2)}x\n`;
        }
        tiendaTexto += `   📝 ${item.descripcion}\n`;
        tiendaTexto += `   🆔 ID: *${item.id}*\n\n`;
      });
      tiendaTexto += `💡 Usa *#comprar [id]* para comprar\nEjemplo: *#comprar espada_basica*`;
      await sock.sendMessage(chatId, { text: tiendaTexto }, { quoted: msg });
    }

    if (body === "#estadisticastienda") {
      let statsTexto = `📊 *ESTADÍSTICAS DE VENTAS DE LA TIENDA* 📊\n\n`;
      let totalVentas = 0;
      for (const categoria in TIENDA_ITEMS) {
        statsTexto += `🏷️ *${categoria.toUpperCase()}*\n`;
        const items = TIENDA_ITEMS[categoria];
        items.forEach(item => {
          const vendido = estadisticasTienda[item.id] || 0;
          totalVentas += vendido;
          statsTexto += `  ${item.emoji} ${item.nombre}: ${vendido} vendido(s)\n`;
        });
        statsTexto += `\n`;
      }
      statsTexto += `📈 *Total de items vendidos:* ${totalVentas}`;
      await sock.sendMessage(chatId, { text: statsTexto }, { quoted: msg });
    }

    // Comandos de drops/armas eliminados: funcionalidad removida.

    if (body.startsWith("#logros")) {
      const ext = msg.message?.extendedTextMessage?.contextInfo;
      let mentionedJid = ext?.mentionedJid?.[0];
      if (mentionedJid && isBotJid(mentionedJid)) mentionedJid = undefined;
      const quotedParticipant = ext?.participant || (ext?.quotedMessage?.contextInfo?.participant) || null;
      const targetId = mentionedJid || quotedParticipant || senderId;
      const found = findUsuarioByAnyId(targetId);
      let targetUser = null;
      if (found) targetUser = found.user; else targetUser = usuarios[targetId] || null;
      if (!targetUser) {
        await sock.sendMessage(chatId, { text: '❌ Usuario no registrado.' }, { quoted: msg });
        return;
      }
      const mentionText = (targetUser.nombre ? `@${(targetUser.nombre).replace(/\*/g,'')}` : targetUser.nombre) + (targetId === senderId ? ' (tú)' : '');
      const texto = buildAchievementsText(targetUser, mentionText);
      await sock.sendMessage(chatId, { text: texto, mentions: [targetId] }, { quoted: msg });
    }

    // --- COMANDOS DE TÍTULOS ---
    if (body === '#titulos') {
      if (!user.titulos || user.titulos.length === 0) {
        await sock.sendMessage(chatId, { text: 'No tienes títulos desbloqueados aún.' }, { quoted: msg });
        return;
      }
      let lines = ['♛ TÍTULOS DESBLOQUEADOS:\n'];
      user.titulos.forEach(id => {
        const t = getTituloById(id);
        if (t) lines.push(`${t.icono} ${t.nombre} (${t.id})`);
      });
      lines.push('\nUsa #equipartitulo <id> para activar uno.');
      await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
      return;
    }

    if (body.startsWith('#equipartitulo ')) {
      const id = body.split(' ')[1];
      if (!user.titulos || !user.titulos.includes(id)) {
        await sock.sendMessage(chatId, { text: 'No tienes ese título desbloqueado.' }, { quoted: msg });
        return;
      }
      user.tituloActivo = id;
      guardarBD();
      await sock.sendMessage(chatId, { text: '✅ Título equipado.' }, { quoted: msg });
      return;
    }

    if (body === "#eventos") {
      if (!events || events.length === 0) {
        await sock.sendMessage(chatId, { text: `🔔 No hay eventos activos en este momento.` }, { quoted: msg });
        return;
      }
      let textoEventos = `🔔 *EVENTOS ACTIVOS* 🔔\n\n`;
      events.forEach(ev => {
        textoEventos += `• ${ev.name} — ${ev.desc || 'Sin descripción'}\n  ⏱️ ${ev.start ? new Date(ev.start).toLocaleString() : 'N/A'} → ${ev.end ? new Date(ev.end).toLocaleString() : 'N/A'}\n\n`;
      });
      await sock.sendMessage(chatId, { text: textoEventos }, { quoted: msg });
    }

    if (body === "#temporada") {
      if (!currentSeason) {
        await sock.sendMessage(chatId, { text: `🔁 No hay una temporada activa en este momento.` }, { quoted: msg });
        return;
      }
      const s = seasons[currentSeason];
      let texto = `🔱 *${s.name || currentSeason}* 🔱\n\n`;
      texto += `⏱️ Inició: ${new Date(s.started).toLocaleString()}\n`;
      texto += `⏳ Finaliza: ${new Date(s.ends).toLocaleString()}\n\n`;
      const entries = Object.entries(s.standings || {}).map(([uid, pts]) => ({ uid, pts }));
      entries.sort((a, b) => b.pts - a.pts);
      texto += `🏆 Top 10:\n`;
      entries.slice(0, 10).forEach((e, i) => {
        const name = (findUsuarioByAnyId(e.uid) || { user: { nombre: e.uid.split('@')[0] } }).user.nombre;
        const rank = getSeasonRank(e.pts).name;
        texto += `${i+1}. ${name} — ${e.pts} pts — ${rank}\n`;
      });
      const myPts = (s.standings && s.standings[senderId]) ? s.standings[senderId] : 0;
      const myRank = getSeasonRank(myPts).name;
      texto += `\n◉ Tus puntos: ${myPts} pts — Clase: ${myRank}`;
      await sock.sendMessage(chatId, { text: texto }, { quoted: msg });
    }

    if (body.startsWith("#seasonstart") || body.startsWith("#seasonend")) {
      await sock.sendMessage(chatId, { text: '❌ Comando obsoleto: gestión de temporadas deshabilitada desde el menú.' }, { quoted: msg });
      return;
    }

    // Comando admin para otorgar puntos de temporada manualmente (no aparece en el menú)
    if (body.startsWith('#addpts')) {
      const isAdmin = senderId === ADMIN_SUPREMO || adminsSupremos[senderId];
      if (!isAdmin) { await sock.sendMessage(chatId, { text: '❌ Solo administradores pueden usar este comando.' }, { quoted: msg }); return; }
      if (!currentSeason) { await sock.sendMessage(chatId, { text: '❌ No hay una temporada activa actualmente.' }, { quoted: msg }); return; }
      const parts = body.split(/\s+/).filter(Boolean);
      // Soporta: #addpts @usuario 100  OR  #addpts usuario@server 100
      if (parts.length < 3) { await sock.sendMessage(chatId, { text: 'Uso: #addpts @usuario [cantidad]' }, { quoted: msg }); return; }
      let targetRaw = parts[1];
      let amount = parseInt(parts[2], 10);
      if (isNaN(amount) || amount <= 0) { await sock.sendMessage(chatId, { text: '❌ Cantidad inválida. Debe ser un número mayor que 0.' }, { quoted: msg }); return; }
      // resolver menciones desde contextInfo si existe
      try {
        const mentions = (msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.mentionedJid) || [];
        if (mentions.length === 1) targetRaw = mentions[0];
      } catch (e) {}
      let targetId = targetRaw;
      if (!targetId.includes('@')) {
        if (targetId.startsWith('@')) targetId = targetId.slice(1) + '@s.whatsapp.net';
        else targetId = targetId + '@s.whatsapp.net';
      }
      if (!usuarios[targetId]) { await sock.sendMessage(chatId, { text: '❌ Usuario no registrado.' }, { quoted: msg }); return; }
      try {
        seasonAddPointsAndRegister(targetId, amount);
        guardarBD();
        await sock.sendMessage(chatId, { text: `✅ Se han agregado ${amount} pts de temporada a ${(usuarios[targetId].nombre || targetId)}.` }, { quoted: msg });
      } catch (e) {
        logger.error('Error en #addpts:', e);
        await sock.sendMessage(chatId, { text: '❌ Ocurrió un error al agregar puntos.' }, { quoted: msg });
      }
      return;
    }

    if (body.startsWith("#comprar ")) {
      const itemId = body.split(" ")[1];
      const item = buscarItem(itemId);
      if (!item) {
        await sock.sendMessage(chatId, { 
          text: `❌ Item no encontrado\n\n💡 Usa *#tienda* para ver los items disponibles`
        }, { quoted: msg });
        return;
      }
      if (item.categoria === 'clan') {
        const miClan = obtenerClanDeUsuario(senderId);
        if (!miClan) {
          await sock.sendMessage(chatId, { text: `❌ Necesitas pertenecer a un clan para comprar items de clan` }, { quoted: msg });
          return;
        }
        if (miClan.lider !== senderId) {
          await sock.sendMessage(chatId, { text: `❌ Solo el líder del clan puede comprar items de clan` }, { quoted: msg });
          return;
        }
      }
      if (user.dinero < item.precio) {
        await sock.sendMessage(chatId, { 
          text: `❌ No tienes suficiente dinero\n\n💰 Tienes: *$${user.dinero.toLocaleString()}*\n💰 Necesitas: *$${item.precio.toLocaleString()}*`
        }, { quoted: msg });
        return;
      }
      user.dinero -= item.precio;
      estadisticasTienda[item.id] = (estadisticasTienda[item.id] || 0) + 1;
      guardarEstadisticasTienda();
      if (item.categoria === 'armas') {
        posesionesEspadas[item.id] = (posesionesEspadas[item.id] || 0) + 1;
        guardarPosesionesEspadas();
      }
      let efectoAplicado = "";
      if (item.categoria === 'clan') {
        const miClan = obtenerClanDeUsuario(senderId);
        if (item.efecto === 'expansion') {
          clanes[miClan.id].maxMiembros += item.valor;
          efectoAplicado = `\n👥 +${item.valor} slots de miembros (Total: ${clanes[miClan.id].maxMiembros})`;
          guardarClanes();
        } else if (item.efecto === 'defensa_clan') {
          clanes[miClan.id].defensaExtra = (clanes[miClan.id].defensaExtra || 0) + item.valor;
          efectoAplicado = `\n🛡️ +${item.valor} defensa al clan (Total: ${clanes[miClan.id].defensaExtra})`;
          guardarClanes();
        } else if (item.efecto === 'poder_clan') {
          clanes[miClan.id].poderExtra = (clanes[miClan.id].poderExtra || 0) + item.valor;
          efectoAplicado = `\n⚔️ +${item.valor} poder al clan (Total: ${clanes[miClan.id].poderExtra})`;
          guardarClanes();
        } else if (item.efecto === 'banco_clan') {
          clanes[miClan.id].capacidadBanco += item.valor;
          efectoAplicado = `\n💰 +$${item.valor.toLocaleString()} capacidad del banco (Total: $${clanes[miClan.id].capacidadBanco.toLocaleString()})`;
          guardarClanes();
        } else if (item.efecto === 'decoracion') {
          efectoAplicado = `\n🚩 Banner de clan obtenido`;
        }
      } else {
        if (!user.inventario[itemId]) {
          user.inventario[itemId] = 0;
        }
        user.inventario[itemId]++;
        if (item.poder) {
          user.poder += item.poder;
          efectoAplicado += `\n⚡ +${item.poder} poder`;
        }
        if (item.defensa) {
          user.defensa += item.defensa;
          efectoAplicado += `\n🛡️ +${item.defensa} defensa`;
        }
        // Si es un arma, ofrece equiparla
        if (item.categoria === 'armas') {
          user.equipo = user.equipo || { weapon: null };
          if (!user.equipo.weapon) {
            user.equipo.weapon = itemId;
            const mult = getWeaponMultiplierByItem(item);
            efectoAplicado += `\n⚔️ Equipada automáticamente! (daño: x${mult.toFixed(2)})`;
          } else {
            const mult = getWeaponMultiplierByItem(item);
            efectoAplicado += `\n💡 Puedes equiparla en #inventario (daño: x${mult.toFixed(2)})`;
          }
        }
      }
      guardarBD();
      await sock.sendMessage(chatId, { 
        text: `✅ ¡Compra exitosa!\n\n${item.emoji} *${item.nombre}*\n💰 Pagaste: *$${item.precio.toLocaleString()}*\n💰 Balance: *$${user.dinero.toLocaleString()}*${efectoAplicado}`
      }, { quoted: msg });
    }

    // ===== QUESTS DIARIAS =====
    if (body === '#quest' || body === '#quests') {
      let questTexto = `📋 QUESTS DIARIAS\n\n`;
      for (const q of QUESTS) {
        const progreso = user.questCounters[q.tipo] || 0;
        const completado = progreso >= q.objetivo;
        const reclamado = user.quests[q.id];
        const estado = reclamado ? '✅ RECLAMADO' : completado ? '🎯 COMPLETADO' : `${progreso}/${q.objetivo}`;
        questTexto += `${completado && !reclamado ? '⭐' : '○'} ${q.nombre}\n   ${q.descripcion}\n   Estado: ${estado}\n   Recompensa: $${q.recompensaDinero} | Exp ${q.recompensaExp} | Pts ${q.recompensaSeasons}\n\n`;
      }
      questTexto += `💡 Usa #reclamarquest [id] para reclamar`;
      await sock.sendMessage(chatId, { text: questTexto }, { quoted: msg });
      return;
    }
    if (body.startsWith('#reclamarquest ')) {
      const questId = body.split(/\s+/)[1];
      const quest = QUESTS.find(q => q.id === questId);
      if (!quest) { await sock.sendMessage(chatId, { text: '❌ Quest no encontrada.' }, { quoted: msg }); return; }
      const progreso = user.questCounters[quest.tipo] || 0;
      if (progreso < quest.objetivo) { await sock.sendMessage(chatId, { text: '❌ No has completado esta quest aún.' }, { quoted: msg }); return; }
      if (user.quests[questId]) { await sock.sendMessage(chatId, { text: '❌ Ya reclamaste esta quest.' }, { quoted: msg }); return; }
      user.dinero += quest.recompensaDinero;
      addExp(user, quest.recompensaExp);
      addSeasonPoints(senderId, quest.recompensaSeasons);
      user.quests[questId] = true;
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Quest completada!\n\n${quest.nombre}\n💰 +$${quest.recompensaDinero}\n⭐ +${quest.recompensaExp} Exp\n🎖️ +${quest.recompensaSeasons} pts` }, { quoted: msg });
      return;
    }

    // ===== FACCIONES =====
    if (body === '#faccion' || body === '#faction') {
      let fText = `⚔️ FACCIONES\n\n`;
      for (const fkey in FACCIONES) {
        const f = FACCIONES[fkey];
        const unida = user.faccion === fkey ? ' ✓ TÚ' : '';
        fText += `${f.emoji} ${f.nombre}${unida}\n   ${f.descripcion}\n\n`;
      }
      fText += `💡 Usa #joinfaction [id] para unirte`;
      await sock.sendMessage(chatId, { text: fText }, { quoted: msg });
      return;
    }
    if (body.startsWith('#joinfaction ')) {
      const fId = body.split(/\s+/)[1];
      if (!FACCIONES[fId]) { await sock.sendMessage(chatId, { text: '❌ Facción no válida.' }, { quoted: msg }); return; }
      user.faccion = fId;
      user.reputacionFaccion = 0;
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Te uniste a ${FACCIONES[fId].nombre}!\n\n${FACCIONES[fId].descripcion}` }, { quoted: msg });
      return;
    }

    // ===== EXPEDICIONES/MAZMORRAS MEJORADAS =====
    if (body === '#expedicion' || body === '#dungeon' || body === '#dungeons' || body === '#mazmorras') {
      let txt = `*✦ EXPEDICIONES DISPONIBLES ✦*\n\n`;
      
      const expediciones = [
        {
          id: 'catacumbas',
          nombre: '⚫ Catacumbas Oscuras',
          dificultad: 'Fácil',
          enemigos: 3,
          multiplicador: 1,
          recompensa: 1000,
          experiencia: 200,
          rareza: 'común',
          simbolo: '▸'
        },
        {
          id: 'bosque_maldito',
          nombre: '🌲 Bosque Maldito',
          dificultad: 'Media',
          enemigos: 5,
          multiplicador: 1.5,
          recompensa: 2500,
          experiencia: 500,
          rareza: 'raro',
          simbolo: '▹'
        },
        {
          id: 'torre_oscura',
          nombre: '🗼 Torre Oscura',
          dificultad: 'Difícil',
          enemigos: 8,
          multiplicador: 2,
          recompensa: 5000,
          experiencia: 1000,
          rareza: 'épico',
          simbolo: '▲'
        },
        {
          id: 'abyss',
          nombre: '🌀 El Abismo',
          dificultad: 'Leyenda',
          enemigos: 12,
          multiplicador: 3,
          recompensa: 10000,
          experiencia: 2000,
          rareza: 'legendario',
          simbolo: '◆'
        }
      ];
      
      for (let i = 0; i < expediciones.length; i++) {
        const exp = expediciones[i];
        const dificultadColor = exp.dificultad === 'Fácil' ? '(Fácil)' : exp.dificultad === 'Media' ? '(Media)' : exp.dificultad === 'Difícil' ? '(Difícil)' : '(Leyenda)';
        txt += `${i+1}. ${exp.nombre}\n`;
        txt += `   ${exp.simbolo} Dificultad: ${dificultadColor}\n`;
        txt += `   ${exp.simbolo} Enemigos: ${exp.enemigos} oleadas\n`;
        txt += `   ${exp.simbolo} Dinero: $${exp.recompensa.toLocaleString()}\n`;
        txt += `   ${exp.simbolo} EXP: ${exp.experiencia}\n`;
        txt += `   ${exp.simbolo} Rareza: ${exp.rareza.toUpperCase()}\n\n`;
      }
      
      txt += `*─────────────────────*\n`;
      txt += `💡 Usa: #entrar <ID>\n`;
      txt += `Ejemplo: #entrar catacumbas`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('#entrar ')) {
      const expId = body.split(/\s+/)[1];
      
      const expediciones = {
        catacumbas: { nombre: 'Catacumbas Oscuras', enemigos: 3, multiplicador: 1, recompensa: 1000, exp: 200 },
        bosque_maldito: { nombre: 'Bosque Maldito', enemigos: 5, multiplicador: 1.5, recompensa: 2500, exp: 500 },
        torre_oscura: { nombre: 'Torre Oscura', enemigos: 8, multiplicador: 2, recompensa: 5000, exp: 1000 },
        abyss: { nombre: 'El Abismo', enemigos: 12, multiplicador: 3, recompensa: 10000, exp: 2000 }
      };
      
      const exp = expediciones[expId];
      if (!exp) {
        await sock.sendMessage(chatId, { text: '❌ Expedición no encontrada. Usa #expedicion para verlas.' }, { quoted: msg });
        return;
      }
      
      // Verificar cooldown (15 minutos)
      if (user.ultimaExpedicion && Date.now() - user.ultimaExpedicion < 15 * 60 * 1000) {
        const tiempoRestante = Math.ceil((15 * 60 * 1000 - (Date.now() - user.ultimaExpedicion)) / 60000);
        await sock.sendMessage(chatId, { text: `⏳ Espera ${tiempoRestante} minutos antes de entrar de nuevo.` }, { quoted: msg });
        return;
      }
      
      // Inicializar progreso
      user.expedicionActual = {
        id: expId,
        nombre: exp.nombre,
        oleaActual: 1,
        enemigosTotales: exp.enemigos,
        tiempoInicio: Date.now(),
        daño: 0,
        vida: user.vida || 100,
        multiplicador: exp.multiplicador,
        recompensa: exp.recompensa,
        experiencia: exp.exp
      };
      
      guardarBD();
      
      let txt = `*⚔️ EXPEDICIÓN INICIADA*\n\n`;
      txt += `${exp.nombre}\n\n`;
      txt += `*─ PROGRESO ─*\n`;
      txt += `▸ Oleada 1/${exp.enemigos}\n`;
      txt += `▸ Vida: ${user.vida || 100} HP\n`;
      txt += `▸ Poder: ${user.poder || 100}\n`;
      txt += `*─────────────*\n\n`;
      txt += `💡 Usa *#atacar* para combatir\n`;
      txt += `💡 Usa *#abandonar* para rendirte`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === '#atacar' || body === '#attack') {
      if (!user.expedicionActual) {
        await sock.sendMessage(chatId, { text: '❌ No estás en una expedición. Usa #entrar <id>' }, { quoted: msg });
        return;
      }
      
      const exp = user.expedicionActual;
      const danoInflingido = Math.floor((user.poder || 100) * (0.8 + Math.random() * 0.4) * exp.multiplicador);
      exp.daño += danoInflingido;
      
      const danoEnemigo = Math.floor(Math.random() * 20 * exp.multiplicador);
      exp.vida -= danoEnemigo;
      
      if (exp.vida <= 0) {
        // Derrota
        user.expedicionActual = null;
        user.ultimaExpedicion = Date.now();
        guardarBD();
        
        let txt = `*💀 DERROTADO*\n\n`;
        txt += `${exp.nombre}\n`;
        txt += `Oleada ${exp.oleaActual}/${exp.enemigosTotales}\n\n`;
        txt += `*─ RESULTADOS ─*\n`;
        txt += `▸ Daño infligido: ${exp.daño}\n`;
        txt += `▸ No completado\n`;
        txt += `*─────────────*\n`;
        
        await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
        return;
      }
      
      if (exp.oleaActual >= exp.enemigosTotales) {
        // Victoria
        user.dinero += exp.recompensa;
        user.exp = (user.exp || 0) + exp.experiencia;
        user.expedicionesCompletadas = (user.expedicionesCompletadas || 0) + 1;
        user.expedicionActual = null;
        user.ultimaExpedicion = Date.now();
        
        if (user.stats) {
          user.stats.expeditionCompletes = (user.stats.expeditionCompletes || 0) + 1;
        }
        
        guardarBD();
        
        let txt = `*🏆 EXPEDICIÓN COMPLETADA*\n\n`;
        txt += `${exp.nombre}\n\n`;
        txt += `*─ RECOMPENSAS ─*\n`;
        txt += `▸ Daño total: ${exp.daño}\n`;
        txt += `▸ Dinero: $${exp.recompensa.toLocaleString()}\n`;
        txt += `▸ EXP: ${exp.experiencia}\n`;
        txt += `*─────────────*\n`;
        
        await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
        return;
      }
      
      // Siguiente oleada
      exp.oleaActual++;
      guardarBD();
      
      const barraVida = Math.floor(exp.vida / 10);
      const barraVacia = 10 - barraVida;
      const barraHP = '█'.repeat(barraVida) + '░'.repeat(barraVacia);
      
      let txt = `*⚔️ COMBATE EN CURSO*\n\n`;
      txt += `${exp.nombre}\n\n`;
      txt += `*─ ACCIONES ─*\n`;
      txt += `▸ Tu daño: +${danoInflingido}\n`;
      txt += `▸ Daño recibido: -${danoEnemigo}\n\n`;
      txt += `*─ PROGRESO ─*\n`;
      txt += `▸ Oleada ${exp.oleaActual}/${exp.enemigosTotales}\n`;
      txt += `${barraHP} ${exp.vida}HP\n`;
      txt += `▸ Daño acumulado: ${exp.daño}\n`;
      txt += `*─────────────*\n\n`;
      txt += `💡 Usa *#atacar* para continuar`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === '#abandonar' || body === '#huir') {
      if (!user.expedicionActual) {
        await sock.sendMessage(chatId, { text: '❌ No estás en una expedición.' }, { quoted: msg });
        return;
      }
      
      const exp = user.expedicionActual;
      user.expedicionActual = null;
      user.ultimaExpedicion = Date.now();
      guardarBD();
      
      let txt = `*🏃 EXPEDICIÓN ABANDONADA*\n\n`;
      txt += `${exp.nombre}\n`;
      txt += `▸ Oleada: ${exp.oleaActual}/${exp.enemigosTotales}\n`;
      txt += `▸ Daño: ${exp.daño}\n\n`;
      txt += `⏳ Reintentar en 15 minutos`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === '#expediciones-stats' || body === '#exp-stats') {
      let txt = `*📊 TUS EXPEDICIONES*\n\n`;
      txt += `▸ Completadas: ${user.expedicionesCompletadas || 0}\n`;
      
      if (!user.ultimaExpedicion) {
        txt += `▸ Última: Nunca`;
      } else {
        const hace = Math.floor((Date.now() - user.ultimaExpedicion) / 60000);
        txt += `▸ Última: Hace ${hace}m`;
      }
      
      txt += `\n\n💡 Usa #expedicion para ver disponibles`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === '#battlepass' || body === '#bp') {
      const bp = user.battlePass;
      const tierActual = bp.tier || 0;
      const siguiente = BATTLE_PASS_TIERS[tierActual] || BATTLE_PASS_TIERS[99];
      const progPorciento = siguiente ? Math.floor((bp.puntos / siguiente.puntosRequeridos) * 100) : 100;
      let bpText = `🎖️ BATTLE PASS\n\nTier: ${tierActual}/100\nProgreso: ${progPorciento}%\n\n💡 Completa misiones para ganar puntos`;
      await sock.sendMessage(chatId, { text: bpText }, { quoted: msg });
      return;
    }

    // ===== MONTURAS =====
    if (body === '#montura' || body === '#monturas') {
      let mText = `🐴 MONTURAS\n\n`;
      for (const m of MONTURAS) {
        const tiene = user.monturas && user.monturas.includes(m.id);
        const equipada = user.montura === m.id ? ' ⭐ EQUIPADA' : '';
        mText += `${m.emoji} ${m.nombre}${equipada}\n   Precio: $${m.precio} | Velocidad: x${m.velocidad} | Defensa: +${m.defensa}\n`;
        if (tiene && !equipada) mText += `   💡 Usa #equiparmontura ${m.id}\n`;
        mText += '\n';
      }
      mText += `💡 Usa #comprarmontura [id]`;
      await sock.sendMessage(chatId, { text: mText }, { quoted: msg });
      return;
    }
    if (body.startsWith('#comprarmontura ')) {
      const mId = body.split(/\s+/)[1];
      const montura = MONTURAS.find(m => m.id === mId);
      if (!montura) { await sock.sendMessage(chatId, { text: '❌ Montura no válida.' }, { quoted: msg }); return; }
      if (user.dinero < montura.precio) { await sock.sendMessage(chatId, { text: `❌ No tienes suficiente dinero. Necesitas $${montura.precio}` }, { quoted: msg }); return; }
      user.dinero -= montura.precio;
      if (!user.monturas) user.monturas = [];
      user.monturas.push(mId);
      if (!user.montura) user.montura = mId;
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ ¡Compraste ${montura.nombre}!\n\n${montura.emoji} Velocidad: x${montura.velocidad}` }, { quoted: msg });
      return;
    }
    if (body.startsWith('#equiparmontura ')) {
      const mId = body.split(/\s+/)[1];
      if (!user.monturas || !user.monturas.includes(mId)) { await sock.sendMessage(chatId, { text: '❌ No tienes esa montura.' }, { quoted: msg }); return; }
      user.montura = mId;
      const montura = MONTURAS.find(m => m.id === mId);
      guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Equipaste ${montura.nombre}!` }, { quoted: msg });
      return;
    }

    // ===== MERCADO MEJORADO =====
    if (body === '#mercadostats' || body === '#marketstats') {
      const historialPromedio = market.length > 0 
        ? (market.reduce((acc, m) => acc + m.price, 0) / market.length).toFixed(2) 
        : 0;
      let statsText = `📊 ESTADÍSTICAS DEL MERCADO\n\n`;
      statsText += `Listings activos: ${market.length}\n`;
      statsText += `Precio promedio: $${historialPromedio}\n`;
      statsText += `Volumen de ventas (últimos): ${market.slice(-10).length} items\n`;
      await sock.sendMessage(chatId, { text: statsText }, { quoted: msg });
      return;
    }

    if (body === "#inventario" || body === "#inv") {
      let invTexto = `🎒 *TU INVENTARIO* 🎒\n\n`;
      const itemsEnInventario = Object.entries(user.inventario).filter(([id, cant]) => cant > 0);
      if (itemsEnInventario.length === 0) {
        invTexto += `❌ Tu inventario está vacío\n\n💡 Usa *#tienda* para comprar items`;
      } else {
        let valorTotal = 0;
        itemsEnInventario.forEach(([itemId, cantidad]) => {
          const item = buscarItem(itemId);
          if (item) {
            invTexto += `${item.emoji} *${item.nombre}* x${cantidad}\n`;
            invTexto += `   💰 Valor: *$${(item.precio * cantidad).toLocaleString()}*\n\n`;
            valorTotal += item.precio * cantidad;
          }
        });
        invTexto += `━━━━━━━━━━━━━━━━━━━━\n`;
        invTexto += `💎 Valor total: *$${valorTotal.toLocaleString()}*`;
      }
      // mostrar armas disponibles y equipadas (basado en inventario)
      const armaKeys = Object.keys(user.inventario || {}).filter(k => {
        const it = buscarItem(k);
        return it && it.categoria === 'armas' && (user.inventario[k]||0) > 0;
      });
      if (armaKeys.length > 0) {
        invTexto += `\n\n⚔️ ARMAS (${armaKeys.length}):`;
        for (const wid of armaKeys) {
          const cant = user.inventario[wid] || 0;
          const it = buscarItem(wid) || {};
          const nombre = it.nombre || wid;
          const rareza = it.rareza || it.rarity || 'comun';
          const mult = getWeaponMultiplierByItem(it);
          const equipped = user.equipo && user.equipo.weapon === wid ? ' ⭐ EQUIPADA' : '';
          invTexto += `\n  • ${nombre} x${cant} (${rareza}) — daño: x${mult.toFixed(2)}${equipped}`;
        }
      } else {
        invTexto += `\n\n⚔️ ARMAS: Ninguna en inventario.`;
      }
      if (user.equipo && user.equipo.weapon) {
        const weIt = buscarItem(user.equipo.weapon);
        if (weIt) {
          const mult = getWeaponMultiplierByItem(weIt);
          invTexto += `\n\n✨ Arma equipada: ${weIt.nombre || user.equipo.weapon} (${weIt.rareza || 'comun'}) — x${mult.toFixed(2)} daño`;
        }
      }
      invTexto += `\n\n💡 Escribe: #equipar [id_arma]  para cambiar de arma`;
      await sock.sendMessage(chatId, { text: invTexto }, { quoted: msg });
    }

    // Comando para equipar/cambiar arma
    if (body.startsWith('#equipar ')) {
      const wid = body.split(/\s+/)[1];
      if (!wid) { await sock.sendMessage(chatId, { text: 'Uso: #equipar [id_arma]' }, { quoted: msg }); return; }
      const item = buscarItem(wid);
      if (!item || item.categoria !== 'armas') { await sock.sendMessage(chatId, { text: '❌ No es un arma válida.' }, { quoted: msg }); return; }
      if (!user.inventario || (user.inventario[wid]||0) <= 0) { await sock.sendMessage(chatId, { text: '❌ No tienes esa arma en tu inventario.' }, { quoted: msg }); return; }
      user.equipo = user.equipo || {};
      user.equipo.weapon = wid;
      guardarBD();
      const mult = getWeaponMultiplierByItem(item);
      await sock.sendMessage(chatId, { text: `⚔️ ¡Arma equipada!\n\n${item.nombre || wid}\n(${item.rareza || 'comun'}) — daño: x${mult.toFixed(2)}\n\nTus ataques a bosses harán más daño.` }, { quoted: msg });
      return;
    }

    // ---------- MERCADO / SUBASTAS ----------
    if (body.startsWith('#vender ')) {
      const parts = body.split(/\s+/).filter(Boolean);
      const itemId = parts[1];
      const price = Number(parts[2] || 0);
      if (!itemId || !price || price <= 0) { await sock.sendMessage(chatId, { text: 'Uso: #vender [itemId] [precio]' }, { quoted: msg }); return; }
      if (!user.inventario || (user.inventario[itemId]||0) <= 0) { await sock.sendMessage(chatId, { text: '❌ No tienes ese item en tu inventario.' }, { quoted: msg }); return; }
      // retirar del inventario y crear listing en mercado
      user.inventario[itemId]--;
      const listing = { id: genId('l'), seller: senderId, itemId, price, createdAt: Date.now() };
      market.push(listing); saveMarket(); guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Item puesto a la venta: ${itemId} — ID: ${listing.id} — Precio: $${price}` }, { quoted: msg });
      try { await sendReceipt(senderId, 'Listado creado en Mercado', [`Item: ${itemId}`, `ID: ${listing.id}`, `Precio: $${price}`]); } catch (e) {}
      return;
    }

    if (body === '#listar') {
      if (!market || market.length === 0) { await sock.sendMessage(chatId, { text: '🔎 Mercado vacío.' }, { quoted: msg }); return; }
      const lines = market.slice(-20).reverse().map(l => `${l.id} — ${l.itemId} — $${l.price} — vendedor: ${(usuarios[l.seller] && usuarios[l.seller].nombre) || l.seller}`);
      await sock.sendMessage(chatId, { text: `🛒 Mercado (últimos):\n${lines.join('\n')}` }, { quoted: msg });
      return;
    }

    if (body.startsWith('#comprarlist ')) {
      const lid = body.split(/\s+/)[1];
      const listing = market.find(x => x.id === lid);
      if (!listing) { await sock.sendMessage(chatId, { text: '❌ Listing no encontrado.' }, { quoted: msg }); return; }
      if (user.dinero < listing.price) { await sock.sendMessage(chatId, { text: `❌ No tienes suficiente dinero. Precio: $${listing.price}` }, { quoted: msg }); return; }
      // transferencia
      user.dinero -= listing.price;
      if (!usuarios[listing.seller]) { usuarios[listing.seller] = { nombre: listing.seller, dinero: 0, inventario: {} }; }
      usuarios[listing.seller].dinero = (usuarios[listing.seller].dinero || 0) + listing.price;
      user.inventario[listing.itemId] = (user.inventario[listing.itemId]||0) + 1;
      // remover listing
      market = market.filter(x => x.id !== lid); saveMarket(); guardarBD();
        await sock.sendMessage(chatId, { text: `✅ Compra exitosa: ${listing.itemId}` }, { quoted: msg });
      try { await sendReceipt(senderId, 'Compra Mercado', [`Item: ${listing.itemId}`, `Pagaste: $${listing.price}`, `Vendedor: ${(usuarios[listing.seller] && usuarios[listing.seller].nombre) || listing.seller}`]); } catch (e) {}
      try { await sendReceipt(listing.seller, 'Vendido en Mercado', [`Item: ${listing.itemId}`, `Cobras: $${listing.price}`, `Comprador: ${(user.nombre)||senderId}`]); } catch (e) {}
      return;
    }

    if (body.startsWith('#subasta ')) {
      const parts = body.split(/\s+/).filter(Boolean);
      const sub = parts[1] || '';
      if (sub === 'ayuda' || sub === 'help') {
        await sock.sendMessage(chatId, { text: `📚 Ayuda - Sistema de Bosses\n\nComandos principales:\n- #boss : Muestra el boss activo del grupo (si existe).\n- #boss crear <nombre> [dificultad] : Crea un boss personal. Dificultades: facil, medio, dificil, imposible, importal (solo admins).\n- #boss atacar <bossId> : Ataca un boss por su ID (los bosses personales solo pueden ser atacados por su creador).\n- #attack [cantidad] : Ataque rápido al boss activo del grupo, opcionalmente especifica daño.\n- #bossranking : Muestra ranking de daño del boss activo.\n- #bossloot : Muestra resumen de loot del último boss derrotado.\n\nEjemplo: #boss crear Coloso medio  -> crea un boss personal llamado Coloso con dificultad medio.\nEjemplo: #boss atacar boss_ab12cd34  -> ataca el boss con ID boss_ab12cd34\n\nNotas:\n- Los bosses personales tienen cooldown de 1 hora entre creaciones.\n- Los bosses 'importal' solo pueden ser creados por admins y pueden atacarlos todos en el grupo.` }, { quoted: msg });
        return;
      }
      if (sub === 'crear') {
        const itemId = parts[2];
        const startPrice = Number(parts[3] || 0);
        const minutes = Number(parts[4] || 60);
        if (!itemId || !startPrice) { await sock.sendMessage(chatId, { text: 'Uso: #subasta crear [itemId] [startPrice] [duración_minutos]' }, { quoted: msg }); return; }
        if (!user.inventario || (user.inventario[itemId]||0) <= 0) { await sock.sendMessage(chatId, { text: '❌ No tienes ese item para subastar.' }, { quoted: msg }); return; }
        user.inventario[itemId]--; const aid = genId('a');
        const auction = { id: aid, itemId, seller: senderId, startPrice, endsAt: Date.now() + minutes*60000, bids: [] };
        auctions.push(auction); saveAuctions(); guardarBD();
        await sock.sendMessage(chatId, { text: `🔨 Subasta creada: ${aid} — ${itemId} — inicia en $${startPrice} — termina en ${minutes} min` }, { quoted: msg });
        return;
      }
      if (sub === 'lista' || sub === 'listar') {
        if (!auctions || auctions.length===0) { await sock.sendMessage(chatId, { text: '🔎 No hay subastas activas.' }, { quoted: msg }); return; }
        const lines = auctions.filter(a=>Date.now()<a.endsAt).map(a => `${a.id} — ${a.itemId} — base: $${a.startPrice} — termina: ${new Date(a.endsAt).toLocaleString()} — pujas: ${a.bids.length}`);
        await sock.sendMessage(chatId, { text: `🔨 Subastas activas:\n${lines.join('\n')}` }, { quoted: msg });
        return;
      }
      return;
    }

    if (body.startsWith('#pujar ')) {
      const parts = body.split(/\s+/).filter(Boolean);
      const aid = parts[1];
      const amount = Number(parts[2] || 0);
      const a = auctions.find(x => x.id === aid);
      if (!a) { await sock.sendMessage(chatId, { text: '❌ Subasta no encontrada.' }, { quoted: msg }); return; }
      if (Date.now() >= a.endsAt) { await sock.sendMessage(chatId, { text: '⏳ Subasta finalizada.' }, { quoted: msg }); return; }
      const highest = a.bids.length ? a.bids[a.bids.length-1].amount : a.startPrice;
      if (amount <= highest) { await sock.sendMessage(chatId, { text: `❌ Tu puja debe ser mayor que la actual: $${highest}` }, { quoted: msg }); return; }
      if (user.dinero < amount) { await sock.sendMessage(chatId, { text: '❌ No tienes fondos para pujar esa cantidad.' }, { quoted: msg }); return; }
      a.bids.push({ bidder: senderId, amount, at: Date.now() }); saveAuctions(); guardarBD();
      await sock.sendMessage(chatId, { text: `✅ Pujaste $${amount} en subasta ${aid}` }, { quoted: msg });
      return;
    }

    // Worker para finalizar subastas (cada minuto)
    // (se crea una sola vez globalmente)
    if (!global.__auctionsFinalizer) {
      global.__auctionsFinalizer = true;
      setInterval(() => {
        try {
          const now = Date.now();
          let changedA = false;
          for (const a of auctions.slice()) {
            if (now >= a.endsAt) {
              // finalizar
              const winner = (a.bids && a.bids.length) ? a.bids[a.bids.length-1] : null;
              if (winner) {
                // verificar fondos
                const buyer = usuarios[winner.bidder];
                if (buyer && buyer.dinero >= winner.amount) {
                  buyer.dinero -= winner.amount;
                  usuarios[a.seller].dinero = (usuarios[a.seller].dinero||0) + winner.amount;
                  buyer.inventario[a.itemId] = (buyer.inventario[a.itemId]||0) + 1;
                  // notificar
                  sendReceipt(winner.bidder, 'Subasta ganada', [`Item: ${a.itemId}`, `Pagaste: $${winner.amount}`, `Subasta: ${a.id}`]);
                  sendReceipt(a.seller, 'Item vendido en subasta', [`Item: ${a.itemId}`, `Recibiste: $${winner.amount}`, `Comprador: ${(buyer.nombre)||winner.bidder}`]);
                } else {
                  // no funds -> devolver item al vendedor
                  usuarios[a.seller].inventario[a.itemId] = (usuarios[a.seller].inventario[a.itemId]||0) + 1;
                }
              } else {
                // sin pujas: devolver item al vendedor
                usuarios[a.seller].inventario[a.itemId] = (usuarios[a.seller].inventario[a.itemId]||0) + 1;
              }
              // remover subasta
              auctions = auctions.filter(x => x.id !== a.id);
              changedA = true;
            }
          }
          if (changedA) { saveAuctions(); saveMarket(); guardarBD(); }
        } catch (e) { logger.error('Error finalizando subastas:', e); }
      }, 60*1000);
    }

    // ---------- MISIONES DIARIAS / SEMANALES MEJORADAS ----------
    if (body === '#misiones' || body === '#quests' || body === '#missions') {
      refreshQuestsIfNeeded();
      user.questProgress = user.questProgress || {};
      user.missionStats = user.missionStats || { dailyCompleted: 0, weeklyCompleted: 0, totalRewards: 0 };
      
      let txt = '📋 TUS MISIONES DISPONIBLES\n\n';
      txt += '═══════════════════════════════════\n';
      txt += '🟡 MISIONES DIARIAS (Se resetean cada 24h)\n';
      txt += '═══════════════════════════════════\n';
      
      let dailyBonus = 0;
      for (const q of quests.daily) {
        const prog = user.questProgress[q.mid] || { progress: 0, claimed: false };
        const percent = Math.min(100, Math.floor((prog.progress / q.target) * 100));
        const bar = '█'.repeat(Math.floor(percent/10)) + '░'.repeat(10 - Math.floor(percent/10));
        const status = prog.claimed ? '✅ RECLAMADO' : (prog.progress >= q.target ? '🎁 COMPLETADO' : '⏳ EN PROGRESO');
        
        txt += `\n🎯 ${q.nombre}\n`;
        txt += `   Progreso: [${bar}] ${prog.progress}/${q.target} (${percent}%)\n`;
        txt += `   💰 ${q.rewards.dinero} | 📈 ${q.rewards.exp} exp\n`;
        txt += `   Estado: ${status}\n`;
        txt += `   ID: \`${q.mid}\`\n`;
        
        if (prog.claimed) dailyBonus++;
      }
      
      txt += '\n═══════════════════════════════════\n';
      txt += '🟢 MISIONES SEMANALES (Se resetean cada 7 días)\n';
      txt += '═══════════════════════════════════\n';
      
      let weeklyBonus = 0;
      for (const q of quests.weekly) {
        const prog = user.questProgress[q.mid] || { progress: 0, claimed: false };
        const percent = Math.min(100, Math.floor((prog.progress / q.target) * 100));
        const bar = '█'.repeat(Math.floor(percent/10)) + '░'.repeat(10 - Math.floor(percent/10));
        const status = prog.claimed ? '✅ RECLAMADO' : (prog.progress >= q.target ? '🎁 COMPLETADO' : '⏳ EN PROGRESO');
        
        txt += `\n🎯 ${q.nombre}\n`;
        txt += `   Progreso: [${bar}] ${prog.progress}/${q.target} (${percent}%)\n`;
        txt += `   💰 ${q.rewards.dinero} | 📈 ${q.rewards.exp} exp\n`;
        txt += `   Estado: ${status}\n`;
        txt += `   ID: \`${q.mid}\`\n`;
        
        if (prog.claimed) weeklyBonus++;
      }
      
      txt += '\n═══════════════════════════════════\n';
      txt += `📊 ESTADÍSTICAS\n`;
      txt += `   Diarias completadas: ${dailyBonus}/4\n`;
      txt += `   Semanales completadas: ${weeklyBonus}/3\n`;
      txt += `   Recompensas totales reclamadas: $${user.missionStats.totalRewards.toLocaleString()}\n`;
      txt += `\n💡 Usa: #claimmission <ID> para reclamar una misión\n`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('#claimmission ') || body.startsWith('#reclamarmision ')) {
      const mid = body.split(/\s+/)[1];
      if (!mid) { 
        await sock.sendMessage(chatId, { text: '❌ Uso: #claimmission <ID>\nEjemplo: #claimmission d_1708963200000_0' }, { quoted: msg }); 
        return; 
      }
      
      refreshQuestsIfNeeded();
      user.questProgress = user.questProgress || {};
      user.missionStats = user.missionStats || { dailyCompleted: 0, weeklyCompleted: 0, totalRewards: 0 };
      
      const all = [...quests.daily, ...quests.weekly];
      const q = all.find(x => x.mid === mid);
      if (!q) { 
        await sock.sendMessage(chatId, { text: '❌ Misión no encontrada. Verifica el ID en #misiones' }, { quoted: msg }); 
        return; 
      }
      
      const prog = user.questProgress[mid] || { progress: 0, claimed: false };
      
      // Verificar si ya fue reclamada
      if (prog.claimed) { 
        await sock.sendMessage(chatId, { text: '✅ Ya reclamaste esta misión. Espera al reset de mañana.' }, { quoted: msg }); 
        return; 
      }
      
      // Verificar si está completada
      if (prog.progress < q.target) {
        const porcentaje = Math.floor((prog.progress / q.target) * 100);
        await sock.sendMessage(chatId, { text: `⏳ No completaste esta misión aún.\n\nProgreso: ${prog.progress}/${q.target} (${porcentaje}%)` }, { quoted: msg }); 
        return; 
      }
      
      // Otorgar recompensas
      user.dinero = (user.dinero || 0) + q.rewards.dinero;
      user.exp = (user.exp || 0) + q.rewards.exp;
      user.missionStats.totalRewards += q.rewards.dinero;
      if (mid.startsWith('d_')) user.missionStats.dailyCompleted++;
      else user.missionStats.weeklyCompleted++;
      
      user.questProgress[mid] = { ...prog, progress: q.target, claimed: true, claimedAt: Date.now() };
      guardarBD();
      
      let txt = `🎉 ¡MISIÓN COMPLETADA!\n\n`;
      txt += `${q.nombre}\n\n`;
      txt += `═══════════════════\n`;
      txt += `💰 Dinero: +$${q.rewards.dinero.toLocaleString()}\n`;
      txt += `📈 Exp: +${q.rewards.exp}\n`;
      txt += `═══════════════════\n`;
      txt += `\n✅ Recompensas agregadas a tu cuenta.`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    // ---------- GUERRAS DE CLANES (simplificado) ----------
    if (body.startsWith('#clanwar')) {
      const parts = body.split(/\s+/).filter(Boolean);
      const sub = parts[1] || '';
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) { await sock.sendMessage(chatId, { text: '❌ No perteneces a un clan.' }, { quoted: msg }); return; }
      if (sub === 'challenge') {
        const targetName = parts.slice(2).join(' ');
        if (!targetName) { await sock.sendMessage(chatId, { text: '*Uso:* #clanwar challenge [NombreClanObjetivo]' }, { quoted: msg }); return; }
        const targetClan = Object.values(clanes).find(c => (c.nombre||'').toLowerCase() === (targetName||'').toLowerCase());
        if (!targetClan) { await sock.sendMessage(chatId, { text: '❌ Clan objetivo no encontrado.' }, { quoted: msg }); return; }
        const warId = genId('war');
        const record = { id: warId, clanA: miClan.id, clanB: Object.keys(clanes).find(k=>clanes[k]===targetClan), scores: {}, startedAt: Date.now(), endsAt: Date.now()+24*3600*1000 };
        record.scores[miClan.id] = 0; record.scores[record.clanB] = 0;
        clanWars.push(record); saveClanWars();
        const mensajeWar = `*⚔️ GUERRA DE CLANES INICIADA ⚔️*\n\n${miClan.nombre} vs ${targetClan.nombre}\n\n⏱️ Duración: 24 horas\n🪄 ID: ${warId}\n\n¡Reúnanse y usen #clanwar attack para sumar puntos!`;
        await sock.sendMessage(chatId, { text: mensajeWar }, { quoted: msg });
        return;
      }
      if (sub === 'attack') {
        const war = clanWars.find(w => w.clanA === miClan.id || w.clanB === miClan.id);
        if (!war) { await sock.sendMessage(chatId, { text: '🔕 No hay guerras activas para tu clan.' }, { quoted: msg }); return; }
        const ally = miClan.id;
        const enemy = (war.clanA === ally) ? war.clanB : war.clanA;
        const pts = Math.max(1, Math.floor((user.poder||100)/100));
        war.scores[ally] = (war.scores[ally]||0) + pts; saveClanWars(); guardarBD();
        const mensajeAtaque = `⚔️ *¡ATAQUE EXITOSO!*\n\nAportaste *${pts} puntos* a ${miClan.nombre}.\n\nPuntuación actual:\n${clanes[war.clanA].nombre}: ${war.scores[war.clanA]||0}\n${clanes[war.clanB].nombre}: ${war.scores[war.clanB]||0}`;
        await sock.sendMessage(chatId, { text: mensajeAtaque }, { quoted: msg });
        return;
      }
      if (sub === 'status') {
        const war = clanWars.find(w => w.clanA === miClan.id || w.clanB === miClan.id);
        if (!war) { await sock.sendMessage(chatId, { text: '🔕 No hay guerras activas para tu clan.' }, { quoted: msg }); return; }
        const aName = clanes[war.clanA].nombre; const bName = clanes[war.clanB].nombre;
        const score_a = war.scores[war.clanA]||0;
        const score_b = war.scores[war.clanB]||0;
        const ganador = score_a > score_b ? aName : score_b > score_a ? bName : 'Empatados';
        const statusWar = `*⚔️ ESTADO DE GUERRA ⚔️*\n\n${aName} ⚔️ ${bName}\n\n*Puntos:*\n${aName}: *${score_a}*\n${bName}: *${score_b}*\n\nGanador actual: *${ganador}*`;
        await sock.sendMessage(chatId, { text: statusWar }, { quoted: msg });
        return;
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // NUEVOS COMANDOS ÉPICOS - ENTRETENIMIENTO Y DIVERSIÓN
    // ═══════════════════════════════════════════════════════════════

    if (body === '#ruleta-diaria' || body === '#ruleta') {
      const ahora = Date.now();
      const ultimaRuleta = user.ultimaRuleta || 0;
      const cooldown = 24 * 3600000;
      const tiempoRestante = ultimaRuleta + cooldown - ahora;
      if (tiempoRestante > 0) {
        const horas = Math.floor(tiempoRestante / 3600000);
        await sock.sendMessage(chatId, { text: `🎡 Ya jugaste la ruleta hoy. Vuelve en *${horas}h*.` }, { quoted: msg });
        return;
      }
      
      const premios = [
        { emoji: '💰', nombre: 'Dinero', cantidad: Math.floor(Math.random() * 8000) + 5000 },
        { emoji: '📚', nombre: 'Experiencia', cantidad: Math.floor(Math.random() * 2000) + 1000 },
        { emoji: '⚡', nombre: 'Poder', cantidad: Math.floor(Math.random() * 500) + 200 },
        { emoji: '🍀', nombre: 'Suerte', cantidad: 0 }
      ];
      
      const premioGanado = premios[Math.floor(Math.random() * premios.length)];
      user.ultimaRuleta = ahora;
      
      if (premioGanado.nombre === 'Dinero') user.dinero += premioGanado.cantidad;
      else if (premioGanado.nombre === 'Experiencia') addExp(user, premioGanado.cantidad);
      else if (premioGanado.nombre === 'Poder') user.poder += premioGanado.cantidad;
      
      guardarBD();
      
      const mensajeRuleta = `*🎡 RULETA DIARIA 🎡*\n\n${Array(8).fill('🔴').join('')}\n\n${premioGanado.emoji} *¡GANASTE!*\n${premioGanado.nombre}${premioGanado.cantidad > 0 ? `: +${premioGanado.cantidad.toLocaleString()}` : ': ¡Mejor suerte mañana!'}`;
      await sock.sendMessage(chatId, { text: mensajeRuleta }, { quoted: msg });
      return;
    }

    if (body === '#adivinanza') {
      const adivinanzas = [
        { pregunta: '¿Cuál es el animal más largo del mundo?', respuesta: 'anaconda' },
        { pregunta: '¿Qué tiene manos pero no puede aplaudir?', respuesta: 'reloj' },
        { pregunta: '¿Cuántas vocales tiene la palabra murciélago?', respuesta: '5' },
        { pregunta: '¿Qué se moja mientras se seca?', respuesta: 'toalla' },
        { pregunta: '¿Cuál es el color del caballo blanco de Santiago?', respuesta: 'blanco' }
      ];
      
      const adivinanza = adivinanzas[Math.floor(Math.random() * adivinanzas.length)];
      
      const mensajeAdivinanza = `*🧩 ADIVINANZA 🧩*\n\n${adivinanza.pregunta}\n\nResponde con: #respuesta [tu respuesta]`;
      await sock.sendMessage(chatId, { text: mensajeAdivinanza }, { quoted: msg });
      
      // Guardar adivinanza activa
      if (!user.adivinanzaActiva) user.adivinanzaActiva = {};
      user.adivinanzaActiva[chatId] = adivinanza;
      guardarBD();
      return;
    }

    if (body === '#bruja' || body === '#brujería') {
      const ahora = Date.now();
      const ultimaBruja = user.ultimaBruja || 0;
      const cooldown = 24 * 3600000;
      const tiempoRestante = ultimaBruja + cooldown - ahora;
      if (tiempoRestante > 0) {
        const horas = Math.floor(tiempoRestante / 3600000);
        await sock.sendMessage(chatId, { text: `🔮 Ya consultaste la bruja hoy. Vuelve en *${horas}h*.` }, { quoted: msg });
        return;
      }
      
      const destinos = [
        '✨ *Hoy tendrás mucha suerte en los negocios* (+1000 coins)',
        '🍀 *Un encuentro misterioso te espera* (+500 exp)',
        '⚡ *El poder fluye a través de ti* (+250 poder)',
        '🎭 *Una sorpresa te aguarda* (¡Abre un cofre!)',
        '💎 *Los astros se alinean a tu favor* (Racha de suerte x1.5)',
        '🌙 *La noche te traerá riquezas* (+2000 coins)',
        '⭐ *Destino especial: conquista tus miedos* (+100 exp)'
      ];
      
      const fortuna = destinos[Math.floor(Math.random() * destinos.length)];
      user.ultimaBruja = ahora;
      
      // Aplicar efectos
      if (fortuna.includes('+1000 coins')) user.dinero += 1000;
      else if (fortuna.includes('+500 exp')) addExp(user, 500);
      else if (fortuna.includes('+250 poder')) user.poder += 250;
      else if (fortuna.includes('+2000 coins')) user.dinero += 2000;
      else if (fortuna.includes('+100 exp')) addExp(user, 100);
      
      guardarBD();
      
      const mensajeBruja = `*🔮 LA BRUJA HABLA 🔮*\n\n${fortuna}`;
      await sock.sendMessage(chatId, { text: mensajeBruja }, { quoted: msg });
      return;
    }

    // Responder adivinanzas
    if (body.startsWith('#respuesta ')) {
      if (!user.adivinanzaActiva || !user.adivinanzaActiva[chatId]) {
        await sock.sendMessage(chatId, { text: '❌ No hay adivinanza activa. Usa #adivinanza primero.' }, { quoted: msg });
        return;
      }
      
      const respuestaUsuario = body.split('#respuesta ')[1].toLowerCase().trim();
      const adivinanzaActual = user.adivinanzaActiva[chatId];
      
      if (respuestaUsuario === adivinanzaActual.respuesta.toLowerCase()) {
        const premio = Math.floor(Math.random() * 3000) + 2000;
        user.dinero += premio;
        delete user.adivinanzaActiva[chatId];
        guardarBD();
        
        const mensajeAcierto = `*✅ ¡CORRECTO!*\n\n🎉 Ganaste *$${premio.toLocaleString()}*\n\nLa respuesta era: *${adivinanzaActual.respuesta}*`;
        await sock.sendMessage(chatId, { text: mensajeAcierto }, { quoted: msg });
      } else {
        const mensajeFallo = `*❌ Respuesta incorrecta*\n\nIntentaste: ${respuestaUsuario}\nLa respuesta correcta era: *${adivinanzaActual.respuesta}*`;
        delete user.adivinanzaActiva[chatId];
        guardarBD();
        await sock.sendMessage(chatId, { text: mensajeFallo }, { quoted: msg });
      }
      return;
    }

    // Comandos sociales inteligentes: identidad, historial, memoria, status
    if (body.startsWith('.identidad') || body.startsWith('#identidad')) {
      let mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      mentioned = mentioned.filter(m => !isBotJid(m));
      const target = mentioned[0] || senderId;
      ensureSocialFields(target);
      const uu = usuarios[target];
      const name = (uu && (uu.name || uu.nombre || uu.displayName)) ? (uu.name || uu.nombre || uu.displayName) : (target.split('@')[0]);
      const text = `🆔 IDENTIDAD DIGITAL DE ${name.toString().toUpperCase()}\nCódigo del Alma: ${uu.identidad}\nEstado: ÚNICO`;
      await sock.sendMessage(chatId, { text }, { quoted: msg });
      return;
    }

    if (body.startsWith('.historial') || body.startsWith('#historial') || body.startsWith('.historialnegro')) {
      let mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      mentioned = mentioned.filter(m => !isBotJid(m));
      const target = mentioned[0] || senderId;
      ensureSocialFields(target);
      const uu = usuarios[target];
      const entries = (uu.historialNegro || []).slice(-50).reverse();
      if (!entries || entries.length === 0) {
        await sock.sendMessage(chatId, { text: `📜 HISTORIAL NEGRO DE ${ (target===senderId)?'TÚ':target.split('@')[0] }\n• (vacío)` }, { quoted: msg });
        return;
      }
      // comprobar permisos (si es grupo, sólo admin puede ver motivos completos)
      let isGroup = chatId && chatId.endsWith('@g.us');
      let isAdmin = false;
      if (isGroup) {
        try {
          const metadata = await sock.groupMetadata(chatId);
          const participante = metadata.participants.find(p => p.id === senderId);
          if (participante) isAdmin = participante.admin === 'admin' || participante.admin === 'superadmin' || participante.isAdmin === true || participante.isSuperAdmin === true;
        } catch (e) { isAdmin = false; }
      }
      const visibility = socialConfig.historialVisibility || 'public';
      let lines;
      if (target !== senderId && isGroup && !isAdmin) {
        // petición desde grupo por usuario no-admin: aplicar política
        if (visibility === 'admins') {
          // no mostrar motivos, indicar que sólo admins pueden ver completo
          lines = entries.map(e => `• ${e.fecha} – ${e.accion}`);
          await sock.sendMessage(chatId, { text: `📜 HISTORIAL (PARCIAL) DE ${target.split('@')[0]}\n• El historial completo está reservado a administradores.` }, { quoted: msg });
          await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: msg });
          return;
        } else if (visibility === 'owner') {
          // no permitir ver a otros
          await sock.sendMessage(chatId, { text: '❌ El historial completo sólo puede ser consultado por administradores o el propio usuario.' }, { quoted: msg });
          lines = entries.map(e => `• ${e.fecha} – ${e.accion}`);
          await sock.sendMessage(chatId, { text: `📜 HISTORIAL (PARCIAL)\n${lines.join('\n')}` }, { quoted: msg });
          return;
        } else {
          // public: mostrar sin motivos (anonimizar motivos)
          lines = entries.map(e => `• ${e.fecha} – ${e.accion}`);
          const header = `📜 HISTORIAL NEGRO DE ${target.split('@')[0].toString().toUpperCase()} (PÚBLICO)`;
          await sock.sendMessage(chatId, { text: `${header}\n${lines.join('\n')}` }, { quoted: msg });
          return;
        }
      }
      // si es el propio usuario o admin o en privado, mostrar completo
      lines = entries.map(e => `• ${e.fecha} – ${e.accion}${e.motivo ? ' ('+e.motivo+')' : ''}`);
      const header = `📜 HISTORIAL NEGRO DE ${(target===senderId)?'TÚ':target.split('@')[0].toString().toUpperCase()}`;
      await sock.sendMessage(chatId, { text: `${header}\n${lines.join('\n')}` }, { quoted: msg });
      return;
    }

    if (body.startsWith('.memoria') || body.startsWith('#memoria')) {
      let mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      mentioned = mentioned.filter(m => !isBotJid(m));
      const target = mentioned[0] || senderId;
      ensureSocialFields(target);
      const uu = usuarios[target];
      const mem = uu.memoria || {};
      const txt = `🧠 MEMORIA DE ${(target===senderId)?'TÚ':target.split('@')[0]}\n• Mensajes totales: ${mem.mensajes||0}\n• Audios enviados: ${mem.audios||0}\n• Silencios: ${mem.silencios||0}\n• Conflictos detectados: ${mem.conflictos||0}`;
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('.status') || body.startsWith('#status') || body.startsWith('.insignias')) {
      let mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      mentioned = mentioned.filter(m => !isBotJid(m));
      const target = mentioned[0] || senderId;
      ensureSocialFields(target);
      const uu = usuarios[target];
      // asignación automática simple (se puede enriquecer)
      let status = uu.status;
      if (!status) {
        if ((uu.memoria && uu.memoria.conflictos || 0) >= 3) status = '🔥 Conflictivo';
        else if ((uu.memoria && uu.memoria.mensajes || 0) < 5) status = '👻 Fantasma';
        else if ((uu.memoria && uu.memoria.mensajes || 0) > 500) status = '🧠 Cerebro del Grupo';
        else if ((uu.memoria && uu.memoria.silencios || 0) > 2) status = '🚨 Problemático';
        else status = '—';
        uu.status = status;
        guardarBD();
      }
      await sock.sendMessage(chatId, { text: `🏷️ STATUS DE ${(target===senderId)?'TÚ':target.split('@')[0]}\n${status}` }, { quoted: msg });
      return;
    }

    // Comandos para ajustar lista de malas palabras y sensibilidad de alertas (sólo admins de grupo)
    if (body.startsWith('#badwords') || body.startsWith('#badword')) {
      const args = body.split(/\s+/).filter(Boolean);
      const isList = body.startsWith('#badwords') && args.length === 1;
      // comprobar admin si es en grupo
      if (chatId && chatId.endsWith('@g.us')) {
        let metadata = null; try { metadata = await sock.groupMetadata(chatId); } catch (e) { metadata = null; }
        let isAdmin = false; if (metadata && metadata.participants) { const p = metadata.participants.find(x => x.id === senderId); if (p) isAdmin = p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true; }
        if (!isAdmin) { await sock.sendMessage(chatId, { text: '❌ Solo administradores de grupo pueden modificar la lista de malas palabras.' }, { quoted: msg }); return; }
      } else {
        await sock.sendMessage(chatId, { text: '❌ Este comando debe ejecutarse en un grupo donde seas admin.' }, { quoted: msg }); return;
      }
      // manejar subcomandos: #badword add <palabra>, #badword remove <palabra>, #badwords
      if (isList) {
        await sock.sendMessage(chatId, { text: `🔎 Malas palabras actuales:\n${(socialConfig.badWords||[]).join(', ')}` }, { quoted: msg });
        return;
      }
      const sub = args[1];
      if (!sub) { await sock.sendMessage(chatId, { text: 'Uso: #badword add|remove <palabra>  o  #badwords' }, { quoted: msg }); return; }
      if (sub === 'add') {
        const w = args[2]; if (!w) { await sock.sendMessage(chatId, { text: 'Especifica la palabra a añadir.' }, { quoted: msg }); return; }
        if (!socialConfig.badWords.includes(w)) socialConfig.badWords.push(w);
        SOCIAL_BAD_WORDS = socialConfig.badWords;
        saveSocialConfig();
        await sock.sendMessage(chatId, { text: `✅ Añadida palabra: ${w}` }, { quoted: msg });
        return;
      }
      if (sub === 'remove' || sub === 'del') {
        const w = args[2]; if (!w) { await sock.sendMessage(chatId, { text: 'Especifica la palabra a eliminar.' }, { quoted: msg }); return; }
        socialConfig.badWords = (socialConfig.badWords||[]).filter(x => x !== w);
        SOCIAL_BAD_WORDS = socialConfig.badWords;
        saveSocialConfig();
        await sock.sendMessage(chatId, { text: `✅ Eliminada palabra: ${w}` }, { quoted: msg });
        return;
      }
      await sock.sendMessage(chatId, { text: 'Subcomando desconocido. Uso: #badword add|remove <palabra>  o  #badwords' }, { quoted: msg });
      return;
    }

    if (body.startsWith('#alertthreshold') || body.startsWith('#alertwindow') || body.startsWith('#historialvis')) {
      // comandos de configuración de alertas / historial (admins)
      if (!(chatId && chatId.endsWith('@g.us'))) { await sock.sendMessage(chatId, { text: '❌ Ejecuta este comando en el grupo como administrador.' }, { quoted: msg }); return; }
      let metadata = null; try { metadata = await sock.groupMetadata(chatId); } catch (e) { metadata = null; }
      let isAdmin = false; if (metadata && metadata.participants) { const p = metadata.participants.find(x => x.id === senderId); if (p) isAdmin = p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true; }
      if (!isAdmin) { await sock.sendMessage(chatId, { text: '❌ Solo administradores pueden cambiar la configuración.' }, { quoted: msg }); return; }
      const parts = body.split(/\s+/).filter(Boolean);
      if (body.startsWith('#alertthreshold')) {
        const n = parseInt(parts[1]); if (!n || n < 5) { await sock.sendMessage(chatId, { text: 'Especifica un número válido (ej: 30).' }, { quoted: msg }); return; }
        socialConfig.alertThreshold = n; saveSocialConfig(); await sock.sendMessage(chatId, { text: `✅ Umbral de alerta establecido a ${n} mensajes por ventana.` }, { quoted: msg }); return;
      }
      if (body.startsWith('#alertwindow')) {
        const s = parseInt(parts[1]); if (!s || s < 5) { await sock.sendMessage(chatId, { text: 'Especifica segundos válidos (ej: 60).' }, { quoted: msg }); return; }
        socialConfig.alertWindowMs = s * 1000; saveSocialConfig(); await sock.sendMessage(chatId, { text: `✅ Ventana de alerta establecida a ${s}s.` }, { quoted: msg }); return;
      }
      if (body.startsWith('#historialvis')) {
        const v = (parts[1] || '').toLowerCase(); if (!['public','admins','owner'].includes(v)) { await sock.sendMessage(chatId, { text: 'Opciones válidas: public, admins, owner' }, { quoted: msg }); return; }
        socialConfig.historialVisibility = v; saveSocialConfig(); await sock.sendMessage(chatId, { text: `✅ Política de visibilidad del historial actualizada: ${v}` }, { quoted: msg }); return;
      }
      return;
    }

    // ------------------ SISTEMAS DIVINOS AVANZADOS ------------------
    // Config
    const ASCENSION_POWER_THRESHOLD = 7000000;
    const ASCENSION_REQ_PRESTIGE = 5;

    const AURAS = {
      aura_caos: { id: 'aura_caos', nombre: 'Aura del Caos', efecto: '+20% crítico' },
      aura_celestial: { id: 'aura_celestial', nombre: 'Aura Celestial', efecto: '+10% vida y defensa' },
      aura_vacio: { id: 'aura_vacio', nombre: 'Aura del Vacío', efecto: '+8% esquiva' },
      aura_divina: { id: 'aura_divina', nombre: 'Aura Divina', efecto: '+15% EXP, +10% poder (solo Deidades)' }
    };

    const LINEAGES = {
      titán: { id: 'titan', nombre: 'Sangre del Titán', efecto: '+poder por nivel' },
      celestial: { id: 'celestial', nombre: 'Sangre Celestial', efecto: '+defensa y vida' },
      abismo: { id: 'abismo', nombre: 'Sangre del Abismo', efecto: 'daño explosivo' },
      antigua: { id: 'antigua', nombre: 'Sangre Antigua', efecto: 'balanceado + suerte' }
    };

    const TITLES = {
      dios_primordial: { id: 'dios_primordial', nombre: 'Dios Primordial' },
      deidad_vacio: { id: 'deidad_vacio', nombre: 'Deidad del Vacío' },
      destructor: { id: 'destructor', nombre: 'Destructor de Mundos' },
      eterno_supremo: { id: 'eterno_supremo', nombre: 'Eterno Supremo' }
    };

    // Ascensión a Dios
    if (body.startsWith('.ascender') || body.startsWith('#ascender') || body.startsWith('.ascend')) {
      // comprobar condiciones
      if (user.deidad) { await sock.sendMessage(chatId, { text: '❌ Ya has ascendido previamente.' }, { quoted: msg }); return; }
      const powerOk = (user.poder || 0) >= ASCENSION_POWER_THRESHOLD;
      const prestigeOk = (user.prestige || 0) >= ASCENSION_REQ_PRESTIGE;
      // rank check: aceptar si bestSeasonRank incluye 'etern' (Eterniun/Eterno)
      const rankName = (user.bestSeasonRank || '').toString().toLowerCase();
      const rankOk = rankName.includes('etern');
      const hasRelic = (user.inventario && (user.inventario['reliquia_divina'] || 0) > 0);
      if (!powerOk || !prestigeOk || !rankOk || !hasRelic) {
        let falta = [];
        if (!powerOk) falta.push(`Poder >= ${ASCENSION_POWER_THRESHOLD}`);
        if (!prestigeOk) falta.push(`Prestigio >= ${ASCENSION_REQ_PRESTIGE}`);
        if (!rankOk) falta.push(`Clase mínima: Eterniun S (mejor temporada)`);
        if (!hasRelic) falta.push(`Item: reliquia_divina en inventario`);
        await sock.sendMessage(chatId, { text: `❌ No cumples los requisitos para ascender:\n• ${falta.join('\n• ')}` }, { quoted: msg });
        return;
      }
      // consumir reliquia
      user.inventario['reliquia_divina'] = Math.max(0, (user.inventario['reliquia_divina']||0) - 1);
      user.deidad = true;
      user.aura = AURAS['aura_divina'];
      user.titulo = '🌠 Dios Ascendido';
      // buffs permanentes
      user.deidadBuffs = { expMult: 1.15, poderPct: 0.10 };
      guardarBD();
      const epic = `🌠 ASCENSIÓN COMPLETA 🌠\nHas trascendido los límites mortales.\nAhora eres una DEIDAD.\nAura: ${user.aura.nombre}\nTítulo: ${user.titulo}`;
      await sock.sendMessage(chatId, { text: epic }, { quoted: msg });
      return;
    }

    // Sistema de Auras
    if (body.startsWith('.aura') || body.startsWith('#aura')) {
      const parts = body.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        const list = Object.values(AURAS).map(a => `${a.id} — ${a.nombre} — ${a.efecto}`).join('\n');
        await sock.sendMessage(chatId, { text: `🔮 Auras disponibles:\n${list}\n\nUsa: .aura equipar [aura_id]` }, { quoted: msg });
        return;
      }
      if (parts[1] === 'equipar' || parts[1] === 'equip') {
        const aid = parts[2];
        if (!aid || !AURAS[aid]) { await sock.sendMessage(chatId, { text: '❌ Aura desconocida.' }, { quoted: msg }); return; }
        if (aid === 'aura_divina' && !user.deidad) { await sock.sendMessage(chatId, { text: '❌ Solo las Deidades pueden equipar la Aura Divina.' }, { quoted: msg }); return; }
        user.aura = AURAS[aid]; guardarBD(); await sock.sendMessage(chatId, { text: `✅ Aura equipada: ${AURAS[aid].nombre}` }, { quoted: msg }); return;
      }
      return;
    }

    // Sistema de Linajes
    if (body.startsWith('.linaje') || body.startsWith('#linaje')) {
      const parts = body.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        const list = Object.entries(LINEAGES).map(([k,v]) => `${k} — ${v.nombre} — ${v.efecto}`).join('\n');
        await sock.sendMessage(chatId, { text: `🩸 Linajes disponibles:\n${list}\n\nUsa: .linaje elegir [clave]` }, { quoted: msg }); return;
      }
      if (parts[1] === 'elegir' || parts[1] === 'choose') {
        const key = parts[2];
        if (!key || !LINEAGES[key]) { await sock.sendMessage(chatId, { text: '❌ Linaje inválido.' }, { quoted: msg }); return; }
        if (user.linaje) { await sock.sendMessage(chatId, { text: '❌ Ya elegiste un linaje. Solo cambios en eventos especiales.' }, { quoted: msg }); return; }
        await sock.sendMessage(chatId, { text: `✅ Linaje elegido: ${LINEAGES[key].nombre}` }, { quoted: msg }); return;
      }
      return;
    }

    // Títulos visibles
    if (body.startsWith('.titulo') || body.startsWith('#titulo')) {
      const parts = body.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        const list = Object.values(TITLES).map(t => `${t.id} — ${t.nombre}`).join('\n');
        await sock.sendMessage(chatId, { text: `👑 Títulos disponibles:\n${list}\n\nUsa: .titulo equipar [id]` }, { quoted: msg }); return;
      }
      if (parts[1] === 'equipar' || parts[1] === 'equip') {
        const tid = parts[2]; if (!tid || !TITLES[tid]) { await sock.sendMessage(chatId, { text: '❌ Título inválido.' }, { quoted: msg }); return; }
        user.titulo = TITLES[tid].nombre; guardarBD(); await sock.sendMessage(chatId, { text: `✅ Título equipado: ${user.titulo}` }, { quoted: msg }); return;
      }
      return;
    }

    // ===== SISTEMA DE LOGROS =====
    if (body === '#logros' || body === '#achievements') {
      const logros = achievementsManager.getUserAchievements(senderId);
      const desbloqueados = achievementsManager.getUnlockedAchievements(senderId);
      let txt = `*✦ TUS LOGROS ✦*\n\n`;
      
      const porTipo = {};
      logros.forEach(l => {
        if (!porTipo[l.tipo]) porTipo[l.tipo] = [];
        porTipo[l.tipo].push(l);
      });

      const tipoEmojis = {
        'combate': '⚔️',
        'economia': '💰',
        'social': '👥',
        'exploracion': '🗺️',
        'especial': '✨'
      };

      for (const tipo in porTipo) {
        const tipoLogros = porTipo[tipo];
        const desbloq = tipoLogros.filter(l => l.desbloqueado).length;
        const emoji = tipoEmojis[tipo] || '▸';
        const barra = '█'.repeat(desbloq) + '░'.repeat(tipoLogros.length - desbloq);
        txt += `\n${emoji} *${tipo.toUpperCase()}* (${desbloq}/${tipoLogros.length})\n`;
        txt += `${barra}\n`;
        
        tipoLogros.forEach(logro => {
          if (logro.desbloqueado) {
            txt += `▸ ${logro.emoji} ${logro.nombre}\n`;
          } else {
            txt += `▸ 🔒 [BLOQUEADO]\n`;
          }
        });
      }

      txt += `\n*─────────────────*\n`;
      txt += `▸ Desbloqueados: ${desbloqueados.length}/${logros.length}\n`;
      txt += `▸ Progreso: ${Math.floor((desbloqueados.length / logros.length) * 100)}%\n`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    // ===== SISTEMA DE EVENTOS Y TORNEOS =====
    if (body === '#eventos' || body === '#events') {
      const eventosActivos = eventosManager.getEventosActivos();
      const eventosProximos = eventosManager.getEventosProximos();
      
      let txt = `🎪 EVENTOS Y TORNEOS 🎪\n\n`;
      
      if (eventosActivos.length > 0) {
        txt += `⚡ *EVENTOS ACTIVOS* ⚡\n`;
        eventosActivos.forEach((e, i) => {
          txt += `\n${i+1}. ${e.nombre}\n`;
          txt += `   📝 ${e.descripcion}\n`;
          txt += `   👥 Participantes: ${e.participantes.length}\n`;
          txt += `   💰 Recompensa: $${(e.recompensaBase * e.multiplicador).toLocaleString()}\n`;
          txt += `   📌 ID: ${e.id}\n`;
          txt += `   Escribe: #join ${e.id}\n`;
        });
      }

      if (eventosProximos.length > 0) {
        txt += `\n\n📅 *PRÓXIMOS EVENTOS*\n`;
        eventosProximos.forEach((e, i) => {
          txt += `\n${i+1}. ${e.nombre} (${e.fechaInicio} - ${e.fechaFin})\n`;
          txt += `   📝 ${e.descripcion}\n`;
        });
      }

      if (eventosActivos.length === 0 && eventosProximos.length === 0) {
        txt += `Sin eventos en este momento.`;
      }

      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('#join ')) {
      const eventoId = body.split(' ')[1];
      if (!eventoId) {
        await sock.sendMessage(chatId, { text: '🎯 Uso: #join [evento_id]\n\nEscribe #eventos para ver los eventos activos' }, { quoted: msg });
        return;
      }

      const resultado = eventosManager.registrarEnEvento(senderId, eventoId);
      if (resultado.exito) {
        const evento = eventosManager.eventos.find(e => e.id === eventoId);
        let txt = `${resultado.mensaje}\n\n`;
        txt += `🎊 Detalles:\n`;
        txt += `📝 ${evento.descripcion}\n`;
        txt += `👥 Participantes: ${evento.participantes.length}\n`;
        txt += `💰 Recompensa: $${(evento.recompensaBase * evento.multiplicador).toLocaleString()}\n`;
        await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
        
        // Verificar logros
        achievementsManager.checkAchievements(senderId);
      } else {
        await sock.sendMessage(chatId, { text: `❌ ${resultado.mensaje}` }, { quoted: msg });
      }
      return;
    }

    if (body === '#torneos' || body === '#tournaments') {
      const torneosProximos = eventosManager.getTorneosProximos();
      const torneosActivos = eventosManager.getTorneosActivos();
      
      let txt = `🏆 TORNEOS 🏆\n\n`;
      
      if (torneosActivos.length > 0) {
        txt += `⚡ *EN CURSO* ⚡\n`;
        torneosActivos.forEach((t, i) => {
          const info = eventosManager.getTorneoInfo(t.id);
          txt += `\n${i+1}. ${t.nombre}\n`;
          txt += `   📝 ${t.descripcion}\n`;
          txt += `   👥 Participantes: ${t.participantes.length}/${t.maxParticipantes}\n`;
          txt += `   💰 Premios: 1º: $${t.premios['1'].toLocaleString()}, 2º: $${t.premios['2'].toLocaleString()}, 3º: $${t.premios['3'].toLocaleString()}\n`;
          txt += `   📌 ID: ${t.id}\n`;
          txt += `   Escribe: #jointorneo ${t.id}\n`;
        });
      }

      if (torneosProximos.length > 0) {
        txt += `\n\n📅 *PRÓXIMOS TORNEOS*\n`;
        torneosProximos.forEach((t, i) => {
          const info = eventosManager.getTorneoInfo(t.id);
          txt += `\n${i+1}. ${t.nombre} (${t.fechaInicio} - ${t.fechaFin})\n`;
          txt += `   👥 Vacantes: ${info.vacantes}/${t.maxParticipantes}\n`;
          txt += `   💰 Premios: 1º: $${t.premios['1'].toLocaleString()}\n`;
        });
      }

      if (torneosActivos.length === 0 && torneosProximos.length === 0) {
        txt += `Sin torneos en este momento.`;
      }

      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('#jointorneo ')) {
      const torneoId = body.split(' ')[1];
      if (!torneoId) {
        await sock.sendMessage(chatId, { text: '🏆 Uso: #jointorneo [torneo_id]' }, { quoted: msg });
        return;
      }

      const resultado = eventosManager.registrarEnTorneo(senderId, torneoId);
      if (resultado.exito) {
        const torneo = eventosManager.torneos.find(t => t.id === torneoId);
        let txt = `${resultado.mensaje}\n\n`;
        txt += `🏆 Detalles:\n`;
        txt += `📝 ${torneo.descripcion}\n`;
        txt += `👥 Participantes: ${torneo.participantes.length}/${torneo.maxParticipantes}\n`;
        txt += `💰 Premios: 1º: $${torneo.premios['1'].toLocaleString()}, 2º: $${torneo.premios['2'].toLocaleString()}, 3º: $${torneo.premios['3'].toLocaleString()}\n`;
        await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { text: `❌ ${resultado.mensaje}` }, { quoted: msg });
      }
      return;
    }

    // ===== SISTEMA DE DUNGEONS/MAZMORRAS =====
    if (body === '#dungeons' || body === '#mazmorras') {
      const dungeons = dungeonsManager.getDungeonsDisponibles();
      let txt = `🏰 MAZMORRAS DISPONIBLES 🏰\n\n`;
      
      dungeons.forEach((d, i) => {
        txt += `${i+1}. ${d.nombre}\n`;
        txt += `   🔴 Dificultad: ${d.dificultad}\n`;
        txt += `   📊 Niveles: ${d.niveles}\n`;
        txt += `   💰 Recompensa: $${d.recompensa.toLocaleString()}\n`;
        txt += `   Escribe: #entrar ${d.id}\n\n`;
      });

      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('#entrar ')) {
      const dungeonId = body.split(' ')[1];
      if (!dungeonId) {
        await sock.sendMessage(chatId, { text: '🏰 Usa: #entrar [dungeon_id]' }, { quoted: msg });
        return;
      }

      const resultado = dungeonsManager.crearInstancia(senderId, dungeonId);
      if (!resultado.exito) {
        await sock.sendMessage(chatId, { text: `❌ ${resultado.mensaje}` }, { quoted: msg });
        return;
      }

      const dungeon = dungeonsManager.dungeons.find(d => d.id === dungeonId);
      let txt = `⚔️ *¡Entraste a ${dungeon.nombre}!*\n\n`;
      txt += `🏰 Mazmorra de ${dungeon.dificultad.toLowerCase()}\n`;
      txt += `📊 Niveles: ${dungeon.niveles}\n`;
      txt += `❤️ Tu vida: ${resultado.instancia.vidaUsuario}/${resultado.instancia.vidaMaxima}\n`;
      txt += `💰 Dinero acumulado: $${resultado.instancia.dineroAcumulado}\n\n`;
      txt += `Escribe: #atacar para enfrentar enemigos\n`;
      txt += `Escribe: #abandonar para salir (con dinero acumulado)\n`;

      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === '#atacar') {
      const instancia = dungeonsManager.getInstanciaActiva(senderId);
      if (!instancia) {
        await sock.sendMessage(chatId, { text: '❌ No estás en una mazmorra. Usa #entrar [id]' }, { quoted: msg });
        return;
      }

      const resultado = dungeonsManager.combatirEnemigo(instancia.id);
      
      if (resultado.exito) {
        const dungeon = dungeonsManager.dungeons.find(d => d.id === instancia.dungeonId);
        
        if (resultado.dineroGanado > 0) {
          // Mazmorra completada
          let txt = `✅ *¡Completaste ${dungeon.nombre}!*\n\n`;
          txt += `💰 Dinero ganado: $${resultado.dineroGanado.toLocaleString()}\n`;
          txt += `👹 Enemigos derrotados: ${resultado.instancia.enemigosDerotados}\n`;
          txt += `📊 Progreso: ${resultado.instancia.nivel}/${dungeon.niveles}\n\n`;
          txt += `🎉 ¡Excelente trabajo!`;
          
          await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
          
          // Verificar logros
          achievementsManager.checkAchievements(senderId);
          guardarBD();
        } else {
          // En progreso
          const dungeon = dungeonsManager.dungeons.find(d => d.id === instancia.dungeonId);
          let txt = `⚔️ *Combate en progreso*\n\n`;
          txt += `❤️ Tu vida: ${resultado.instancia.vidaUsuario}/${resultado.instancia.vidaMaxima}\n`;
          txt += `💰 Dinero acumulado: $${resultado.instancia.dineroAcumulado.toLocaleString()}\n`;
          txt += `📊 Nivel: ${resultado.instancia.nivel}/${dungeon.niveles}\n`;
          txt += `\n${resultado.mensaje}`;

          await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
        }
      } else {
        // Fracaso
        let txt = `❌ *¡Fuiste derrotado!*\n\n`;
        txt += `💰 Dinero perdido (ganado nada)\n`;
        txt += `👹 Enemigos derrotados: ${resultado.instancia.enemigosDerotados}\n`;
        txt += `⏱️ Espera 30 minutos antes de intentar otra vez\n`;

        await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
        guardarBD();
      }
      return;
    }

    if (body === '#abandonar') {
      const instancia = dungeonsManager.getInstanciaActiva(senderId);
      if (!instancia) {
        await sock.sendMessage(chatId, { text: '❌ No estás en una mazmorra' }, { quoted: msg });
        return;
      }

      const resultado = dungeonsManager.abandonarMazmorra(instancia.id);
      let txt = `${resultado.mensaje}\n\n`;
      txt += `💰 Dinero obtenido: $${resultado.dineroObtenido.toLocaleString()}`;

      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      guardarBD();
      return;
    }

    // Bosses con fases (admin crea): #boss crear [name] [maxHp] [godOnly?]
    if (body.startsWith('#boss')) {
      const parts = body.split(/\s+/).filter(Boolean);
      const sub = parts[1] || '';
      if (sub === 'crear') {
        const isAdmin = senderId === ADMIN_SUPREMO || adminsSupremos[senderId];
        // Admin: comportamiento previo (crear boss global/file-based)
        if (isAdmin) {
          const name = parts[2] || `Boss_${Date.now()}`;
          const maxHp = Number(parts[3] || 1000000);
          const godOnly = parts[4] === 'god';
          const bid = genId('boss');
          const boss = { id: bid, name, maxHp, hp: maxHp, phases: [{ pct:50, name:'Furia' }, { pct:15, name:'Sacrificio' }], godOnly, participants: {} };
          // persistir en bosses.json
          let bosses = [];
          if (fs.existsSync('bosses.json')) { try { bosses = JSON.parse(fs.readFileSync('bosses.json')); } catch (e) { bosses = []; } }
          bosses.push(boss); fs.writeFileSync('bosses.json', JSON.stringify(bosses, null, 2));
          await sock.sendMessage(chatId, { text: `👹 Boss creado: ${name} (ID: ${bid})` }, { quoted: msg }); return;
        }
        // Usuarios normales: crear boss PERSONAL con dificultades y cooldown (1 hora)
        const name = parts[2] || `Coloso_${Date.now()}`;
        const dificultad = (parts[3] || 'facil').toLowerCase();
        const diffs = {
          'facil': { mult: 1 },
          'medio': { mult: 1.5 },
          'dificil': { mult: 3 },
          'imposible': { mult: 6 },
          'importal': { mult: 12 }
        };
        const diff = diffs[dificultad] || diffs['facil'];
        // cooldown: evitar crear bosses personales con demasiada frecuencia (1 hora)
        const lastCreate = usuarios[senderId] && usuarios[senderId].lastBossCreate;
        const cooldown = 60*60*1000; // 1 hora
        if (lastCreate && (Date.now() - lastCreate) < cooldown) {
          const rem = Math.ceil((cooldown - (Date.now() - lastCreate))/60000);
          await sock.sendMessage(chatId, { text: `❌ Debes esperar ${rem} minutos antes de crear otro boss personal.` }, { quoted: msg }); return;
        }
        // Prohibir 'importal' salvo admins
        if (dificultad === 'importal') { await sock.sendMessage(chatId, { text: '❌ Solo admins pueden crear bosses de dificultad importal.' }, { quoted: msg }); return; }
        const baseHp = 1000;
        const vidaMax = Math.max(50, Math.floor(baseHp * diff.mult));
        const durMin = 30; // duración por defecto 30 min para personales
        const id = 'boss_' + Math.random().toString(36).slice(2,10);
        const boss = {
          bossId: id,
          nombre: name,
          vidaMax,
          vidaActual: vidaMax,
          ownerId: senderId,
          personal: true,
          importal: false,
          dificultad,
          inicio: Date.now(),
          fin: Date.now() + durMin*60*1000,
          rankingDaño: {},
          activo: true,
          lootPool: []
        };
        bossesData.bosses.push(boss);
        usuarios[senderId].lastBossCreate = Date.now();
        saveBosses(); guardarBD();
        
        // Información sobre puntos según dificultad
        const puntosInfo = {
          'facil': 50,
          'medio': 100,
          'dificil': 200,
          'imposible': 500,
          'importal': 1000
        };
        const puntosBase = puntosInfo[dificultad] || 50;
        
        await sock.sendMessage(chatId, { text: `👹 Boss personal creado: ${name}\nID: ${id}\nDificultad: ${dificultad}\nHP: ${vidaMax}\n\n📊 Recompensas:\n1️⃣ 1er lugar: ${puntosBase} puntos + Cofre Mitológico\n2️⃣ 2do lugar: ${Math.floor(puntosBase * 0.6)} puntos + Cofre Raro\n3️⃣ 3er lugar: ${Math.floor(puntosBase * 0.3)} puntos + Cofre Común\n\nSolo el creador puede atacarlo.\n\nUso:\n#boss atacar ${id}` }, { quoted: msg });
        return;
      }
      if (sub === 'atacar' || sub === 'attack') {
        const bid = parts[2]; if (!bid) { await sock.sendMessage(chatId, { text: 'Uso: #boss atacar [id]' }, { quoted: msg }); return; }
        // cargar bosses
        let bosses = []; if (fs.existsSync('bosses.json')) { try { bosses = JSON.parse(fs.readFileSync('bosses.json')); } catch (e) { bosses = []; } }
        const boss = bosses.find(b=>b.id===bid);
        if (!boss) { await sock.sendMessage(chatId, { text: '🔕 Boss no encontrado.' }, { quoted: msg }); return; }
        if (boss.godOnly && !user.deidad) { await sock.sendMessage(chatId, { text: '❌ Este boss solo puede ser atacado por Deidades.' }, { quoted: msg }); return; }
        const ahora = Date.now();
            const dmgBase = Math.max(10, Math.floor((user.poder||100) * (0.3 + Math.random()*1.2) * (1 + (user.prestigeBonus || 0) / 100)));
            // aplicar buffs de linaje / aura / deidad
            let dmg = dmgBase;
            // aplicar multiplicador de arma si el usuario tiene equipada
            try {
              const wid = user.equipo && user.equipo.weapon;
              const item = getWeaponItem(wid);
              if (item) dmg = Math.floor(dmg * getWeaponMultiplierByItem(item));
            } catch (e) {}
        if (user.deidad && user.deidadBuffs && user.deidadBuffs.poderPct) dmg = Math.floor(dmg * (1 + user.deidadBuffs.poderPct));
        if (user.linaje === 'titan') dmg = Math.floor(dmg * 1.08);
        boss.hp = Math.max(0, boss.hp - dmg);
        boss.participants[senderId] = (boss.participants[senderId]||0) + dmg;
        fs.writeFileSync('bosses.json', JSON.stringify(bosses, null, 2));
        guardarBD();
        // detectar fase
        const pct = (boss.hp / boss.maxHp) * 100;
        let fase = '⚔️ Fase 1'; let faseColor = '▸';
        if (pct <= 50 && pct > 15) { fase = '⚡ Fase 2 (FURIA)'; faseColor = '▸'; }
        else if (pct <= 15) { fase = '💀 Fase 3 (SACRIFICIO)'; faseColor = '▸'; }
        
        // Crear barra visual de HP
        const hpPercent = Math.max(0, pct);
        const barraFull = Math.floor(hpPercent / 10);
        const barraVacia = 10 - barraFull;
        const barraHP = '█'.repeat(barraFull) + '░'.repeat(barraVacia);
        
        if (boss.hp === 0) {
          // rewards especiales
          for (const pid of Object.keys(boss.participants||{})) {
            const pusr = usuarios[pid]; if (!pusr) continue;
            const dmg = boss.participants[pid]; const share = Math.max(500, Math.floor(dmg/10)); pusr.dinero = (pusr.dinero||0) + share; addExp(pusr, 500); addSeasonPoints(pid, Math.max(200, Math.floor(dmg/50))); guardarBD();
            // drops exclusivos si in final phase
            if (pct <= 0) { pusr.inventario = pusr.inventario || {}; pusr.inventario['reliquia_divina'] = (pusr.inventario['reliquia_divina']||0) + 1; }
          }
          // eliminar boss
          bosses = bosses.filter(b=>b.id!==boss.id); fs.writeFileSync('bosses.json', JSON.stringify(bosses, null, 2));
          await sock.sendMessage(chatId, { text: `🏆 *${boss.name} DERROTADO* 🏆\n\n▸ Recompensas entregadas a todos los participantes\n▸ Dinero distribuido\n▸ Experiencia otorgada` }, { quoted: msg });
          return;
        }
        
        const totalDamageBoss = Object.values(boss.participants).reduce((a,b)=>a+b,0);
        const userDamagePercent = Math.floor((boss.participants[senderId] / totalDamageBoss) * 100);
        
        const mensajeBoss = `⚔️ *ATAQUE AL BOSS*

▸ *${boss.name}*
▸ ${fase}

*─ HP ─*
${barraHP} ${Math.round(hpPercent)}%
${boss.hp.toLocaleString()} / ${boss.maxHp.toLocaleString()}

*─ DAÑO ─*
▸ Tu golpe: *+${dmg}* daño
▸ Tu participación: ${userDamagePercent}%
▸ Daño total: ${totalDamageBoss.toLocaleString()}

▸ Participantes: ${Object.keys(boss.participants).length}`;
        
        await sock.sendMessage(chatId, { text: mensajeBoss }, { quoted: msg });
        return;
      }
      return;
    }

    // ---------- EVENTOS GLOBALES (admin) ----------
    let globalEvents = [];
    if (fs.existsSync('globalevents.json')) { try { globalEvents = JSON.parse(fs.readFileSync('globalevents.json')); } catch (e) { globalEvents = []; } }
    const globalModifiers = { expMult: 1.0, dropMult: 1.0, critBonus: 0 };
    // admin command: #globalevent start [name] [hours] [type]
    if (body.startsWith('#globalevent')) {
      const parts = body.split(/\s+/).filter(Boolean); const sub = parts[1] || '';
      const isAdmin = senderId === ADMIN_SUPREMO || adminsSupremos[senderId];
      if (!isAdmin) { await sock.sendMessage(chatId, { text: '❌ Solo admins pueden controlar eventos globales.' }, { quoted: msg }); return; }
      if (sub === 'start') {
        const name = parts[2] || 'Evento'; const hours = Number(parts[3] || 12); const type = parts[4] || 'exp';
        const ev = { id: genId('gev'), name, type, startedAt: Date.now(), endsAt: Date.now()+hours*3600000 };
        globalEvents.push(ev); fs.writeFileSync('globalevents.json', JSON.stringify(globalEvents, null, 2));
        // aplicar efecto simple
        if (type === 'exp') globalModifiers.expMult = 2.0;
        if (type === 'drop') globalModifiers.dropMult = 2.0;
        if (type === 'crit') globalModifiers.critBonus = 20;
        await sock.sendMessage(chatId, { text: `✅ Evento global iniciado: ${name}` }, { quoted: msg });
        return;
      }
      if (sub === 'list') { await sock.sendMessage(chatId, { text: `Eventos activos:\n${globalEvents.map(e=>`${e.id} ${e.name} termina: ${new Date(e.endsAt).toLocaleString()}`).join('\n')}` }, { quoted: msg }); return; }
      return;
    }

    // ---------- FIN SISTEMAS DIVINOS ----------------

    if (body.startsWith("#usar ")) {
      const itemId = body.split(" ")[1];
      if (!user.inventario[itemId] || user.inventario[itemId] <= 0) {
        await sock.sendMessage(chatId, { 
          text: `❌ No tienes ese item en tu inventario\n\n💡 Usa *#inventario* para ver tus items`
        }, { quoted: msg });
        return;
      }
      const item = buscarItem(itemId);
      if (!item || item.categoria !== 'consumibles') {
        await sock.sendMessage(chatId, { text: `❌ Este item no es consumible` }, { quoted: msg });
        return;
      }
      user.inventario[itemId]--;
      let efectoTexto = "";
      if (item.efecto === 'vida') {
        user.vida = Math.min(100, user.vida + item.valor);
        efectoTexto = `❤️ Vida restaurada: ${user.vida}/100`;
      } else if (item.efecto === 'poder_temp') {
        user.poder += item.valor;
        efectoTexto = `⚡ +${item.valor} poder ganado`;
      } else if (item.efecto === 'exp') {
        const resExp = addExp(user, item.valor);
        efectoTexto = `📚 +${item.valor} EXP\n◊ Nivel: ${user.nivel}`;
      }
      guardarBD();
      await sock.sendMessage(chatId, { 
        text: `✅ ¡Item usado!\n\n${item.emoji} *${item.nombre}*\n${efectoTexto}`
      }, { quoted: msg });
    }

    // ---------- NUEVAS MECÁNICAS AVANZADAS ----------
    function ensureGameFields(u) {
      if (!u) return;
      if (!u.cooldowns) u.cooldowns = {};
      if (u.skillPoints === undefined) u.skillPoints = 0;
      if (!u.skills) u.skills = [];
      if (u.seasonPoints === undefined) u.seasonPoints = 0;
      if (!u.inventario) u.inventario = {};
    }

    // ---- RAID ----
    if (body.startsWith("#raid")) {
      ensureGameFields(user);
      const parts = body.split(/\s+/).filter(Boolean);
      const sub = parts[1] || '';
      const key = 'global';
      if (!raids[key]) raids[key] = null;
      if (sub === 'start') {
        if (raids[key] && raids[key].hp > 0) {
          await sock.sendMessage(chatId, { text: '❌ Ya hay un raid activo. Únete con #raid join' }, { quoted: msg });
          return;
        }
        const boss = { bossName: parts.slice(2).join(' ') || 'Ancient Goliath', maxHp: 150000, hp: 150000, participants: {}, startedAt: Date.now() };
        raids[key] = boss;
        saveJson('raids.json', raids);
        await sock.sendMessage(chatId, { text: `⚔️ Raid iniciado: *${boss.bossName}*\nHP: ${boss.hp}` }, { quoted: msg });
        return;
      }
      if (sub === 'join' || sub === 'attack' || sub === 'atacar') {
        if (!raids[key] || raids[key].hp <= 0) {
          await sock.sendMessage(chatId, { text: '❌ No hay un raid activo. Comienza uno con #raid start [nombre]' }, { quoted: msg });
          return;
        }
        const cdKey = 'raid_attack';
        const ahora = Date.now();
        const cd = user.cooldowns[cdKey] || 0;
        const cdMs = 10*60*1000;
        if (ahora < cd) {
          const left = Math.ceil((cd - ahora)/60000);
          await sock.sendMessage(chatId, { text: `⏳ Debes esperar ${left} minuto(s) para volver a atacar el raid.` }, { quoted: msg });
          return;
        }
        let damage = Math.max(50, Math.floor((user.poder || 100) * (0.2 + Math.random()*1.2)));
        if (user.skills && user.skills.includes('guerrero')) damage = Math.floor(damage * 1.1);
        raids[key].hp = Math.max(0, raids[key].hp - damage);
        raids[key].participants[senderId] = (raids[key].participants[senderId] || 0) + damage;
        user.cooldowns[cdKey] = ahora + cdMs;
        guardarBD();
        saveJson('raids.json', raids);
        if (raids[key].hp === 0) {
          // rewards
          const participants = Object.keys(raids[key].participants || {});
          for (const pid of participants) {
            const pusr = usuarios[pid];
            if (!pusr) continue;
            const dmg = raids[key].participants[pid];
            const share = Math.max(50, Math.floor(dmg/100));
            addSeasonPoints(pid, share);
            const expGain = Math.floor(200 + Math.random()*300 + (pusr.nivel||1)*20);
            addExp(pusr, expGain);
            guardarBD();
          }
          const name = raids[key].bossName;
          raids[key] = null;
          saveJson('raids.json', raids);
          await sock.sendMessage(chatId, { text: `🏆 ¡Boss *${name}* derrotado! Recompensas distribuidas entre participantes.` }, { quoted: msg });
        } else {
          await sock.sendMessage(chatId, { text: `⚔️ Atacaste al boss y causaste *${damage}* de daño.\nBoss HP restante: *${raids[key].hp}*` }, { quoted: msg });
        }
        return;
      }
      // status
      if (!raids[key] || raids[key].hp <= 0) {
        await sock.sendMessage(chatId, { text: '🔕 No hay raids activos. Inicia uno con: #raid start [nombre]' }, { quoted: msg });
      } else {
        const b = raids[key];
        await sock.sendMessage(chatId, { text: `⚔️ Raid: *${b.bossName}*\nHP: *${b.hp} / ${b.maxHp}*\nParticipantes: *${Object.keys(b.participants||{}).length}*` }, { quoted: msg });
      }
      return;
    }

    // ---- CRAFT ----
    if (body.startsWith("#craft") || body.startsWith("#fabricar")) {
      ensureGameFields(user);
      const parts = body.split(/\s+/).filter(Boolean);
      const receta = parts[1];
      const RECIPES = {
        espada_legendaria: { need: { hierro: 5, gema: 2 }, success: 0.5, poder: 2000, nama: 'Espada Legendaria' },
        armadura_fuerte: { need: { hierro: 4, cuero: 6 }, success: 0.65, poder: 900, nama: 'Armadura Fuerte' }
      };
      if (!receta) {
        await sock.sendMessage(chatId, { text: `🔧 Recetas disponibles: ${Object.keys(RECIPES).join(', ')}\nUsa: #craft [receta]` }, { quoted: msg });
        return;
      }
      const r = RECIPES[receta];
      if (!r) { await sock.sendMessage(chatId, { text: '❌ Receta desconocida.' }, { quoted: msg }); return; }
      // comprobar materiales
      for (const mat in r.need) {
        const have = user.inventario[mat] || 0;
        if (have < r.need[mat]) { await sock.sendMessage(chatId, { text: `❌ Te falta: ${mat} x${r.need[mat]} (tienes ${have})` }, { quoted: msg }); return; }
      }
      // consumir
      for (const mat in r.need) user.inventario[mat] -= r.need[mat];
      // chance
      let chance = r.success;
      if (user.skills && user.skills.includes('forjador')) chance = Math.min(0.95, chance + 0.15);
      const ok = Math.random() < chance;
      if (ok) {
        user.inventario[receta] = (user.inventario[receta] || 0) + 1;
        user.poder += r.poder;
        // recompensas asociadas al craft: EXP y seasonPoints
        const expGainCraft = Math.floor(100 + Math.random() * 200 + (user.nivel || 1) * 10);
        addExp(user, expGainCraft);
      addSeasonPoints(senderId, Math.max(10, Math.floor(r.poder / 100)));
        guardarBD();
        await sock.sendMessage(chatId, { text: `✅ Craft exitoso: *${r.nama}* creado. +${r.poder} poder` }, { quoted: msg });
      } else {
        // pequeña recompensa por intentar y fallar
        addSeasonPoints(senderId, 2);
        guardarBD();
        await sock.sendMessage(chatId, { text: `❌ Fallaste al fabricar *${r.nama}*. Materiales consumidos.` }, { quoted: msg });
      }
      return;
    }

    // ---- TORNEO (inscribirse) ----
    if (body.startsWith("#torneo")) {
      const parts = body.split(/\s+/).filter(Boolean);
      const sub = parts[1] || '';
      if (sub === 'inscribirse' || sub === 'inscribir') {
        if (!tournaments.current || !tournaments.current.active) {
          await sock.sendMessage(chatId, { text: '🔕 No hay torneos abiertos actualmente.' }, { quoted: msg });
          return;
        }
        const t = tournaments.current;
        if (!t.participants) t.participants = [];
        if (t.participants.includes(senderId)) { await sock.sendMessage(chatId, { text: '✅ Ya estás inscrito en el torneo.' }, { quoted: msg }); return; }
        t.participants.push(senderId);
        // dar puntos por inscripción
        addSeasonPoints(senderId, 10);
        guardarBD();
        saveJson('tournaments.json', tournaments);
        await sock.sendMessage(chatId, { text: `🏅 Te inscribiste en el torneo: ${t.name || t.id} — +10 seasonPoints` }, { quoted: msg });
        return;
      }
      // admin: crear torneo
      if (parts[1] === 'start') {
        const isAdmin = senderId === ADMIN_SUPREMO || adminsSupremos[senderId];
        if (!isAdmin) { await sock.sendMessage(chatId, { text: '❌ Solo admins pueden iniciar torneos.' }, { quoted: msg }); return; }
        const name = parts.slice(2).join(' ') || `Torneo ${Date.now()}`;
        tournaments.current = { id: `t_${Date.now()}`, name, active: true, participants: [] };
        saveJson('tournaments.json', tournaments);
        await sock.sendMessage(chatId, { text: `✅ Torneo iniciado: ${name}` }, { quoted: msg });
        return;
      }
      await sock.sendMessage(chatId, { text: '🔸 Uso: #torneo inscribirse — admins: #torneo start [nombre]' }, { quoted: msg });
      return;
    }

    // ---- TRIVIA ----
    if (body.startsWith("#trivia")) {
      const preguntas = [
        { q: '¿Cuál es la capital de Francia?', a: 'paris' },
        { q: '¿Cuánto es 6 * 7?', a: '42' },
        { q: '¿Qué lenguaje usa Node.js?', a: 'javascript' }
      ];
      const sel = preguntas[Math.floor(Math.random()*preguntas.length)];
      trivias[chatId] = { q: sel.q, a: sel.a.toLowerCase(), startedBy: senderId, expiresAt: Date.now() + 60000 };
      saveJson('trivias.json', trivias);
      await sock.sendMessage(chatId, { text: `❓ TRIVIA:\n${sel.q}\n\nResponde con: #respuesta [tu respuesta]\nTienes 60 segundos.` }, { quoted: msg });
      return;
    }
    if (body.startsWith('#respuesta ')) {
      const ans = body.split(' ').slice(1).join(' ').trim().toLowerCase();
      const t = trivias[chatId];
      if (!t) { await sock.sendMessage(chatId, { text: '🔕 No hay trivia activa en este chat.' }, { quoted: msg }); return; }
      if (Date.now() > t.expiresAt) { delete trivias[chatId]; saveJson('trivias.json', trivias); await sock.sendMessage(chatId, { text: '⌛ Tiempo agotado.' }, { quoted: msg }); return; }
      if (ans === t.a) {
        // reward
        user.dinero = (user.dinero || 0) + 1000;
        addExp(user, 150);
        addSeasonPoints(senderId, 25);
        guardarBD();
        delete trivias[chatId]; saveJson('trivias.json', trivias);
        await sock.sendMessage(chatId, { text: `✅ Respuesta correcta! +1000 coins +150 EXP +25 seasonPoints — ${user.nombre || ''}` }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { text: '❌ Respuesta incorrecta.' }, { quoted: msg });
      }
      return;
    }

    // ---- EXPEDICIÓN ----
    if (body.startsWith('#expedicion') || body.startsWith('#expedicio')) {
      ensureGameFields(user);
      const ahora = Date.now();
      const cdKey = 'expedicion';
      const cdMs = 2*60*60*1000;
      if ((user.cooldowns && user.cooldowns[cdKey]) && ahora < user.cooldowns[cdKey]) {
        const left = Math.ceil((user.cooldowns[cdKey]-ahora)/60000);
        await sock.sendMessage(chatId, { text: `⏳ Ya fuiste de expedición. Espera ${left} minutos.` }, { quoted: msg });
        return;
      }
      user.cooldowns[cdKey] = ahora + cdMs;
      const success = Math.random() < 0.85;
      if (success) {
        const gain = Math.floor(200 + Math.random()*800 + (user.nivel||1)*30);
        user.dinero = (user.dinero || 0) + gain;
        addExp(user, Math.floor(100 + Math.random()*200));
        addSeasonPoints(senderId, Math.max(5, Math.floor(gain / 100)));
        guardarBD();
        await sock.sendMessage(chatId, { text: `🧭 Expedición completada! +$${gain} coins +XP +${Math.max(5, Math.floor(gain/100))} seasonPoints.` }, { quoted: msg });
      } else {
        guardarBD();
        await sock.sendMessage(chatId, { text: '❌ Expedición fallida. Volviste sin botín.' }, { quoted: msg });
      }
      return;
    }

    // ---- SKILLTREE ----
    if (body.startsWith('#skilltree')) {
      ensureGameFields(user);
      const parts = body.split(/\s+/).filter(Boolean);
      const cmd = parts[1] || '';
      const SKILLS = { forjador: { cost:1, desc:'Aumenta éxito al craft' }, guerrero: { cost:1, desc:'+10% daño en raids' } };
      if (!cmd) {
        const lista = Object.entries(SKILLS).map(([k,v])=>`${k} - ${v.desc} (cost: ${v.cost})`).join('\n');
        await sock.sendMessage(chatId, { text: `🧭 Skilltree\nPuntos disponibles: ${user.skillPoints}\n${lista}\nUsa: #skilltree unlock [skill]` }, { quoted: msg });
        return;
      }
        if (cmd === 'unlock') {
        const skill = parts[2];
        if (!skill || !SKILLS[skill]) { await sock.sendMessage(chatId, { text: '❌ Skill inválida.' }, { quoted: msg }); return; }
        if (user.skills.includes(skill)) { await sock.sendMessage(chatId, { text: '✅ Ya desbloqueaste esa skill.' }, { quoted: msg }); return; }
        if (user.skillPoints < SKILLS[skill].cost) { await sock.sendMessage(chatId, { text: '❌ No tienes puntos suficientes.' }, { quoted: msg }); return; }
        user.skillPoints -= SKILLS[skill].cost;
        user.skills.push(skill);
        // recompensa por desbloquear: EXP y seasonPoints
        addExp(user, 50);
        addSeasonPoints(senderId, 30);
        guardarBD();
        await sock.sendMessage(chatId, { text: `✅ Skill desbloqueada: ${skill} — +50 EXP +30 seasonPoints` }, { quoted: msg });
        return;
      }
      return;
    }

    // ---- ENIGMAS ----
    if (body.startsWith('#enigmas')) {
      const riddles = [ { q:'Blanca por dentro, verde por fuera. Si quieres que te lo diga, espera.', a:'pera' }, { q:'Vuelo de noche, duermo de día y nunca verás plumas en ala mía.', a:'murcielago' } ];
      const sel = riddles[Math.floor(Math.random()*riddles.length)];
      enigmas[chatId] = { q: sel.q, a: sel.a.toLowerCase(), startedBy: senderId, expiresAt: Date.now()+120000 };
      saveJson('enigmas.json', enigmas);
      await sock.sendMessage(chatId, { text: `🧩 ENIGMA:\n${sel.q}\n\nResponde con: #resolver [respuesta]` }, { quoted: msg });
      return;
    }
    if (body.startsWith('#resolver ')) {
      const ans = body.split(' ').slice(1).join(' ').trim().toLowerCase();
      const e = enigmas[chatId];
      if (!e) { await sock.sendMessage(chatId, { text: '🔕 No hay enigmas activos aquí.' }, { quoted: msg }); return; }
      if (Date.now() > e.expiresAt) { delete enigmas[chatId]; saveJson('enigmas.json', enigmas); await sock.sendMessage(chatId, { text: '⌛ Tiempo agotado.' }, { quoted: msg }); return; }
      if (ans === e.a) {
        user.dinero = (user.dinero || 0) + 2000;
        addExp(user, 200);
        addSeasonPoints(senderId, 40);
        guardarBD(); delete enigmas[chatId]; saveJson('enigmas.json', enigmas);
        await sock.sendMessage(chatId, { text: `✅ Enigma resuelto! +2000 coins +200 EXP +40 seasonPoints — ${user.nombre || ''}` }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { text: '❌ No es correcto.' }, { quoted: msg });
      }
      return;
    }

    // ---- CLAN BOSS ----
    if (body.startsWith('#clanboss')) {
      ensureGameFields(user);
      const parts = body.split(/\s+/).filter(Boolean);
      const sub = parts[1] || '';
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) { await sock.sendMessage(chatId, { text: '❌ No perteneces a un clan.' }, { quoted: msg }); return; }
      const cid = miClan.id;
      if (!clanBosses[cid]) clanBosses[cid] = null;
      if (sub === 'start') {
        const leader = miClan.lider;
        if (leader !== senderId) { await sock.sendMessage(chatId, { text: '❌ Solo el líder puede iniciar un clanboss.' }, { quoted: msg }); return; }
        if (clanBosses[cid] && clanBosses[cid].hp>0) { await sock.sendMessage(chatId, { text: '🔕 Ya hay un clan boss activo.' }, { quoted: msg }); return; }
        clanBosses[cid] = { bossName: parts.slice(2).join(' ') || 'Dragon de Clan', maxHp: 100000, hp: 100000, participants: {}, startedAt: Date.now() };
        saveJson('clanbosses.json', clanBosses);
        await sock.sendMessage(chatId, { text: `🐲 ClanBoss iniciado: ${clanBosses[cid].bossName}` }, { quoted: msg });
        return;
      }
      if (sub === 'attack' || sub === 'atacar') {
        if (!clanBosses[cid] || clanBosses[cid].hp<=0) { await sock.sendMessage(chatId, { text: '🔕 No hay un clan boss activo.' }, { quoted: msg }); return; }
        const cdKey = 'clanboss_attack';
        const ahora = Date.now();
        const cdMs = 30*60*1000;
        if ((user.cooldowns && user.cooldowns[cdKey]) && ahora < user.cooldowns[cdKey]) { const left = Math.ceil((user.cooldowns[cdKey]-ahora)/60000); await sock.sendMessage(chatId, { text: `⏳ Espera ${left} minutos para atacar otra vez.` }, { quoted: msg }); return; }
        let dmg = 15; // daño base
        try {
          const wid = user.equipo && user.equipo.weapon;
          if (wid) {
            const item = getWeaponItem(wid);
            if (item) {
              dmg = Math.floor(15 * getWeaponMultiplierByItem(item));
            }
          }
        } catch (e) {}
        // agregar variación de ±20%
        dmg = Math.floor(dmg * (0.8 + Math.random() * 0.4));
        dmg = Math.max(15, dmg);
        clanBosses[cid].hp = Math.max(0, clanBosses[cid].hp - dmg);
        clanBosses[cid].participants[senderId] = (clanBosses[cid].participants[senderId]||0)+dmg;
        user.cooldowns[cdKey] = ahora + cdMs; guardarBD(); saveJson('clanbosses.json', clanBosses);
        if (clanBosses[cid].hp===0) {
          // rewards to clan members proportionally
          for (const pid of Object.keys(clanBosses[cid].participants||{})) {
            const pusr = usuarios[pid]; if (!pusr) continue;
            const dmg = clanBosses[cid].participants[pid]; const share = Math.max(100, Math.floor(dmg/50)); pusr.dinero = (pusr.dinero||0) + share; addExp(pusr, 200); addSeasonPoints(pid, Math.max(50, Math.floor(dmg/20))); guardarBD();
          }
          const name = clanBosses[cid].bossName; clanBosses[cid] = null; saveJson('clanbosses.json', clanBosses);
          await sock.sendMessage(chatId, { text: `🏆 ¡ClanBoss *${name}* derrotado! Recompensas entregadas al clan.` }, { quoted: msg });
        } else {
          await sock.sendMessage(chatId, { text: `⚔️ Atacaste y causaste *${dmg}* daño. HP restante: ${clanBosses[cid].hp}` }, { quoted: msg });
        }
        return;
      }
      // status
      if (!clanBosses[cid] || clanBosses[cid].hp<=0) await sock.sendMessage(chatId, { text: '🔕 No hay clan boss activo. Líder puede iniciar: #clanboss start [nombre]' }, { quoted: msg }); else await sock.sendMessage(chatId, { text: `🐲 ClanBoss: *${clanBosses[cid].bossName}* HP: ${clanBosses[cid].hp}/${clanBosses[cid].maxHp}` }, { quoted: msg });
      return;
    }

    if (body.startsWith("#crearclan ")) {
      const nombreClan = body.split(" ").slice(1).join(" ").trim();
      if (!nombreClan || nombreClan.length < 3) {
        await sock.sendMessage(chatId, { text: `❌ El nombre del clan debe tener al menos 3 caracteres` }, { quoted: msg });
        return;
      }
      if (nombreClan.length > 20) {
        await sock.sendMessage(chatId, { text: `❌ El nombre del clan no puede tener más de 20 caracteres` }, { quoted: msg });
        return;
      }
      const clanExistente = obtenerClanDeUsuario(senderId);
      if (clanExistente) {
        await sock.sendMessage(chatId, { text: `❌ Ya perteneces al clan *${clanExistente.nombre}*\n\n💡 Usa *#salirclan* para salir primero` }, { quoted: msg });
        return;
      }
      const clanMismoNombre = Object.values(clanes).find(c => (c.nombre||'').toLowerCase() === (nombreClan||'').toLowerCase());
      if (clanMismoNombre) {
        await sock.sendMessage(chatId, { text: `❌ Ya existe un clan con ese nombre` }, { quoted: msg });
        return;
      }
      const costoCreacion = 50000;
      if ((user.dinero || 0) < costoCreacion) {
        await sock.sendMessage(chatId, { 
          text: `❌ Necesitas *$${costoCreacion.toLocaleString()}* para crear un clan\n\n💰 Tienes: *$${(user.dinero||0).toLocaleString()}*`
        }, { quoted: msg });
        return;
      }
      // Crear una petición pendiente para que el usuario envíe la foto del clan en 5 minutos
      const expires = Date.now() + 5*60*1000; // 5 minutos
      pendingClans[senderId] = { nombre: nombreClan, costo: costoCreacion, requestedAt: Date.now(), expiresAt: expires, maxMiembros: 10 };
      savePendingClans();
      await sock.sendMessage(chatId, { text: `📸 Para completar la creación del clan *${nombreClan}*, por favor envía la foto/logo del clan en los próximos 5 minutos. Si no envías la imagen, la solicitud expirará.` }, { quoted: msg });
      return;
    }
    // cancelar solicitud pendiente de crear clan y logo
    if (body === '#crearclan cancelar' || body === '#crearclan_cancelar' || body.startsWith('#crearclan cancelar')) {
      if (pendingClans[senderId]) {
        delete pendingClans[senderId]; savePendingClans();
        await sock.sendMessage(chatId, { text: '✅ Solicitud de creación de clan cancelada.' }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { text: 'ℹ️ No tienes ninguna solicitud de clan pendiente.' }, { quoted: msg });
      }
      return;
    }

    if (body === "#miclan" || body === "#clan") {
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) {
        await sock.sendMessage(chatId, { 
          text: `❌ No perteneces a ningún clan\n\n💡 Usa *#crearclan [nombre]* para crear uno\n💡 O *#unirclan [nombre]* para unirte a uno`
        }, { quoted: msg });
        return;
      }
      const liderInfo = usuarios[miClan.lider];
      const poderTotal = calcularPoderClan(miClan.id);
      const totalMiembros = 1 + (Array.isArray(miClan.miembros) ? miClan.miembros.length : 0);
      let clanTexto = `🏰 *${miClan.nombre}* 🏰\n\n`;
      clanTexto += `👑 Líder: *${liderInfo?.nombre || 'Desconocido'}*\n`;
      clanTexto += `👥 Miembros: *${totalMiembros}/${miClan.maxMiembros}*\n`;
      clanTexto += `⚡ Poder total: *${poderTotal.toLocaleString()}*\n`;
      clanTexto += `💰 Banco: *$${miClan.banco.toLocaleString()}/${miClan.capacidadBanco.toLocaleString()}*\n`;
      clanTexto += `🛡️ Defensa extra: *+${miClan.defensaExtra || 0}*\n`;
      clanTexto += `⚔️ Poder extra: *+${miClan.poderExtra || 0}*\n`;
      if (miClan.descripcion) clanTexto += `📝 ${miClan.descripcion}\n`;
      clanTexto += `\n👥 *MIEMBROS:*\n`;
      clanTexto += `👑 ${liderInfo?.nombre || 'Líder'} (Líder)\n`;
      for (const miembroId of miClan.miembros) {
        const miembroInfo = usuarios[miembroId];
        clanTexto += `◉ ${miembroInfo?.nombre || 'Miembro'}\n`;
      }
      await sock.sendMessage(chatId, { text: clanTexto }, { quoted: msg });
    }

    if (body.startsWith("#invitar ")) {
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) {
        await sock.sendMessage(chatId, { text: `❌ No perteneces a ningún clan` }, { quoted: msg });
        return;
      }
      if (miClan.lider !== senderId) {
        await sock.sendMessage(chatId, { text: `❌ Solo el líder puede invitar miembros` }, { quoted: msg });
        return;
      }
      let mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (mentionedJid && isBotJid(mentionedJid)) mentionedJid = undefined;
      if (!mentionedJid) {
        await sock.sendMessage(chatId, { text: `❌ Debes mencionar al usuario a invitar\n\n💡 Uso: *#invitar @usuario*` }, { quoted: msg });
        return;
      }
      if (!usuarios[mentionedJid]) {
        await sock.sendMessage(chatId, { text: `❌ Ese usuario no existe en el sistema` }, { quoted: msg });
        return;
      }
      const clanDelInvitado = obtenerClanDeUsuario(mentionedJid);
      if (clanDelInvitado) {
        await sock.sendMessage(chatId, { text: `❌ Ese usuario ya pertenece a un clan` }, { quoted: msg });
        return;
      }
      const totalMiembros = 1 + miClan.miembros.length;
      if (totalMiembros >= miClan.maxMiembros) {
        await sock.sendMessage(chatId, { text: `❌ Tu clan está lleno (${totalMiembros}/${miClan.maxMiembros})` }, { quoted: msg });
        return;
      }
      if (!clanes[miClan.id].invitaciones || !Array.isArray(clanes[miClan.id].invitaciones)) clanes[miClan.id].invitaciones = [];
      if (!clanes[miClan.id].invitaciones.includes(mentionedJid)) {
        clanes[miClan.id].invitaciones.push(mentionedJid);
      }
      guardarClanes();
      await sock.sendMessage(chatId, { 
        text: `✅ Invitación enviada\n\n👤 @${mentionedJid.split('@')[0]} ha sido invitado a *${miClan.nombre}*\n\n💡 Debe usar *#unirclan ${miClan.nombre}* para aceptar`,
        mentions: [mentionedJid]
      }, { quoted: msg });
    }

    if (body.startsWith("#unirclan ")) {
      const nombreClan = body.split(" ").slice(1).join(" ").trim();
      const clanExistente = obtenerClanDeUsuario(senderId);
      if (clanExistente) {
        await sock.sendMessage(chatId, { text: `❌ Ya perteneces al clan *${clanExistente.nombre}*` }, { quoted: msg });
        return;
      }
      const clanBuscado = Object.entries(clanes).find(([id, c]) => (c.nombre||'').toLowerCase() === (nombreClan||'').toLowerCase());
      if (!clanBuscado) {
        await sock.sendMessage(chatId, { text: `❌ No se encontró el clan *${nombreClan}*` }, { quoted: msg });
        return;
      }
      const [clanId, clan] = clanBuscado;
      if (!clan.invitaciones || !clan.invitaciones.includes(senderId)) {
        await sock.sendMessage(chatId, { text: `❌ No tienes invitación para unirte a *${clan.nombre}*\n\n💡 Pide al líder que te invite con *#invitar @tu_usuario*` }, { quoted: msg });
        return;
      }
      const totalMiembros = 1 + clan.miembros.length;
      if (totalMiembros >= clan.maxMiembros) {
        await sock.sendMessage(chatId, { text: `❌ El clan está lleno (${totalMiembros}/${clan.maxMiembros})` }, { quoted: msg });
        return;
      }
      clan.miembros.push(senderId);
      clan.invitaciones = clan.invitaciones.filter(id => id !== senderId);
      user.clanId = clanId;
      guardarBD();
      guardarClanes();
      await sock.sendMessage(chatId, { 
        text: `✅ ¡Te uniste al clan *${clan.nombre}*!\n\n👥 Miembros: ${clan.miembros.length + 1}/${clan.maxMiembros}`
      }, { quoted: msg });
    }

    if (body === "#salirclan") {
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) {
        await sock.sendMessage(chatId, { text: `❌ No perteneces a ningún clan` }, { quoted: msg });
        return;
      }
      if (miClan.lider === senderId) {
        await sock.sendMessage(chatId, { text: `❌ Eres el líder, no puedes salir\n\n💡 Usa *#disolverclan* para eliminar el clan` }, { quoted: msg });
        return;
      }
      clanes[miClan.id].miembros = clanes[miClan.id].miembros.filter(id => id !== senderId);
      user.clanId = null;
      guardarBD();
      guardarClanes();
      await sock.sendMessage(chatId, { text: `✅ Has salido del clan *${miClan.nombre}*` }, { quoted: msg });
    }

    if (body.startsWith("#expulsar ")) {
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) {
        await sock.sendMessage(chatId, { text: `❌ No perteneces a ningún clan` }, { quoted: msg });
        return;
      }
      if (miClan.lider !== senderId) {
        await sock.sendMessage(chatId, { text: `❌ Solo el líder puede expulsar miembros` }, { quoted: msg });
        return;
      }
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!mentionedJid) {
        await sock.sendMessage(chatId, { text: `❌ Debes mencionar al usuario a expulsar` }, { quoted: msg });
        return;
      }
      if (!Array.isArray(clanes[miClan.id].miembros) || !clanes[miClan.id].miembros.includes(mentionedJid)) {
        await sock.sendMessage(chatId, { text: `❌ Ese usuario no es miembro de tu clan` }, { quoted: msg });
        return;
      }
      clanes[miClan.id].miembros = clanes[miClan.id].miembros.filter(id => id !== mentionedJid);
      if (usuarios[mentionedJid]) usuarios[mentionedJid].clanId = null;
      guardarBD();
      guardarClanes();
      await sock.sendMessage(chatId, { 
        text: `✅ @${mentionedJid.split('@')[0]} ha sido expulsado del clan`,
        mentions: [mentionedJid]
      }, { quoted: msg });
      try { addHistorialNegro(mentionedJid, 'Expulsado de clan', `Expulsado por ${senderId.split('@')[0]}`); } catch (e) {}
    }

    if (body.startsWith("#donar ")) {
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) {
        await sock.sendMessage(chatId, { text: `❌ No perteneces a ningún clan` }, { quoted: msg });
        return;
      }
      const cantidad = parseInt(body.split(" ")[1]);
      if (isNaN(cantidad) || cantidad <= 0) {
        await sock.sendMessage(chatId, { text: `❌ Cantidad inválida` }, { quoted: msg });
        return;
      }
      if (user.dinero < cantidad) {
        await sock.sendMessage(chatId, { text: `❌ No tienes suficiente dinero\n\n💰 Tienes: *$${user.dinero.toLocaleString()}*` }, { quoted: msg });
        return;
      }
      const espacioDisponible = clanes[miClan.id].capacidadBanco - clanes[miClan.id].banco;
      if (cantidad > espacioDisponible) {
        await sock.sendMessage(chatId, { text: `❌ El banco del clan solo tiene espacio para *$${espacioDisponible.toLocaleString()}* más` }, { quoted: msg });
        return;
      }
      user.dinero -= cantidad;
      clanes[miClan.id].banco += cantidad;
      guardarBD();
      guardarClanes();
      await sock.sendMessage(chatId, { 
        text: `✅ ¡Donación exitosa!\n\n💰 Donaste: *$${cantidad.toLocaleString()}*\n🏦 Banco del clan: *$${clanes[miClan.id].banco.toLocaleString()}/${clanes[miClan.id].capacidadBanco.toLocaleString()}*`
      }, { quoted: msg });
    }

    if (body === "#rankclanes" || body === "#topclanes") {
      const ranking = obtenerRankingClanes();
      if (ranking.length === 0) {
        await sock.sendMessage(chatId, { text: `❌ No hay clanes registrados` }, { quoted: msg });
        return;
      }
      const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      let rankTexto = `🏰 RANKING DE CLANES\n\n`;
      ranking.slice(0, 10).forEach((clan, index) => {
        const liderInfo = usuarios[clan.lider];
        rankTexto += `${romanos[index]}. ${clan.nombre} — ⚡ ${clan.poderTotal.toLocaleString()} | 👥 ${1 + clan.miembros.length}/${clan.maxMiembros} | 👑 ${liderInfo?.nombre || 'Desconocido'}\n`;
      });
      await sock.sendMessage(chatId, { text: rankTexto }, { quoted: msg });
    }

    if (body.startsWith("#claninfo ")) {
      const nombreClan = body.split(" ").slice(1).join(" ").trim();
      const clanBuscado = Object.entries(clanes).find(([id, c]) => (c.nombre||'').toLowerCase() === (nombreClan||'').toLowerCase());
      if (!clanBuscado) {
        await sock.sendMessage(chatId, { text: `❌ No se encontró el clan *${nombreClan}*` }, { quoted: msg });
        return;
      }
      const [clanId, clan] = clanBuscado;
      const liderInfo = usuarios[clan.lider];
      const poderTotal = calcularPoderClan(clanId);
      let clanTexto = `🏰 *${clan.nombre}* 🏰\n\n`;
      clanTexto += `👑 Líder: *${liderInfo?.nombre || 'Desconocido'}*\n`;
      clanTexto += `👥 Miembros: *${1 + clan.miembros.length}/${clan.maxMiembros}*\n`;
      clanTexto += `⚡ Poder total: *${poderTotal.toLocaleString()}*\n`;
      clanTexto += `💰 Banco: *$${clan.banco.toLocaleString()}*\n`;
      if (clan.descripcion) clanTexto += `📝 ${clan.descripcion}\n`;
      await sock.sendMessage(chatId, { text: clanTexto }, { quoted: msg });
    }

    if (body === "#disolverclan") {
      const miClan = obtenerClanDeUsuario(senderId);
      if (!miClan) {
        await sock.sendMessage(chatId, { text: `❌ No perteneces a ningún clan` }, { quoted: msg });
        return;
      }
      if (miClan.lider !== senderId) {
        await sock.sendMessage(chatId, { text: `❌ Solo el líder puede disolver el clan` }, { quoted: msg });
        return;
      }
      for (const miembroId of miClan.miembros) {
        if (usuarios[miembroId]) usuarios[miembroId].clanId = null;
      }
      user.clanId = null;
      if (miClan.banco > 0) {
        user.dinero += miClan.banco;
      }
      delete clanes[miClan.id];
      guardarBD();
      guardarClanes();
      await sock.sendMessage(chatId, { 
        text: `✅ El clan *${miClan.nombre}* ha sido disuelto${miClan.banco > 0 ? `\n💰 Recuperaste *$${miClan.banco.toLocaleString()}* del banco del clan` : ''}`
      }, { quoted: msg });
    }

    if (body === "#perfil" || body === "#profile" || body === "#p") {
      const ext = msg.message?.extendedTextMessage?.contextInfo;
      const mentionedJid = ext?.mentionedJid?.[0];
      const quotedParticipant = ext?.participant || (ext?.quotedMessage?.contextInfo?.participant) || null;
      const targetId = mentionedJid || quotedParticipant || senderId;
      const found = findUsuarioByAnyId(targetId);
      let targetUser = null;
      let keyForClan = targetId;
      if (found) {
        targetUser = found.user;
        keyForClan = found.key;
      } else {
        targetUser = usuarios[targetId] || { nombre: targetId.split('@')[0], nivel: 1, poder: 0, defensa: 0, vida: 100, dinero: 0, banco: 0, descripcion: null, genero: null, cumpleanos: null };
      }
      
      let tituloStr = '';
      if (targetUser && targetUser.tituloActivo) {
        const t = getTituloById(targetUser.tituloActivo);
        if (t) tituloStr = ` | ${t.icono} ${t.nombre}`;
      }
      
      const { rango, clasificacion } = obtenerRangoClasificacion(Number(targetUser.poder) || 0);
      const miClan = obtenerClanDeUsuario(keyForClan);
      
      // Crear barra de vida visual
      const vidaActual = targetUser.vida || 100;
      const vidaMax = 100;
      const barraLength = 12;
      const barraLlena = Math.floor((vidaActual / vidaMax) * barraLength);
      const barraVacia = barraLength - barraLlena;
      const barraVida = '█'.repeat(barraLlena) + '░'.repeat(barraVacia);
      
      // Obtener estadísticas de duelos
      const duelWins = (targetUser.stats && targetUser.stats.duelWins) || 0;
      const duelLoses = (targetUser.stats && targetUser.stats.duelLoses) || 0;
      const duelTotal = duelWins + duelLoses;
      const duelRatio = duelTotal > 0 ? ((duelWins / duelTotal) * 100).toFixed(1) : 0;
      const duelMoney = (targetUser.stats && targetUser.stats.duelMoney) || 0;
      
      // Puntos de temporada
      let seasonPts = 0;
      if (currentSeason && seasons[currentSeason] && seasons[currentSeason].standings) {
        seasonPts = seasons[currentSeason].standings[targetId] || 0;
      }
      if ((!seasonPts || seasonPts === 0) && targetUser.seasonPoints) seasonPts = targetUser.seasonPoints;
      const seasonRankName = currentSeason ? getSeasonRank(seasonPts).name : 'Sin temporada';
      
      // Profesión actual
      const profesion = targetUser.profesion || 'No asignada';
      
      // Construir perfil
      let perfil = `★ *PERFIL SUPREMO*\n`;
      if (targetUser.descripcion) perfil += `${targetUser.descripcion}\n`;
      perfil += `\n◆ *Nombre:* ${targetUser.nombre}${tituloStr}\n`;
      if (targetUser.rayo_divino) perfil += `▲ *Distintivo:* ✦ Rayo Divino\n`;
      if (targetUser.rango_divino) perfil += `▲ *Distintivo:* ✦ ${targetUser.rango_divino}\n`;
      
      perfil += `\n━ *ESTADÍSTICAS*\n`;
      perfil += `▸ *Nivel:* ${targetUser.nivel}\n`;
      perfil += `▹ *EXP:* ${(targetUser.exp || 0).toLocaleString()}/${(Math.pow(targetUser.nivel + 1, 2) * 1000).toLocaleString()}\n`;
      perfil += `◈ *Poder:* ${(targetUser.poder || 0).toLocaleString()} ⚡\n`;
      perfil += `◊ *Defensa:* ${(targetUser.defensa || 0).toLocaleString()}\n`;
      perfil += `◉ *Vida:* ${vidaActual}/100 [${barraVida}]\n`;
      perfil += `◇ *Clase:* ${rango} [${clasificacion}]\n`;
      perfil += `★ *Rango:* ${rango}\n`;
      perfil += `✧ *Temporada:* #${seasonPts} • ${seasonRankName}\n`;
      
      perfil += `\n━ *ECONOMÍA*\n`;
      perfil += `● *Dinero:* $${(targetUser.dinero || 0).toLocaleString()}\n`;
      perfil += `○ *Banco:* $${(targetUser.banco || 0).toLocaleString()}\n`;
      perfil += `▲ *Profesión:* ${profesion}\n`;
      
      if (miClan) {
        perfil += `\n━ *CLAN*\n`;
        perfil += `◎ *Clan:* ${miClan.nombre}\n`;
        perfil += `◌ *Rol:* ${miClan.lider === targetId ? 'Líder' : 'Miembro'}\n`;
        perfil += `◕ *Miembros:* ${miClan.miembros ? miClan.miembros.length : 0}/${miClan.maxMiembros || 50}\n`;
      }
      
      if (duelTotal > 0) {
        perfil += `\n━ *COMBATE*\n`;
        perfil += `▬ *Duelos ganados:* ${duelWins}\n`;
        perfil += `■ *Duelos perdidos:* ${duelLoses}\n`;
        perfil += `► *Ratio:* ${duelRatio}%\n`;
        perfil += `◈ *Dinero en duelos:* $${duelMoney.toLocaleString()}\n`;
      }
      
      // Logros
      if (targetUser.logros && targetUser.logros.length > 0) {
        let logroSymbols = [];
        for (const r of targetUser.logros) {
          let symbol = '✦';
          if (r === 'ultra_mitico') symbol = '▲';
          else if (r === 'ancestral') symbol = '◇';
          else if (r === 'divino') symbol = '✦';
          else if (r === 'eterno') symbol = '◎';
          else if (r === 'primordial') symbol = '★';
          else if (r === 'prohibido') symbol = '■';
          else if (r === 'absoluto') symbol = '●';
          logroSymbols.push(`${symbol} ${r.toUpperCase()}`);
        }
        perfil += `\n━ *LOGROS:* ${logroSymbols.join(' | ')}\n`;
      }
      
      try {
        const profilePic = await sock.profilePictureUrl(targetId, 'image');
        await sock.sendMessage(chatId, { image: { url: profilePic }, caption: perfil, mentions: mentionedJid ? [targetId] : [] }, { quoted: msg });
      } catch (error) {
        await sock.sendMessage(chatId, { text: perfil, mentions: mentionedJid ? [targetId] : [] }, { quoted: msg });
      }
    }

    if (body === "#info") {
      try {
        const esGrupo = chatId && chatId.endsWith('@g.us');
        let miembros = 0;
        let grupoNombre = null;
        let creador = 'Desconocido';
        if (esGrupo) {
          try {
            const metadata = await sock.groupMetadata(chatId);
            miembros = metadata.participants ? metadata.participants.length : 0;
            grupoNombre = metadata.subject || null;
            creador = metadata.owner || metadata.creator || 'Desconocido';
          } catch (e) {
            miembros = 0;
          }
        } else {
          miembros = 2;
        }

        const stats = chatStats[chatId] || { totalMessages: 0, firstSeen: Date.now() };
        const totalMessages = stats.totalMessages || 0;
        const dias = Math.max(1, Math.round((Date.now() - (stats.firstSeen || Date.now())) / (1000 * 60 * 60 * 24)));
        const promedio = Math.round(totalMessages / dias);

        // Detectar hora local del invocador por código de país en el número
        const numero = senderId.split('@')[0];
        
        let timeZone = 'UTC';
        let paisLabel = 'UTC';
        
        // Detección específica por prefijo (orden importa: más específicos primero)
        if (numero.startsWith('54')) {
          timeZone = 'America/Argentina/Buenos_Aires';
          paisLabel = 'Argentina';
        } else if (numero.startsWith('55')) {
          timeZone = 'America/Sao_Paulo';
          paisLabel = 'Brasil';
        } else if (numero.startsWith('56')) {
          timeZone = 'America/Santiago';
          paisLabel = 'Chile';
        } else if (numero.startsWith('57')) {
          timeZone = 'America/Bogota';
          paisLabel = 'Colombia';
        } else if (numero.startsWith('58')) {
          timeZone = 'America/Caracas';
          paisLabel = 'Venezuela';
        } else if (numero.startsWith('51')) {
          timeZone = 'America/Lima';
          paisLabel = 'Perú';
        } else if (numero.startsWith('591')) {
          timeZone = 'America/La_Paz';
          paisLabel = 'Bolivia';
        } else if (numero.startsWith('598')) {
          timeZone = 'America/Montevideo';
          paisLabel = 'Uruguay';
        } else if (numero.startsWith('595')) {
          timeZone = 'America/Asuncion';
          paisLabel = 'Paraguay';
        } else if (numero.startsWith('593')) {
          timeZone = 'America/Guayaquil';
          paisLabel = 'Ecuador';
        } else if (numero.startsWith('34')) {
          timeZone = 'Europe/Madrid';
          paisLabel = 'España';
        } else if (numero.startsWith('44')) {
          timeZone = 'Europe/London';
          paisLabel = 'UK';
        } else if (numero.startsWith('39')) {
          timeZone = 'Europe/Rome';
          paisLabel = 'Italia';
        } else if (numero.startsWith('33')) {
          timeZone = 'Europe/Paris';
          paisLabel = 'Francia';
        } else if (numero.startsWith('49')) {
          timeZone = 'Europe/Berlin';
          paisLabel = 'Alemania';
        } else if (numero.startsWith('36')) {
          timeZone = 'Europe/Budapest';
          paisLabel = 'Hungría';
        } else if (numero.startsWith('48')) {
          timeZone = 'Europe/Warsaw';
          paisLabel = 'Polonia';
        } else if (numero.startsWith('40')) {
          timeZone = 'Europe/Bucharest';
          paisLabel = 'Rumania';
        } else if (numero.startsWith('30')) {
          timeZone = 'Europe/Athens';
          paisLabel = 'Grecia';
        } else if (numero.startsWith('31')) {
          timeZone = 'Europe/Amsterdam';
          paisLabel = 'Países Bajos';
        } else if (numero.startsWith('32')) {
          timeZone = 'Europe/Brussels';
          paisLabel = 'Bélgica';
        } else if (numero.startsWith('43')) {
          timeZone = 'Europe/Vienna';
          paisLabel = 'Austria';
        } else if (numero.startsWith('41')) {
          timeZone = 'Europe/Zurich';
          paisLabel = 'Suiza';
        } else if (numero.startsWith('47')) {
          timeZone = 'Europe/Oslo';
          paisLabel = 'Noruega';
        } else if (numero.startsWith('46')) {
          timeZone = 'Europe/Stockholm';
          paisLabel = 'Suecia';
        } else if (numero.startsWith('45')) {
          timeZone = 'Europe/Copenhagen';
          paisLabel = 'Dinamarca';
        } else if (numero.startsWith('90')) {
          timeZone = 'Europe/Istanbul';
          paisLabel = 'Turquía';
        } else if (numero.startsWith('91')) {
          timeZone = 'Asia/Kolkata';
          paisLabel = 'India';
        } else if (numero.startsWith('92')) {
          timeZone = 'Asia/Karachi';
          paisLabel = 'Pakistán';
        } else if (numero.startsWith('94')) {
          timeZone = 'Asia/Colombo';
          paisLabel = 'Sri Lanka';
        } else if (numero.startsWith('86')) {
          timeZone = 'Asia/Shanghai';
          paisLabel = 'China';
        } else if (numero.startsWith('81')) {
          timeZone = 'Asia/Tokyo';
          paisLabel = 'Japón';
        } else if (numero.startsWith('82')) {
          timeZone = 'Asia/Seoul';
          paisLabel = 'Corea del Sur';
        } else if (numero.startsWith('65')) {
          timeZone = 'Asia/Singapore';
          paisLabel = 'Singapur';
        } else if (numero.startsWith('60')) {
          timeZone = 'Asia/Kuala_Lumpur';
          paisLabel = 'Malasia';
        } else if (numero.startsWith('62')) {
          timeZone = 'Asia/Jakarta';
          paisLabel = 'Indonesia';
        } else if (numero.startsWith('63')) {
          timeZone = 'Asia/Manila';
          paisLabel = 'Filipinas';
        } else if (numero.startsWith('66')) {
          timeZone = 'Asia/Bangkok';
          paisLabel = 'Tailandia';
        } else if (numero.startsWith('84')) {
          timeZone = 'Asia/Ho_Chi_Minh';
          paisLabel = 'Vietnam';
        } else if (numero.startsWith('95')) {
          timeZone = 'Asia/Yangon';
          paisLabel = 'Myanmar';
        } else if (numero.startsWith('61')) {
          timeZone = 'Australia/Sydney';
          paisLabel = 'Australia';
        } else if (numero.startsWith('64')) {
          timeZone = 'Pacific/Auckland';
          paisLabel = 'Nueva Zelanda';
        }
        

        let horaLocal = null;
        try {
          horaLocal = new Intl.DateTimeFormat('es-ES', { 
            timeZone, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit', 
            hour12: false 
          }).format(new Date());
        } catch (e) {
          horaLocal = new Date().toUTCString();
        }

        const creadorBot = '⚙️ Hecho por: L';
        const userLang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        // Info ampliada: usuarios registrados, estado de temporada, web, uptime
        const totalUsuarios = Object.keys(usuarios).length;
        const uptimeMs = process.uptime() * 1000;
        const uptime = `${Math.floor(uptimeMs/3600000)}h ${Math.floor((uptimeMs%3600000)/60000)}m`;
        const webActive = !!process.env.START_WEB;
        const seasonStatus = currentSeason ? `${currentSeason} (termina: ${new Date(seasons[currentSeason].ends).toLocaleString()})` : '— No hay temporada activa —';
        let infoTexto = `◆ ------------------- ◆\n       ${t('info_title', userLang)}\n◆ ------------------- ◆\n\n`;
        if (esGrupo) infoTexto += `◉ ${t('info_group', userLang)}: *${grupoNombre || chatId}*\n`;
        infoTexto += `◉ ${t('info_members', userLang)}: *${miembros}*\n`;
        infoTexto += `◉ ${t('info_total_msgs', userLang)}: *${totalMessages}*\n`;
        infoTexto += `◉ ${t('info_msgs_day', userLang)}: *${promedio}*\n`;
        infoTexto += `◉ Usuarios registrados: *${totalUsuarios}*\n`;
        infoTexto += `◉ ${t('info_bot_creator', userLang)}: *${creadorBot}*\n`;
        infoTexto += `◉ ${t('info_local_time', userLang)} (${paisLabel}): *${horaLocal}*\n`;
        infoTexto += `◉ Estado temporada: *${seasonStatus}*\n`;
        infoTexto += `◉ Web activa: *${webActive ? 'Sí' : 'No'}*\n`;
        infoTexto += `◉ Uptime: *${uptime}*\n`;
        if (esGrupo) infoTexto += `◉ ${t('info_group_owner', userLang)}: *${creador}*\n`;
        infoTexto += `\n◆ ------------------- ◆`;

        await sock.sendMessage(chatId, { text: infoTexto }, { quoted: msg });
      } catch (e) {
        await sock.sendMessage(chatId, { text: 'Error obteniendo info del chat.' }, { quoted: msg });
      }
    }

    if (body.startsWith("#mute")) {
      // Sólo en grupos
      if (!chatId.endsWith('@g.us')) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('not_group', lang) }, { quoted: msg });
        return;
      }

      // Verificar admin del grupo
      let metadata = null;
      try { metadata = await sock.groupMetadata(chatId); } catch (e) { metadata = null; }
      let isAdmin = false;
      if (metadata && metadata.participants) {
        const p = metadata.participants.find(x => x.id === senderId);
        if (p) isAdmin = p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true || p.admin === 'superadmin';
      }
      if (!isAdmin) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('only_admin', lang) }, { quoted: msg });
        return;
      }

      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const args = body.split(/\s+/).filter(Boolean);
      let targetId = mentionedJid || (args[1] ? (args[1].replace('@','') + '@s.whatsapp.net') : null);
      if (!targetId) {
        await sock.sendMessage(chatId, { text: '❌ Debes mencionar al usuario o poner su número. Uso: #mute @usuario 10m|2h|1d' }, { quoted: msg });
        return;
      }

      // Determinar duración
      let durToken = args[2] || args[1];
      if (mentionedJid) durToken = args[2];
      let ms = 0;
      if (durToken) {
        const m = durToken.match(/^(\d+)(s|m|h|d)$/i);
        if (m) {
          const val = parseInt(m[1]);
          const unit = m[2].toLowerCase();
          if (unit === 's') ms = val * 1000;
          else if (unit === 'm') ms = val * 60000;
          else if (unit === 'h') ms = val * 3600000;
          else if (unit === 'd') ms = val * 86400000;
        } else {
          // soporte "10 minutos" o "2 horas" en español
          const nextParts = args.slice(2);
          if (nextParts.length >= 2 && /^\d+$/.test(nextParts[0])) {
            const val = parseInt(nextParts[0]);
            const unidad = nextParts[1].toLowerCase();
            if (unidad.startsWith('min')) ms = val * 60000;
            else if (unidad.startsWith('hor') || unidad.startsWith('hr')) ms = val * 3600000;
            else if (unidad.startsWith('dia')) ms = val * 86400000;
          }
        }
      }
      if (!ms || ms <= 0) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('mute_invalid_duration', lang) }, { quoted: msg });
        return;
      }

      if (!mutes[chatId]) mutes[chatId] = {};
      mutes[chatId][targetId] = { until: Date.now() + ms, by: senderId };
      saveMutes();

      const nick = (usuarios[targetId] && usuarios[targetId].nombre) ? usuarios[targetId].nombre : targetId.split('@')[0];
      const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
      const duracionFormato = durToken || (Math.round(ms/60000) + 'm');
      const adminNick = (usuarios[senderId] && usuarios[senderId].nombre) ? usuarios[senderId].nombre : senderId.split('@')[0];
      
      const mensajeMute = `*━━━━━━━━━━━━━━━━━━━━━━━*\n🔇 *USUARIO SILENCIADO* 🔇\n*━━━━━━━━━━━━━━━━━━━━━━━*\n\n👤 *Usuario:* @${nick}\n⏱️ *Duración:* *${duracionFormato}*\n👮 *Silenciado por:* ${adminNick}\n\n*━━━━ RESTRICCIÓN ACTIVA ━━━━*\n\n❌ *Tus mensajes serán eliminados*\n⚠️ *Límite: 20 mensajes*\n🚫 *Al llegar a 20: serás expulsado*\n\n*━━━━━━━━━━━━━━━━━━━━━━━*`;
      
      await sock.sendMessage(chatId, { text: mensajeMute, mentions: [targetId] }, { quoted: msg });
      try { addHistorialNegro(targetId, `Silenciado ${duracionFormato}`, `Silenciado por ${adminNick}`); } catch (e) {}
      return;
    }

    if (body.startsWith("#unmute")) {
      if (!chatId.endsWith('@g.us')) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('not_group', lang) }, { quoted: msg });
        return;
      }
      let metadata = null;
      try { metadata = await sock.groupMetadata(chatId); } catch (e) { metadata = null; }
      let isAdmin = false;
      if (metadata && metadata.participants) {
        const p = metadata.participants.find(x => x.id === senderId);
        if (p) isAdmin = p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true || p.admin === 'superadmin';
      }
      if (!isAdmin) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('only_admin', lang) }, { quoted: msg });
        return;
      }
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const args = body.split(/\s+/).filter(Boolean);
      let targetId = mentionedJid || (args[1] ? (args[1].replace('@','') + '@s.whatsapp.net') : null);
      if (!targetId) {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('setlang_invalid', lang) }, { quoted: msg });
        return;
      }
      if (mutes[chatId] && mutes[chatId][targetId]) {
        delete mutes[chatId][targetId];
        saveMutes();
        const nick = (usuarios[targetId] && usuarios[targetId].nombre) ? usuarios[targetId].nombre : targetId.split('@')[0];
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('unmute_success', lang, { user: nick }), mentions: [targetId] }, { quoted: msg });
      } else {
        const lang = (usuarios[senderId] && usuarios[senderId].lang) ? usuarios[senderId].lang : 'es';
        await sock.sendMessage(chatId, { text: t('mute_invalid_duration', lang) }, { quoted: msg });
      }
      return;
    }

    if (body.startsWith("#kick")) {
      // Solo en grupos
      if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: "❌ Este comando solo funciona en grupos." }, { quoted: msg });
        return;
      }

      const ext = msg.message?.extendedTextMessage?.contextInfo;
      let targetId = null;
      
      // Intenta obtener por mention (@usuario)
      if (ext?.mentionedJid?.[0]) {
        targetId = ext.mentionedJid[0];
      }
      
      // Si no hay mention, intenta por respuesta a mensaje (quoted)
      if (!targetId && ext?.participant) {
        targetId = ext.participant;
      }
      
      // Si tampoco hay, busca en argumentos
      if (!targetId) {
        const args = body.split(/\s+/).filter(Boolean);
        if (args[1]) {
          const num = args[1].replace(/[^0-9]/g, '');
          if (num) {
            targetId = num + '@s.whatsapp.net';
          }
        }
      }

      if (!targetId) {
        await sock.sendMessage(chatId, { text: "❌ *Uso incorrecto*\n\n*Sintaxis:*\n• #kick @usuario\n• Responde a un mensaje y escribe: #kick\n\n*Ejemplo:* #kick @usuario" }, { quoted: msg });
        return;
      }

      // Prevenir kick a si mismo
      if (targetId === senderId) {
        await sock.sendMessage(chatId, { text: "❌ No puedes expulsarte a ti mismo del grupo!" }, { quoted: msg });
        return;
      }

      // Prevenir kick al bot
      const botJid = sock.user?.id || sock.user?.jid;
      if (targetId === botJid) {
        await sock.sendMessage(chatId, { text: "❌ No puedo expulsarme a mi mismo del grupo." }, { quoted: msg });
        return;
      }

      // Ejecutar kick
      try {
        logger.info(`[KICK] Intentando expulsar a ${targetId} del grupo ${chatId}`);
        
        const targetNick = (usuarios[targetId] && usuarios[targetId].nombre) ? usuarios[targetId].nombre : targetId.split('@')[0];
        const adminNick = (usuarios[senderId] && usuarios[senderId].nombre) ? usuarios[senderId].nombre : senderId.split('@')[0];
        
        // Intentar eliminar del grupo
        await sock.groupParticipantsUpdate(chatId, [targetId], 'remove');
        
        // Enviar mensaje confirmando expulsión
        const mensajeKick = `*━━━━━━━━━━━━━━━━━━━━━━━*\n🚫 *USUARIO EXPULSADO* 🚫\n*━━━━━━━━━━━━━━━━━━━━━━━*\n\n👤 *Usuario:* ${targetNick}\n👮 *Expulsado por:* ${adminNick}\n\n*Razón:* Violación de reglas\n\n*━━━━━━━━━━━━━━━━━━━━━━━*`;
        
        await sock.sendMessage(chatId, { text: mensajeKick }, { forceAllow: true });
        
        try { addHistorialNegro(targetId, 'Expulsado', `Expulsado por ${adminNick}`); } catch (e) {}
        logger.info(`[KICK] ✅ ${adminNick} expulsó exitosamente a ${targetNick}`);
        return;
      } catch (e) {
        logger.error(`[KICK] Error: ${e.message}`);
        await sock.sendMessage(chatId, { text: `❌ *No se pudo expulsar al usuario*\n\n*Error:* ${e.message}\n\n*Verificar:*\n• El bot es administrador\n• El usuario está en el grupo\n• Permisos de WhatsApp`, mentions: [senderId] }, { quoted: msg, forceAllow: true });
        return;
      }
    }

    if (body === "#listamute") {
      if (!chatId.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: "❌ Este comando solo funciona en grupos." }, { quoted: msg });
        return;
      }
      if (!mutes[chatId] || Object.keys(mutes[chatId]).length === 0) {
        await sock.sendMessage(chatId, { text: "🔇 No hay usuarios muteados en este grupo." }, { quoted: msg });
        return;
      }
      let lista = "🔇 Usuarios muteados en este grupo:\n\n";
      for (const [userId, data] of Object.entries(mutes[chatId])) {
        const nick = (usuarios[userId] && usuarios[userId].nombre) ? usuarios[userId].nombre : userId.split('@')[0];
        const tiempoRestante = Math.ceil((data.until - Date.now()) / 60000);
        lista += `• ${nick} - ${tiempoRestante > 0 ? tiempoRestante + ' minutos restantes' : 'Expirado'}\n`;
      }
      await sock.sendMessage(chatId, { text: lista }, { quoted: msg });
      return;
    }

    if (body === "#rank" || body === "#rankpower") {
      // Recargar usuarios de BD para datos en tiempo real
      if (db && typeof db.getAllUsuarios === 'function') {
        try {
          const bdUsers = db.getAllUsuarios();
          if (bdUsers && Object.keys(bdUsers).length > 0) {
            Object.assign(usuarios, bdUsers);
          }
        } catch (e) { logger.warn('No se pudieron recargar usuarios de BD:', e.message); }
      }
      const entries = Object.entries(usuarios).sort(([,a],[,b]) => (b.poder || 0) - (a.poder || 0));
      if (entries.length === 0) {
        await sock.sendMessage(chatId, { text: `--------------------\n   RANKING DE PODER\n--------------------\n\nNo hay usuarios registrados.\nUsa #registrar [nombre] para empezar.` }, { quoted: msg });
        return;
      }
      const top = entries.slice(0, 50);
      const symbols = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ'];
      let ranking = `--------------------\n   RANKING DE PODER (TOP 50)\n--------------------\n`;
      top.forEach(([id,u], i) => {
        const symbol = symbols[i] ? `*${symbols[i]}*` : `#${i+1}`;
        const nombre = u.nombre || id.split('@')[0];
        const poder = (u.poder||0).toLocaleString();
        const dinero = (u.dinero||0).toLocaleString();
        ranking += `\n${symbol} ${nombre}\n   Poder: ${poder} | Dinero: $${dinero}\n`;
      });
      // Mostrar posición y poder del usuario invocador
      const idx = entries.findIndex(e => e[0] === senderId);
      if (idx >= 0) {
        const u = entries[idx][1];
        ranking += `\n--------------------\nTu posición: #${idx+1}\nPoder: ${(u.poder||0).toLocaleString()}\n`;
      }
      ranking += `--------------------`;
      await sock.sendMessage(chatId, { text: ranking }, { quoted: msg });
    }

    if (body === "#rankbal") {
      // Recargar usuarios de BD para datos en tiempo real
      if (db && typeof db.getAllUsuarios === 'function') {
        try {
          const bdUsers = db.getAllUsuarios();
          if (bdUsers && Object.keys(bdUsers).length > 0) {
            Object.assign(usuarios, bdUsers);
          }
        } catch (e) { logger.warn('No se pudieron recargar usuarios de BD:', e.message); }
      }
      const entries = Object.entries(usuarios).sort(([,a],[,b]) => (b.dinero || 0) - (a.dinero || 0));
      if (entries.length === 0) {
        await sock.sendMessage(chatId, { text: `--------------------\n   RANKING DE DINERO\n--------------------\n\nNo hay usuarios registrados.\nUsa #registrar [nombre] para empezar.` }, { quoted: msg });
        return;
      }
      const top = entries.slice(0, 50);
      const symbols = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ'];
      let txt = `--------------------\n   RANKING DE DINERO (TOP 50)\n--------------------\n`;
      top.forEach(([id,u], i) => {
        const symbol = symbols[i] ? `*${symbols[i]}*` : `#${i+1}`;
        const nombre = u.nombre || id.split('@')[0];
        txt += `\n${symbol} ${nombre}\n   Dinero: $${(u.dinero||0).toLocaleString()}\n`;
      });
      const idx = entries.findIndex(e => e[0] === senderId);
      if (idx >= 0) {
        const u = entries[idx][1];
        txt += `\n--------------------\nTu posición: #${idx+1}\nDinero: $${(u.dinero||0).toLocaleString()}\n`;
      }
      txt += `--------------------`;
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    if (body === "#ranklevel") {
      // Recargar usuarios de BD para datos en tiempo real
      if (db && typeof db.getAllUsuarios === 'function') {
        try {
          const bdUsers = db.getAllUsuarios();
          if (bdUsers && Object.keys(bdUsers).length > 0) {
            Object.assign(usuarios, bdUsers);
          }
        } catch (e) { logger.warn('No se pudieron recargar usuarios de BD:', e.message); }
      }
      const entries = Object.entries(usuarios).sort(([,a],[,b]) => (b.nivel || 1) - (a.nivel || 1));
      if (entries.length === 0) {
        await sock.sendMessage(chatId, { text: `--------------------\n   RANKING DE NIVEL\n--------------------\n\nNo hay usuarios registrados.\nUsa #registrar [nombre] para empezar.` }, { quoted: msg });
        return;
      }
      const top = entries.slice(0, 50);
      const symbols = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ'];
      let txt = `--------------------\n   RANKING DE NIVEL (TOP 50)\n--------------------\n`;
      top.forEach(([id,u], i) => {
        const symbol = symbols[i] ? `*${symbols[i]}*` : `#${i+1}`;
        const nombre = u.nombre || id.split('@')[0];
        txt += `\n${symbol} ${nombre}\n   Nivel: ${(u.nivel||1)} | EXP: ${(u.exp||0)}/${expToNext(u.nivel||1)}\n`;
      });
      const idx = entries.findIndex(e => e[0] === senderId);
      if (idx >= 0) {
        const u = entries[idx][1];
        txt += `\n--------------------\nTu posición: #${idx+1}\nNivel: ${(u.nivel||1)} | EXP: ${(u.exp||0)}/${expToNext(u.nivel||1)}\n`;
      }
      txt += `--------------------`;
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
    }

    if (body === "#ranks") {
      // Recargar usuarios de BD para datos en tiempo real
      if (db && typeof db.getAllUsuarios === 'function') {
        try {
          const bdUsers = db.getAllUsuarios();
          if (bdUsers && Object.keys(bdUsers).length > 0) {
            Object.assign(usuarios, bdUsers);
          }
        } catch (e) { logger.warn('No se pudieron recargar usuarios de BD:', e.message); }
      }
      const allUsers = Object.values(usuarios);
      if (allUsers.length === 0) {
        await sock.sendMessage(chatId, { text: `--------------------\n   RANKS\n--------------------\n\nNo hay usuarios registrados.\nUsa #registrar [nombre] para empezar.` }, { quoted: msg });
        return;
      }
      const topPoder = allUsers.slice().sort((a, b) => (b.poder || 0) - (a.poder || 0)).slice(0, 50);
      const topDinero = allUsers.slice().sort((a, b) => (b.dinero || 0) - (a.dinero || 0)).slice(0, 50);
      const topNivel = allUsers.slice().sort((a, b) => (b.nivel || 1) - (a.nivel || 1)).slice(0, 50);
      const symbols = ['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ'];
      let out = `--------------------\n   RANKS (TOP 50)\n--------------------\n`;
      out += `\nTop Poder:\n`;
      topPoder.forEach((u, i) => { out += `\n${symbols[i] ? `*${symbols[i]}*` : ('#'+(i+1))} ${u.nombre}\n   Poder: ${(u.poder||0).toLocaleString()}\n`; });
      out += `\nTop Dinero:\n`;
      topDinero.forEach((u, i) => { out += `\n${symbols[i] ? `*${symbols[i]}*` : ('#'+(i+1))} ${u.nombre}\n   Dinero: $${(u.dinero||0).toLocaleString()}\n`; });
      out += `\nTop Nivel:\n`;
      topNivel.forEach((u, i) => { out += `\n${symbols[i] ? `*${symbols[i]}*` : ('#'+(i+1))} ${u.nombre}\n   Nivel: ${(u.nivel||1)}\n`; });
      out += `\n--------------------`;
      await sock.sendMessage(chatId, { text: out }, { quoted: msg });
    }

    if (body === "#rangos") {
      let txt = "*✦ RANGOS DE TEMPORADA ✦*\n";
      txt += "*(Progresa con PUNTOS de temporada)*\n\n";
      
      for (let i = 0; i < SEASON_RANKS.length; i++) {
        const rango = SEASON_RANKS[i];
        const siguienteRango = i < SEASON_RANKS.length - 1 ? SEASON_RANKS[i + 1] : null;
        const puntosNecesarios = siguienteRango ? siguienteRango.pts - rango.pts : 0;
        
        txt += `\n${rango.name}\n`;
        txt += `   📊 Puntos base: ${rango.pts.toLocaleString()}`;
        if (siguienteRango) {
          txt += `\n   ⬆️ Proximamente: +${puntosNecesarios.toLocaleString()} puntos`;
        } else {
          txt += `\n   🎖️ ¡MÁXIMO NIVEL DESBLOQUEADO!`;
        }
      }
      
      txt += `\n\n*─ 🚀 Gana puntos: Bosses | Temporadas | Eventos*`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#logros") {
      const ach = buildAchievementsText(user);
      await sock.sendMessage(chatId, { text: ach }, { quoted: msg });
      return;
    }

    if (body === "#misiones") {
      initMissionsForUser(user);
      const txt = buildMissionsText(user);
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#mascotas" || body === "#pets") {
      const txt = buildPetsText(user);
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#comprarmascotas") {
      let txt = '🐾 TIENDA DE MASCOTAS 🐾\n\n';
      for (const petId in PETS) {
        const pet = PETS[petId];
        txt += `${pet.nombre}\n`;
        txt += `   ${pet.desc}\n`;
        txt += `   💰 Precio: $${pet.precio.toLocaleString()}\n`;
        txt += `   ⚔️ Poder: +${pet.poder}\n`;
        txt += `   💬 Usa: #comprar ${petId}\n\n`;
      }
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#comprar ") {
      const args = body.split(/\s+/).filter(Boolean);
      const itemId = args[1];
      if (!itemId) {
        await sock.sendMessage(chatId, { text: 'Uso: #comprar <id>' }, { quoted: msg });
        return;
      }
      const pet = getPetById(itemId);
      if (!pet) {
        await sock.sendMessage(chatId, { text: '🐾 Mascota no encontrada.' }, { quoted: msg });
        return;
      }
      if ((user.dinero || 0) < pet.precio) {
        await sock.sendMessage(chatId, { text: `❌ No tienes suficiente dinero.\nTienes: $${(user.dinero || 0).toLocaleString()}\nNecesitas: $${pet.precio.toLocaleString()}` }, { quoted: msg });
        return;
      }
      if (buyPet(user, itemId, sock, chatId)) {
        await sock.sendMessage(chatId, { text: `✅ ¡Mascota ${pet.nombre} comprada!` }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { text: `❌ No pudiste comprar la mascota. Quizás ya la tienes o hay un error.` }, { quoted: msg });
      }
      return;
    }

    if (body === "#mercado") {
      if (marketplace.length === 0) {
        await sock.sendMessage(chatId, { text: '🛒 MERCADO VACÍO\n\nNo hay items listados.\nUsa #vender <itemId> <precio> para listar un item.' }, { quoted: msg });
        return;
      }
      const activos = marketplace.filter(l => l.estado === 'activo');
      if (activos.length === 0) {
        await sock.sendMessage(chatId, { text: '🛒 MERCADO VACÍO' }, { quoted: msg });
        return;
      }
      let txt = '🛒 MERCADO P2P\n\n';
      for (const listing of activos.slice(0, 20)) {
        txt += `${listing.itemName} (${listing.itemRarity})\n`;
        txt += `   💰 $${listing.precio.toLocaleString()}\n`;
        txt += `   🆔 ${listing.id}\n`;
        txt += `   Vendedor: ${usuarios[listing.sellerId]?.nombre || 'Desconocido'}\n\n`;
      }
      txt += `\n💬 Usa: #comprar-mercado <id> para comprar`;
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith("#comprar-mercado ")) {
      const args = body.split(/\s+/).filter(Boolean);
      const listingId = args[1];
      if (!listingId) {
        await sock.sendMessage(chatId, { text: 'Uso: #comprar-mercado <id>' }, { quoted: msg });
        return;
      }
      const result = buyFromMarketplace(senderId, listingId, user, sock, chatId);
      if (!result.success) {
        await sock.sendMessage(chatId, { text: result.msg }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { text: '✅ Compra exitosa.' }, { quoted: msg });
      }
      return;
    }

    if (body.startsWith("#vender ")) {
      const args = body.split(/\s+/).filter(Boolean);
      const itemId = args[1];
      const precio = parseInt(args[2]);
      if (!itemId || isNaN(precio) || precio <= 0) {
        await sock.sendMessage(chatId, { text: 'Uso: #vender <itemId> <precio>\nEjemplo: #vender espada_legendaria_1 50000' }, { quoted: msg });
        return;
      }
      if (!user.inventario || !user.inventario[itemId] || user.inventario[itemId] <= 0) {
        await sock.sendMessage(chatId, { text: '❌ No tienes ese item.' }, { quoted: msg });
        return;
      }
      const item = buscarItem(itemId);
      if (!item) {
        await sock.sendMessage(chatId, { text: '❌ Item no encontrado.' }, { quoted: msg });
        return;
      }
      user.inventario[itemId]--;
      const listing = listItemOnMarketplace(senderId, itemId, item.nombre, item.rareza, precio);
      await sock.sendMessage(chatId, { text: `✅ Item listado en el mercado!\n\n${item.nombre}\n💰 $${precio.toLocaleString()}\n\nOtros usuarios pueden comprarlo con #comprar-mercado ${listing.id}` }, { quoted: msg });
      guardarBD();
      return;
    }

    if (body === "#top poder" || body === "#toppoder") {
      const topUsers = Object.values(usuarios).sort((a, b) => (b.poder || 0) - (a.poder || 0)).slice(0, 10);
      const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      let txt = '⚡ TOP 10 PODER\n\n';
      topUsers.forEach((u, i) => {
        const { rango } = obtenerRangoClasificacion(u.poder || 0);
        txt += `${romanos[i]}. ${u.nombre} — ⚔️ ${(u.poder || 0).toLocaleString()} | ${rango}\n`;
      });
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#top dinero" || body === "#topdinero") {
      const topUsers = Object.values(usuarios).sort((a, b) => ((b.dinero || 0) + (b.banco || 0)) - ((a.dinero || 0) + (a.banco || 0))).slice(0, 10);
      const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      let txt = '💰 TOP 10 MILLONARIOS\n\n';
      topUsers.forEach((u, i) => {
        const totalDinero = (u.dinero || 0) + (u.banco || 0);
        txt += `${romanos[i]}. ${u.nombre} — $${totalDinero.toLocaleString()}\n`;
      });
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#top nivel" || body === "#topnivel") {
      const topUsers = Object.values(usuarios).sort((a, b) => (b.nivel || 0) - (a.nivel || 0)).slice(0, 10);
      const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      let txt = '📚 TOP 10 EXPERIENCIA\n\n';
      topUsers.forEach((u, i) => {
        txt += `${romanos[i]}. ${u.nombre} — Nivel ${u.nivel} | ⭐ ${(u.exp || 0).toLocaleString()} EXP\n`;
      });
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#top duelos" || body === "#topduelos") {
      const topUsers = Object.values(usuarios).sort((a, b) => ((b.stats?.duelWins || 0)) - ((a.stats?.duelWins || 0))).slice(0, 10);
      const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      let txt = '⚔️ TOP 10 GUERREROS\n\n';
      topUsers.forEach((u, i) => {
        const wins = u.stats?.duelWins || 0;
        const losses = u.stats?.duelLosses || 0;
        const total = wins + losses;
        const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;
        txt += `${romanos[i]}. ${u.nombre} — 🏆 ${wins}V | ${winRate}% | 📈 ${total} duelos\n`;
      });
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#top logros" || body === "#toplogros") {
      const topUsers = Object.values(usuarios).sort((a, b) => ((b.achievements || []).length) - ((a.achievements || []).length)).slice(0, 10);
      const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      let txt = '🎖️ TOP 10 LOGROS\n\n';
      topUsers.forEach((u, i) => {
        const logros = (u.achievements || []).length;
        txt += `${romanos[i]}. ${u.nombre} — 🏅 ${logros} logros\n`;
      });
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    // ===== LEADERBOARDS AVANZADOS =====
    if (body === '#leaderboards' || body === '#lbs') {
      actualizarLeaderboards();
      let txt = '📊 LEADERBOARDS SEMANALES\n\n';
      txt += `Última actualización: Cada 30 minutos\n`;
      txt += `Reset semanal: En ${Math.ceil((7 * 24 * 3600 * 1000 - (Date.now() - leaderboards.lastReset)) / (24 * 3600 * 1000))} días\n\n`;
      txt += '🔹 Usa:\n';
      txt += '  #lb dinero  - Top 10 millonarios\n';
      txt += '  #lb poder   - Top 10 más fuertes\n';
      txt += '  #lb duelos  - Top 10 gladiadores\n';
      txt += '  #lb mercancias - Top 10 mercaderes\n';
      txt += '  #mi-rango [categoria] - Ver tu posición\n';
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith('#lb ') || body.startsWith('#leaderboard ')) {
      const categoria = body.split(' ')[1]?.toLowerCase() || 'dinero';
      actualizarLeaderboards();
      
      let ranking = [];
      let titulo = '';
      let emoji = '';
      
      if (categoria === 'dinero') {
        ranking = leaderboards.dinero;
        titulo = 'MULTIMILLONARIOS';
        emoji = '💰';
      } else if (categoria === 'poder') {
        ranking = leaderboards.poder;
        titulo = 'GUERREROS SUPREMOS';
        emoji = '⚔️';
      } else if (categoria === 'duelos') {
        ranking = leaderboards.duelos;
        titulo = 'GLADIADORES';
        emoji = '🏆';
      } else if (categoria === 'mercancias' || categoria === 'mercado') {
        ranking = leaderboards.mercancias;
        titulo = 'MERCADERES LEGENDARIOS';
        emoji = '🏪';
      } else {
        await sock.sendMessage(chatId, { text: '❌ Categoría desconocida. Usa: dinero, poder, duelos, mercancias' }, { quoted: msg });
        return;
      }
      
      const romanos = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      let txt = `${emoji} TOP 10 ${titulo}\n\n`;
      
      for (let i = 0; i < ranking.length; i++) {
        const r = ranking[i];
        const medalla = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const valor = categoria === 'dinero' ? `$${r.valor.toLocaleString()}` : r.valor.toLocaleString();
        txt += `${medalla} ${r.nombre} — ${valor}\n`;
      }
      
      // Buscar posición del usuario
      const miPosicion = ranking.findIndex(r => r.userId === senderId);
      if (miPosicion === -1) {
        txt += `\n📍 Tu posición: Fuera del top 10\n`;
      } else {
        const r = ranking[miPosicion];
        const medalla = miPosicion === 0 ? '🥇' : miPosicion === 1 ? '🥈' : miPosicion === 2 ? '🥉' : `${miPosicion + 1}.`;
        const valor = categoria === 'dinero' ? `$${r.valor.toLocaleString()}` : r.valor.toLocaleString();
        txt += `\n📍 Tu posición: ${medalla} #${miPosicion + 1}\n   ${valor}\n`;
      }
      
      txt += `\n⏱️ Actualizado cada 30 min | Reset en ${Math.ceil((7 * 24 * 3600 * 1000 - (Date.now() - leaderboards.lastReset)) / (24 * 3600 * 1000))} días`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === '#mi-rango' || body === '#myrango') {
      actualizarLeaderboards();
      let txt = '📊 TU POSICIÓN EN LEADERBOARDS\n\n';
      
      const totalDinero = (user.dinero || 0) + (user.banco || 0);
      const poder = (user.poder || 0) + (user.defensa || 0) + (user.vida || 100);
      const duelos = (user.stats?.duelWins) || 0;
      const ventas = (user.stats?.itemsSold) || 0;
      
      const positionDinero = leaderboards.dinero.findIndex(r => r.userId === senderId);
      const positionPoder = leaderboards.poder.findIndex(r => r.userId === senderId);
      const positionDuelos = leaderboards.duelos.findIndex(r => r.userId === senderId);
      const positionVentas = leaderboards.mercancias.findIndex(r => r.userId === senderId);
      
      txt += `💰 DINERO: ${positionDinero === -1 ? '❌ Fuera del top' : `🥇 #${positionDinero + 1}`} ($${totalDinero.toLocaleString()})\n`;
      txt += `⚔️ PODER: ${positionPoder === -1 ? '❌ Fuera del top' : `🥇 #${positionPoder + 1}`} (${poder})\n`;
      txt += `🏆 DUELOS: ${positionDuelos === -1 ? '❌ Fuera del top' : `🥇 #${positionDuelos + 1}`} (${duelos} victorias)\n`;
      txt += `🏪 MERCANCIAS: ${positionVentas === -1 ? '❌ Fuera del top' : `🥇 #${positionVentas + 1}`} (${ventas} vendidos)\n`;
      
      txt += `\n💡 Usa #lb <categoria> para ver el top completo`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#historial") {
      let txt = '📜 TU HISTORIAL RECIENTE\n\n';
      txt += `⚔️ Duelos ganados: ${(user.stats?.duelWins || 0)}\n`;
      txt += `🐉 Bosses derrotados: ${(user.stats?.bossKills || 0) || 'N/A'}\n`;
      txt += `💪 Entrenamientos: ${(user.stats?.trainCount || 0)}\n`;
      txt += `📅 Días activos: ${user.consecutiveDays || 0}\n`;
      txt += `🏆 Logros desbloqueados: ${(user.achievements || []).length}\n`;
      txt += `📊 Temporadas participadas: ${(user.seasonsParticipated || []).length}\n`;
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body === "#clases") {
      const clasesData = [
        { nombre: "Callejero", poder: "0 - 999", emoji: "🥉" },
        { nombre: "Luchador", poder: "1.000 - 4.999", emoji: "🥈" },
        { nombre: "Héroe", poder: "5.000 - 14.999", emoji: "⚔️" },
        { nombre: "Campeón", poder: "15.000 - 29.999", emoji: "🏅" },
        { nombre: "Continental", poder: "30.000 - 74.999", emoji: "🌍" },
        { nombre: "Planetario", poder: "75.000 - 149.999", emoji: "🪐" },
        { nombre: "Estelar", poder: "150.000 - 299.999", emoji: "⭐" },
        { nombre: "Universal", poder: "300.000 - 599.999", emoji: "🌌" },
        { nombre: "Infinity", poder: "600.000 - 999.999", emoji: "♾️" },
        { nombre: "Celestial", poder: "1.000.000 - 1.999.999", emoji: "✨" },
        { nombre: "Eterno", poder: "2.000.000 - 4.999.999", emoji: "👑" },
        { nombre: "Inmortal", poder: "5.000.000 - 9.999.999", emoji: "🔱" },
        { nombre: "Divino", poder: "10.000.000 - 24.999.999", emoji: "⚡" },
        { nombre: "Ancestral", poder: "25.000.000 - 49.999.999", emoji: "🗝️" },
        { nombre: "Legendario", poder: "50.000.000 - 99.999.999", emoji: "👑" },
        { nombre: "Omega", poder: "100.000.000+", emoji: "💎" }
      ];

      let txt = "*✦ CLASES DE PODER ✦*\n";
      txt += "*(Progresa con PODER en combates)*\n\n";

      for (const clase of clasesData) {
        txt += `\n${clase.emoji} ${clase.nombre}\n`;
        txt += `   💪 Poder necesario: ${clase.poder}`;
      }

      txt += `\n\n*─ Gana poder derrotando bosses, eventos y duelos 🚀*`;

      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }



    if (body === "#apostar ") {
      const args = body.split(/\s+/).filter(Boolean);
      if (args.length < 3) {
        await sock.sendMessage(chatId, { text: 'Uso: #apostar @usuario <cantidad>\nEjemplo: #apostar @juan 5000' }, { quoted: msg });
        return;
      }
      const apuestaAmount = parseInt(args[2]);
      if (isNaN(apuestaAmount) || apuestaAmount <= 0) {
        await sock.sendMessage(chatId, { text: '❌ Cantidad inválida.' }, { quoted: msg });
        return;
      }
      if ((user.dinero || 0) < apuestaAmount) {
        await sock.sendMessage(chatId, { text: `❌ No tienes suficiente dinero para apostar $${apuestaAmount.toLocaleString()}` }, { quoted: msg });
        return;
      }
      if (!user.bets) user.bets = [];
      user.bets.push({
        id: 'bet_' + Date.now(),
        monto: apuestaAmount,
        resultado: null,
        fecha: Date.now()
      });
      user.dinero -= apuestaAmount;
      guardarBD();
      await sock.sendMessage(chatId, { text: `💸 Apuesta registrada: $${apuestaAmount.toLocaleString()}\n\n📊 Gana si predicción es correcta.\n⚠️ Pierde si no lo es.` }, { quoted: msg });
      return;
    }

    if (body === "#invasión" || body === "#invasion") {
      createInvasionBoss(sock, chatId);
      const boss = invasionEvent;
      if (!boss || !boss.activo) {
        await sock.sendMessage(chatId, { text: '❌ No hay invasión activa.' }, { quoted: msg });
        return;
      }
      // calcular daño: 15 base sin espada, multiplicado con espada
      let dmg = 15;
      try {
        const wid = user.equipo && user.equipo.weapon;
        if (wid) {
          const item = getWeaponItem(wid);
          if (item) {
            dmg = Math.floor(15 * getWeaponMultiplierByItem(item));
            // Variación ±20% solo con espada
            dmg = Math.floor(dmg * (0.8 + Math.random() * 0.4));
          }
        }
      } catch (e) {}
      const real = registerDamageToBoss(boss, senderId, dmg, sock, chatId);
      await sock.sendMessage(chatId, { text: `⚔️ ¡Ataque a la invasión!\n\nDaño infligido: ${real}\nVida restante: ${boss.vidaActual.toLocaleString()}/${boss.vidaMax.toLocaleString()}` }, { quoted: msg });
      return;
    }

    if (body === "#prestige") {
      if ((user.poder || 0) < 10000000) {
        const poderRestante = 10000000 - (user.poder || 0);
        await sock.sendMessage(chatId, { text: `❌ Necesitas 10,000,000 de poder para hacer prestige.\n\nTe faltan: ${poderRestante.toLocaleString()} poder` }, { quoted: msg });
        return;
      }
      const newPrestige = (user.prestige || 0) + 1;
      const prestigeBonus = newPrestige * 5; // +5% por cada prestige
      user.prestige = newPrestige;
      user.poder = 1000; // reset poder
      user.prestigeBonus = prestigeBonus;
      
      // dar título especial
      if (newPrestige >= 3) grantAchievement(user, 'prestigio_iii', sock, chatId);
      if (newPrestige >= 5) grantAchievement(user, 'prestigio_v', sock, chatId);
      
      guardarBD();
      await sock.sendMessage(chatId, { text: `*✦ PRESTIGE DESBLOQUEADO ✦*\n\n🌟 Nuevo Prestige: ${newPrestige}\n⚔️ Poder reseteado a 1,000\n📈 Bonus permanente: +${prestigeBonus}%\n\n¡Continúa tu jornada!` }, { quoted: msg });
      return;
    }

    if (body === '#apuestas' || body === '#apostar') {
      let txt = `*✦ SISTEMA DE APUESTAS ✦*\n\n`;
      txt += `▸ *¿Cómo apostar?*\n\n`;
      txt += `*1. APUESTA EN DUELO*\n`;
      txt += `#duelo @usuario [cantidad]\n\n`;
      txt += `*2. RULETA RUSA*\n`;
      txt += `#reto-ruleta @usuario [cantidad]\n\n`;
      txt += `*3. LANZAR DADOS*\n`;
      txt += `#dados [cantidad]\n\n`;
      txt += `*4. CARA O CRUZ*\n`;
      txt += `#moneda [cantidad] [opción]\n\n`;
      txt += `*─ TUS ESTADÍSTICAS ─*\n`;
      txt += `▸ Dinero: $${user.dinero.toLocaleString()}\n`;
      txt += `▸ Duelos ganados: ${user.stats?.duelWins || 0}\n`;
      txt += `▸ Duelos perdidos: ${user.stats?.duelLoses || 0}\n`;
      txt += `▸ Dinero ganado en duelos: $${user.stats?.duelMoney || 0}\n\n`;
      txt += `*⚠️ ADVERTENCIA:*\n`;
      txt += `Toda apuesta es a tu riesgo. No garantizamos ganancias.`;
      
      await sock.sendMessage(chatId, { text: txt }, { quoted: msg });
      return;
    }

    if (body.startsWith("#dados")) {
      const args = body.split(" ");
      const cantidad = parseInt(args[1]) || 100;
      
      if (user.dinero < cantidad) {
        await sock.sendMessage(chatId, { text: `❌ No tienes dinero suficiente\n\n▸ Dinero: $${user.dinero.toLocaleString()}\n▸ Apuesta: $${cantidad.toLocaleString()}` }, { quoted: msg });
        return;
      }
      
      const dado1 = Math.floor(Math.random() * 6) + 1;
      const dado2 = Math.floor(Math.random() * 6) + 1;
      const suma = dado1 + dado2;
      
      let ganancia = 0;
      let resultado = '';
      
      if (suma >= 10) {
        ganancia = Math.floor(cantidad * 1.8);
        resultado = `*🎯 ¡GANASTE! 🎯*\n\n`;
        resultado += `▸ Dados: ${dado1} + ${dado2} = ${suma}\n`;
        resultado += `▸ Ganancia: +$${ganancia.toLocaleString()}\n`;
        resultado += `▸ Dinero: $${(user.dinero + ganancia).toLocaleString()}`;
        user.dinero += ganancia;
      } else if (suma >= 7) {
        ganancia = Math.floor(cantidad * 0.5);
        resultado = `*✨ PARCIAL ✨*\n\n`;
        resultado += `▸ Dados: ${dado1} + ${dado2} = ${suma}\n`;
        resultado += `▸ Ganancia: +$${ganancia.toLocaleString()}\n`;
        resultado += `▸ Dinero: $${(user.dinero + ganancia).toLocaleString()}`;
        user.dinero += ganancia;
      } else {
        resultado = `*💀 PERDISTE 💀*\n\n`;
        resultado += `▸ Dados: ${dado1} + ${dado2} = ${suma}\n`;
        resultado += `▸ Pérdida: -$${cantidad.toLocaleString()}\n`;
        resultado += `▸ Dinero: $${(user.dinero - cantidad).toLocaleString()}`;
        user.dinero -= cantidad;
      }
      
      guardarBD();
      await sock.sendMessage(chatId, { text: resultado }, { quoted: msg });
      return;
    }

    if (body.startsWith("#moneda")) {
      const args = body.split(" ");
      const cantidad = parseInt(args[1]) || 100;
      const opcion = (args[2] || 'cara').toLowerCase();
      
      if (opcion !== 'cara' && opcion !== 'cruz') {
        await sock.sendMessage(chatId, { text: `❌ Usa: #moneda [cantidad] [cara/cruz]` }, { quoted: msg });
        return;
      }
      
      if (user.dinero < cantidad) {
        await sock.sendMessage(chatId, { text: `❌ No tienes dinero suficiente\n\n▸ Dinero: $${user.dinero.toLocaleString()}\n▸ Apuesta: $${cantidad.toLocaleString()}` }, { quoted: msg });
        return;
      }
      
      const resultado = Math.random() > 0.5 ? 'cara' : 'cruz';
      let gano = resultado === opcion;
      let texto = '';
      
      if (gano) {
        const ganancia = Math.floor(cantidad * 2);
        user.dinero += ganancia;
        texto = `*🪙 GANASTE 🪙*\n\n`;
        texto += `▸ Apostaste por: *${opcion.toUpperCase()}*\n`;
        texto += `▸ Resultado: *${resultado.toUpperCase()}*\n`;
        texto += `▸ Ganancia: +$${ganancia.toLocaleString()}\n`;
        texto += `▸ Dinero: $${user.dinero.toLocaleString()}`;
      } else {
        user.dinero -= cantidad;
        texto = `*🪙 PERDISTE 🪙*\n\n`;
        texto += `▸ Apostaste por: *${opcion.toUpperCase()}*\n`;
        texto += `▸ Resultado: *${resultado.toUpperCase()}*\n`;
        texto += `▸ Pérdida: -$${cantidad.toLocaleString()}\n`;
        texto += `▸ Dinero: $${user.dinero.toLocaleString()}`;
      }
      
      guardarBD();
      await sock.sendMessage(chatId, { text: texto }, { quoted: msg });
      return;
    }

    if (body.startsWith("#duelo")) {
      const args = body.split(" ");
      
      let enemigoId = null;
      let apuesta = 0;
      
      // Obtener enemigo por mention
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (mentionedJid) {
        enemigoId = mentionedJid;
      } else if (args[1]) {
        enemigoId = args[1].replace("@", "") + "@s.whatsapp.net";
      }
      
      // Obtener apuesta si existe
      if (args[2]) {
        apuesta = parseInt(args[2]) || 0;
      }
      
      if (!enemigoId) {
        await sock.sendMessage(chatId, { text: "❌ *USO:*\n\n#duelo @usuario [cantidad]\n\n*Ejemplo:*\n#duelo @usuario 1000" }, { quoted: msg });
        return;
      }
      
      if (enemigoId === senderId) {
        await sock.sendMessage(chatId, { text: "❌ No puedes duelarte contra ti mismo" }, { quoted: msg });
        return;
      }
      
      if (!usuarios[enemigoId]) {
        await sock.sendMessage(chatId, { text: "❌ Ese usuario no existe" }, { quoted: msg });
        return;
      }
      
      let enemigo = usuarios[enemigoId];
      
      // Validar apuesta si existe
      if (apuesta > 0) {
        if (user.dinero < apuesta) {
          await sock.sendMessage(chatId, { text: `❌ No tienes suficiente dinero\n\n*Tu dinero:* $${user.dinero.toLocaleString()}\n*Apuesta:* $${apuesta.toLocaleString()}` }, { quoted: msg });
          return;
        }
        if (enemigo.dinero < apuesta) {
          await sock.sendMessage(chatId, { text: `❌ ${enemigo.nombre} no tiene suficiente dinero para la apuesta\n\n*Su dinero:* $${enemigo.dinero.toLocaleString()}\n*Apuesta:* $${apuesta.toLocaleString()}` }, { quoted: msg });
          return;
        }
      }
      
      // Iniciar duelo
      const battleText = apuesta > 0 
        ? `⚔️ *DUELO INICIADO* ⚔️\n\n🔥 ${user.nombre} (${user.poder.toLocaleString()}⚡)\n       VS\n🔥 ${enemigo.nombre} (${enemigo.poder.toLocaleString()}⚡)\n\n💰 *Apuesta:* $${apuesta.toLocaleString()} c/u\n💰 *Total en juego:* $${(apuesta * 2).toLocaleString()}\n\n⏳ Combatiendo...`
        : `⚔️ *DUELO INICIADO* ⚔️\n\n🔥 ${user.nombre} (${user.poder.toLocaleString()}⚡)\n       VS\n🔥 ${enemigo.nombre} (${enemigo.poder.toLocaleString()}⚡)\n\n⏳ Combatiendo...`;
      
      await sock.sendMessage(chatId, { text: battleText, mentions: [senderId, enemigoId] }, { quoted: msg });
      
      setTimeout(async () => {
        // Calcular daño: 15 base sin espada, ×multiplicador con espada
        let dmgUser = 15;
        try {
          const wid1 = user.equipo && user.equipo.weapon;
          if (wid1) {
            const item = getWeaponItem(wid1);
            if (item) {
              dmgUser = Math.floor(15 * getWeaponMultiplierByItem(item));
            }
          }
        } catch (e) {}
        
        let dmgEnemigo = 15;
        try {
          const wid2 = enemigo.equipo && enemigo.equipo.weapon;
          if (wid2) {
            const item = getWeaponItem(wid2);
            if (item) {
              dmgEnemigo = Math.floor(15 * getWeaponMultiplierByItem(item));
            }
          }
        } catch (e) {}
        
        // Quien tiene más daño gana, con desempate aleatorio
        let ganador = dmgUser > dmgEnemigo ? user : (dmgEnemigo > dmgUser ? enemigo : (Math.random() > 0.5 ? user : enemigo));
        let perdedor = ganador === user ? enemigo : user;
        let ganadorId = ganador === user ? senderId : enemigoId;
        let perdedorId = perdedor === user ? senderId : enemigoId;
        
        // Calcular recompensas
        let recompensaPoder = Math.floor(Math.random() * 1500) + 500;
        
        // Aplicar apuesta si existe
        if (apuesta > 0) {
          ganador.dinero += apuesta;
          perdedor.dinero -= apuesta;
        }
        
        ganador.poder += recompensaPoder;
        
        // Dar EXP adicional por victoria
        const expForWin = Math.floor(recompensaPoder / 2) + Math.floor(Math.random() * 100);
        addExp(ganador, expForWin);
        
        // stats de duelos
        if (!ganador.stats) ganador.stats = {};
        if (!perdedor.stats) perdedor.stats = {};
        ganador.stats.duelWins = (ganador.stats.duelWins || 0) + 1;
        ganador.stats.duelMoney = (ganador.stats.duelMoney || 0) + apuesta;
        perdedor.stats.duelLoses = (perdedor.stats.duelLoses || 0) + 1;
        
        const wins = ganador.stats.duelWins;
        if (wins === 1) grantAchievement(ganador, 'primera_victoria');
        if (wins === 5) grantAchievement(ganador, 'duelista');
        if (wins === 10) grantAchievement(ganador, 'tryhard');
        if (wins === 50) grantAchievement(ganador, 'maquina');
        
        // actualizar misión diaria
        if (updateMissionProgress(ganador, 'gana_duelos', 1)) {
          const mission = DAILY_MISSIONS['gana_duelos'];
          sock.sendMessage(chatId, { text: `✅ ¡Misión completada! ${mission.nombre}\n💰 +$${mission.reward.dinero} | 📚 +${mission.reward.exp} exp` }).catch(() => {});
          ganador.dinero = (ganador.dinero || 0) + mission.reward.dinero;
          addExp(ganador, mission.reward.exp);
          if (currentSeason) seasonAddPointsAndRegister(ganadorId, mission.reward.puntos);
        }
        
        // temporadas PvP: puntos
        if (currentSeason) seasonAddPointsAndRegister(ganadorId, 10);
        guardarBD();
        
        const { rango: rangoGanador, clasificacion: clasifGanador } = obtenerRangoClasificacion(Number(ganador.poder) || 0);
        
        let resultText = `*🏆 RESULTADO DEL DUELO 🏆*\n\n👑 *Ganador:* ${ganador.nombre}\n⚔️ *Daño:* ${Math.max(dmgUser, dmgEnemigo)}\n📚 *Experiencia:* +${expForWin} EXP\n💰 *Poder:* +${recompensaPoder.toLocaleString()}\n⚡ *Poder total:* ${ganador.poder.toLocaleString()}\n🏅 *Rango:* ${rangoGanador} ${clasifGanador}`;
        
        if (apuesta > 0) {
          resultText += `\n\n💵 *Dinero ganado:* +$${apuesta.toLocaleString()}\n💸 *Dinero de ${perdedor.nombre}:* -$${apuesta.toLocaleString()}\n\n📊 *Dinero actual:*\n• ${ganador.nombre}: $${ganador.dinero.toLocaleString()}\n• ${perdedor.nombre}: $${perdedor.dinero.toLocaleString()}`;
        }
        
        resultText += `\n\n💔 *Derrotado:* ${perdedor.nombre}`;
        
        await sock.sendMessage(chatId, { text: resultText, mentions: [ganadorId, perdedorId] }, { quoted: msg });
      }, 3000);
    }

    if (body.startsWith("#ruleta")) {
      const args = body.split(" ");
      if (args.length === 2 && args[1].toLowerCase() === "aceptar") {
        if (!user.ruletaChallenge) {
          await sock.sendMessage(chatId, { text: "❌ No tienes desafíos de ruleta pendientes" }, { quoted: msg });
          return;
        }
        const challenge = user.ruletaChallenge;
        const retadorId = challenge.from;
        const cantidad = challenge.amount;
        if (!usuarios[retadorId]) {
          user.ruletaChallenge = null;
          guardarBD();
          await sock.sendMessage(chatId, { text: "❌ El retador ya no existe" }, { quoted: msg });
          return;
        }
        const retador = usuarios[retadorId];
        if (user.dinero < cantidad || retador.dinero < cantidad) {
          user.ruletaChallenge = null;
          guardarBD();
          await sock.sendMessage(chatId, { text: "❌ Uno de los jugadores no tiene suficiente dinero\n◈ Desafío cancelado" }, { quoted: msg });
          return;
        }
        user.ruletaChallenge = null;
        guardarBD();
        await sock.sendMessage(chatId, { 
          text: `🎯 ¡RULETA RUSA INICIADA!\n\n🔫 ${retador.nombre} VS ${user.nombre}\n💰 Apuesta: *$${cantidad.toLocaleString()}* c/u\n💀 Total en juego: *$${(cantidad * 2).toLocaleString()}*\n\n⏳ Girando el tambor...`,
          mentions: [retadorId, senderId]
        }, { quoted: msg });
        setTimeout(async () => {
          const ganador = Math.random() > 0.5 ? user : retador;
          const perdedor = ganador === user ? retador : user;
          const ganadorId = ganador === user ? senderId : retadorId;
          const perdedorId = perdedor === user ? senderId : retadorId;
          perdedor.dinero -= cantidad;
          ganador.dinero += cantidad;
          guardarBD();
          await sock.sendMessage(chatId, { 
            text: `💀 ¡RESULTADO DE LA RULETA RUSA!\n\n🎯 **Ganador:** ${ganador.nombre}\n💰 **Ganó:** *$${cantidad.toLocaleString()}*\n💀 **Perdedor:** ${perdedor.nombre}\n▼ **Perdió:** *$${cantidad.toLocaleString()}*\n\n🔫 ¡${perdedor.nombre} recibió la bala!`,
            mentions: [ganadorId, perdedorId]
          }, { quoted: msg });
        }, 4000);
        return;
      }
      if (args.length < 3) {
        await sock.sendMessage(chatId, { 
          text: `🎯 *RULETA RUSA*\n\n💡 **Uso:** #ruleta @usuario [cantidad]\n\n**Ejemplo:** #ruleta @amigo 1000\n\n🔫 **Reglas:**\n• Ambos apuestan la misma cantidad\n• 50% de probabilidad de ganar\n• El perdedor pierde su apuesta\n• El ganador se lleva todo\n\n💀 **Para aceptar:** #ruleta aceptar`
        }, { quoted: msg });
        return;
      }
      let objetivoId = null;
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (mentionedJid) {
        objetivoId = mentionedJid;
      } else {
        objetivoId = args[1].replace("@", "") + "@s.whatsapp.net";
      }
      const cantidad = parseInt(args[2]);
      if (objetivoId === senderId) {
        await sock.sendMessage(chatId, { text: "❌ No puedes desafiarte a ti mismo" }, { quoted: msg });
        return;
      }
      if (!usuarios[objetivoId]) {
        await sock.sendMessage(chatId, { text: "❌ Ese usuario no existe\n🎮 Debe usar algún comando primero" }, { quoted: msg });
        return;
      }
      if (isNaN(cantidad) || cantidad < 500) {
        await sock.sendMessage(chatId, { text: "❌ La apuesta mínima es *$500* coins universal" }, { quoted: msg });
        return;
      }
      if (user.dinero < cantidad) {
        await sock.sendMessage(chatId, { 
          text: `❌ No tienes suficiente dinero\n\n◉ Tienes: *$${user.dinero.toLocaleString()}*\n◊ Necesitas: *$${cantidad.toLocaleString()}*`
        }, { quoted: msg });
        return;
      }
      const objetivo = usuarios[objetivoId];
      if (objetivo.dinero < cantidad) {
        await sock.sendMessage(chatId, { 
          text: `❌ ${objetivo.nombre} no tiene suficiente dinero para esta apuesta`
        }, { quoted: msg });
        return;
      }
      objetivo.ruletaChallenge = { from: senderId, amount: cantidad, timestamp: Date.now() };
      guardarBD();
      await sock.sendMessage(chatId, { 
        text: `🎯 ¡DESAFÍO DE RULETA RUSA!\n\n🔫 ${user.nombre} desafía a ${objetivo.nombre}\n💰 Apuesta: *$${cantidad.toLocaleString()}* coins universal cada uno\n💀 Total en juego: *$${(cantidad * 2).toLocaleString()}*\n\n👤 @${objetivoId.split('@')[0]} tienes 5 minutos para aceptar\n💡 Usa: *#ruleta aceptar*`,
        mentions: [objetivoId]
      }, { quoted: msg });
      setTimeout(() => {
        if (objetivo.ruletaChallenge && objetivo.ruletaChallenge.from === senderId) {
          objetivo.ruletaChallenge = null;
          guardarBD();
        }
      }, 300000);
      return;
    }

    if (senderId === ADMIN_SUPREMO || senderId === ADMIN_SECUNDARIO) {
      // admin-only commands handled below
      return;
    }

    // comandos #addexp y #addmoney eliminados

  });
}

// Iniciar conexión con WhatsApp solo si NO se solicita omitirla vía env var
if (!process.env.SKIP_WA) {
  startBot();
} else {
  logger.info('SKIP_WA está definido; no se inicia la conexión a WhatsApp.');
}

if (process.env.START_WEB) {
  const app = express();

  app.get('/', (req, res) => {
    const rarezas = ['Común', 'Especial', 'Épica', 'Legendaria', 'Mítica', 'Ultra Mítica', 'Hecha por Dioses'];
    let espadasData = {};
    rarezas.forEach(rareza => {
      espadasData[rareza] = obtenerEspadasPorRareza(rareza).map(espada => {
        const poseedores = posesionesEspadas[espada.id] || 0;
        const totalUsuarios = Object.keys(usuarios).length;
        const precioDinamico = Math.floor(espada.precio * (totalUsuarios / (poseedores + 1)));
        return {
          id: espada.id,
          nombre: espada.nombre,
          precioBase: espada.precio,
          precioDinamico: precioDinamico,
          poder: espada.poder,
          poseedores: poseedores,
          descripcion: espada.descripcion
        };
      });
    });

    let html = `
<html>
<head>
  <title>Bot Supreme - Espadas</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background-color: #f4f4f4; }
    h1 { text-align: center; color: #333; }
    .rareza-btn { display: inline-block; margin: 10px; padding: 10px 20px; background-color: #007bff; color: white; border: none; cursor: pointer; border-radius: 5px; }
    .rareza-btn:hover { background-color: #0056b3; }
    .espada { border: 1px solid #ddd; margin: 10px; padding: 10px; background-color: white; border-radius: 5px; cursor: pointer; }
    .espada:hover { background-color: #f9f9f9; }
    #espadas-container { margin-top: 20px; }
  </style>
</head>
<body>
  <h1>Espadas Disponibles</h1>
  <div id="rareza-buttons">
    ${rarezas.map(r => `<button class="rareza-btn" onclick="showRareza('${r}')">${r}</button>`).join('')}
  </div>
  <div id="espadas-container"></div>

  <script>
    const espadasData = ${JSON.stringify(espadasData)};
    
    function showRareza(rareza) {
      const container = document.getElementById('espadas-container');
      const espadas = espadasData[rareza];
      container.innerHTML = '<h2>' + rareza + ' (' + espadas.length + ' espadas)</h2>' +
        espadas.map(e => 
          '<div class="espada" onclick="showPrecios(' + e.precioBase + ', ' + e.precioDinamico + ', \'' + e.nombre + '\')">' +
          '<h3>' + e.nombre + '</h3>' +
          '<p><strong>Poder:</strong> +' + e.poder.toLocaleString() + '</p>' +
          '<p><strong>Poseedores:</strong> ' + e.poseedores + '</p>' +
          '<p>' + e.descripcion + '</p>' +
          '</div>'
        ).join('');
    }
    
    function showPrecios(base, dinamico, nombre) {
      alert('Espada: ' + nombre + '\nPrecio más bajo (base): $' + base.toLocaleString() + '\nPrecio más alto (actual): $' + dinamico.toLocaleString());
    }
  </script>
</body>
</html>`;
    res.send(html);
  });

  app.listen(3000, () => {
    logger.info('Página web disponible en http://localhost:3000/');
  });
} else {
  logger.info('START_WEB no definido; la página web permanecerá inactiva.');
}

// --- MANEJO GLOBAL DE ERRORES NO CAPTURADOS ---
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`[GLOBAL] Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`[GLOBAL] Uncaught Exception: ${error.message}`);
  logger.error(error.stack);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('[SHUTDOWN] Señal SIGINT recibida, guardando datos...');
  try {
    guardarBD();
    persistRaffles();
    persistRetos();
    saveSeasons();
  } catch (e) {
    logger.error(`[SHUTDOWN] Error guardando datos: ${e.message}`);
  }
  process.exit(0);
});
