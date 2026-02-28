/**
 * Configuración centralizada del bot
 */

module.exports = {
  // --- RUTAS DE ARCHIVOS ---
  PATHS: {
    FRAGMENTOS: 'fragmentos.json',
    COFRES_LLAVES: 'cofres_llaves.json',
    ABUSO: 'abuso_historial.json',
    DESTINO: 'destino_eventos.json',
    TITULOS: 'titulos.json',
    BOSSES: 'bosses.json',
    USUARIOS: 'usuarios.json',
    CLANES: 'clanes.json',
    RAIDS: 'raids.json',
    SEASON_META: 'season_meta.json',
    SEASONS: 'seasons.json',
    QUESTS: 'quests.json',
    TRIVIAS: 'trivias.json',
    TOURNAMENTS: 'tournaments.json',
    EVENTS: 'events.json',
    BOSS_SPAWN_CONFIG: 'boss_spawn_config.json',
    SOCIAL_CONFIG: 'socialConfig.json',
    DB: 'bot.sqlite',
    AUTH_DIR: 'auth/'
  },

  // --- TIEMPOS (en milisegundos) ---
  TIMEOUTS: {
    SUBASTA_DURACION: 10 * 60 * 1000,  // 10 minutos
    RAID_COOLDOWN: 10 * 60 * 1000,     // 10 minutos
    EXPEDICION_COOLDOWN: 2 * 60 * 60 * 1000, // 2 horas
    EVENTO_DURACION: 60 * 60 * 1000,   // 1 hora
    TRIVIA_TIMEOUT: 60 * 1000,         // 60 segundos
    SEASON_AUTO_CHECK: 60 * 60 * 1000, // 1 hora
    BOSS_SPAWN_COOLDOWN: 6 * 60 * 60 * 1000, // 6 horas
  },

  // --- RARITY LEVELS ---
  RARITY: {
    COMUN: 'comun',
    POCO_COMUN: 'poco_comun',
    RARO: 'raro',
    EPICO: 'epico',
    LEGENDARIO: 'legendario',
    MITICO: 'mitico',
    ABSOLUTO: 'absoluto'
  },

  // --- BOSS TYPES ---
  BOSS_TYPES: {
    NORMAL: 'normal',
    EPIC: 'epico',
    LEGENDARY: 'legendario',
    DIVINE: 'divino'
  },

  // --- PROBABILIDADES (0-1) ---
  PROBABILITIES: {
    COFRE_COMUN: 0.7,
    COFRE_RARO: 0.5,
    LLAVE_COMUN: 0.5,
    LLAVE_DORADA: 0.4,
    FRAGMENTO_COMUN: 0.1,
    FRAGMENTO_EPICO: 0.2,
    CRAFT_SUCCESS: 0.5,
    CRIT_BASE: 0.15
  },

  // --- MULTIPLICADORES Y BONOS ---
  MULTIPLIERS: {
    EXP_PER_LEVEL: 1.5,
    POWER_PER_LEVEL: 25,
    DINERO_MULTIPLIER: 1.2,
    CRAFT_POWER: {
      espada_legendaria: 2000,
      armadura_fuerte: 900
    }
  },

  // --- LÍMITES ---
  LIMITS: {
    MAX_COOLDOWN_DAYS: 30,
    MAX_MESSAGE_LENGTH: 4096,
    MAX_CLAN_MEMBERS: 50,
    MAX_TOURNAMENT_PARTICIPANTS: 100,
    PUNTOS_GANARPUNTOS_MAX_PER_CALL: 50,
    PUNTOS_GANARPUNTOS_MAX_PER_HOUR: 500
  },

  // --- INVENTARIO ---
  INVENTORY_TYPES: {
    FRAGMENTOS: 'fragmentos',
    COFRES: 'cofres',
    LLAVES: 'llaves'
  },

  // --- SEASONAL RANKS ---
  SEASON_RANKS: {
    BRONCE: { min: 0, max: 100, nombre: 'Bronce' },
    PLATA: { min: 100, max: 300, nombre: 'Plata' },
    ORO: { min: 300, max: 600, nombre: 'Oro' },
    DIAMANTE: { min: 600, max: 1000, nombre: 'Diamante' },
    LEYENDA: { min: 1000, max: Infinity, nombre: 'Leyenda' }
  },

  // --- SKILL COSTS ---
  SKILLS: {
    forjador: { cost: 1, desc: 'Aumenta éxito al craft' },
    guerrero: { cost: 1, desc: '+10% daño en raids' }
  }
};
