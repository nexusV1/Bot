/**
 * @file constants.js
 * Constantes centralizadas para evitar hardcoding de strings
 */

module.exports = {
  // Atributos de usuario
  USER_ATTRIBUTES: {
    PODER: 'poder',
    DINERO: 'dinero',
    NIVEL: 'nivel',
    EXP: 'exp',
    SALUD: 'salud'
  },

  // Tipos de inventario
  INVENTORY_TYPES: {
    FRAGMENTOS: 'fragmentos',
    COFRES: 'cofres',
    LLAVES: 'llaves',
    ITEMS: 'items',
    ARMAS: 'armas'
  },

  // Estados de combate
  COMBAT_STATES: {
    GANADO: 'ganado',
    PERDIDO: 'perdido',
    EMPATE: 'empate'
  },

  // Cooldowns (en milisegundos)
  COOLDOWNS: {
    WORK: 3 * 60 * 1000,        // 3 minutos
    HUNT: 5 * 60 * 1000,        // 5 minutos
    FIGHT: 2 * 60 * 1000,       // 2 minutos
    BOSS: 10 * 60 * 1000,       // 10 minutos
    DAILY: 24 * 60 * 60 * 1000  // 24 horas
  },

  // Rareza de items
  RARITIES: {
    COMUN: 'comun',
    RARO: 'raro',
    EPICO: 'epico',
    LEGENDARIO: 'legendario',
    DIOSES: 'dioses'
  },

  // Multiplicadores de daño por rareza
  DAMAGE_MULTIPLIERS: {
    comun: 1.25,
    raro: 2.0,
    epico: 3.5,
    legendario: 7.5,
    dioses: 15.0
  },

  // Mensajes comunes
  MESSAGES: {
    INVALID_USER: '❌ No estás registrado. Usa #registrar [nombre]',
    INSUFFICIENT_MONEY: '❌ No tienes suficiente dinero',
    INSUFFICIENT_ITEMS: '❌ No tienes suficientes items',
    INSUFFICIENT_LEVEL: '❌ Nivel insuficiente',
    INSUFFICIENT_POWER: '❌ Poder insuficiente',
    COOLDOWN_ACTIVE: '⏳ Debes esperar antes de intentar de nuevo',
    NOT_IN_FACTION: '❌ No perteneces a ninguna facción',
    SUCCESS: '✅ Acción realizada con éxito',
    ERROR: '❌ Ocurrió un error'
  },

  // Tipos de eventos
  EVENT_TYPES: {
    MONEY_GAIN: 'money_gain',
    MONEY_LOSS: 'money_loss',
    ITEM_GAIN: 'item_gain',
    ITEM_LOSS: 'item_loss',
    LEVEL_UP: 'level_up',
    COMBAT_WIN: 'combat_win',
    COMBAT_LOSS: 'combat_loss',
    BOSS_DEFEAT: 'boss_defeat'
  },

  // Límites de juego
  LIMITS: {
    MAX_LEVEL: 9999,
    MAX_INVENTORY_ITEMS: 100,
    MIN_BET_DUEL: 100,
    MAX_BET_DUEL: 1000000,
    TOP_RANKING_SIZE: 50,
    BACKUPS_TO_KEEP: 10
  }
};
