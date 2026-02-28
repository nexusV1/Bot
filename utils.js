/**
 * Utilidades comunes del bot
 */
const logger = require('./logger');

class Utils {
  /**
   * Obtiene un elemento aleatorio de un array
   */
  static randomElement(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Genera un ID único basado en timestamp y número aleatorio
   */
  static generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Calcula el tiempo restante en minutos
   */
  static getMinutesRemaining(endTime) {
    return Math.max(0, Math.floor((endTime - Date.now()) / 60000));
  }

  /**
   * Calcula el tiempo restante en segundos
   */
  static getSecondsRemaining(endTime) {
    return Math.max(0, Math.floor((endTime - Date.now()) / 1000));
  }

  /**
   * Genera un código aleatorio de N dígitos
   */
  static generateRandomCode(length = 8) {
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += alpha[Math.floor(Math.random() * alpha.length)];
    }
    return result;
  }

  /**
   * Realiza un rollDado de probabilidad
   */
  static rollChance(probability) {
    return Math.random() < probability;
  }

  /**
   * Calcula daño aleatorio basado en poder
   */
  static calculateRandomDamage(basePower, minMultiplier = 0.1, maxMultiplier = 1.2) {
    const multiplier = minMultiplier + Math.random() * (maxMultiplier - minMultiplier);
    return Math.max(1, Math.floor(basePower * multiplier));
  }

  /**
   * Valida si un ID de usuario es válido
   */
  static isValidUserId(userId) {
    return userId && typeof userId === 'string' && userId.includes('@');
  }

  /**
   * Extrae el nombre de un usuario de su JID
   */
  static extractUsername(jid) {
    if (!jid || typeof jid !== 'string') return 'usuario';
    return jid.split('@')[0];
  }

  /**
   * Formatea un número con separadores de miles
   */
  static formatNumber(num) {
    if (typeof num !== 'number') return '0';
    return num.toLocaleString('es-ES');
  }

  /**
   * Formatea dinero
   */
  static formatCurrency(amount) {
    return `$${this.formatNumber(amount)}`;
  }

  /**
   * Clona un objeto profundamente
   */
  static deepClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      logger.warn(`[Utils] Error al clonar objeto: ${e.message}`);
      return obj;
    }
  }

  /**
   * Obtiene o crea una propiedad anidada en un objeto
   */
  static getOrCreate(obj, keys, defaultValue = {}) {
    let current = obj;
    for (const key of keys.slice(0, -1)) {
      if (!current[key]) current[key] = {};
      current = current[key];
    }
    const lastKey = keys[keys.length - 1];
    if (!current[lastKey]) current[lastKey] = defaultValue;
    return current[lastKey];
  }

  /**
   * Verifica si un objeto está vacío
   */
  static isEmpty(obj) {
    if (!obj) return true;
    return Object.keys(obj).length === 0;
  }

  /**
   * Cuenta objetos en un objeto (excluyendo funciones)
   */
  static countObjectEntries(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    return Object.keys(obj).filter(k => typeof obj[k] !== 'function').length;
  }

  /**
   * Suma valores de un objeto
   */
  static sumObjectValues(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    return Object.values(obj).reduce((sum, val) => {
      const num = typeof val === 'number' ? val : 0;
      return sum + num;
    }, 0);
  }

  /**
   * Ordena un array de objetos por una propiedad
   */
  static sortByProperty(arr, property, ascending = true) {
    if (!Array.isArray(arr)) return [];
    return [...arr].sort((a, b) => {
      const aVal = a[property] ?? 0;
      const bVal = b[property] ?? 0;
      return ascending ? aVal - bVal : bVal - aVal;
    });
  }

  /**
   * Pausa la ejecución
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Manejo seguro de parseo JSON
   */
  static safeJsonParse(str, defaultValue = null) {
    try {
      return JSON.parse(str);
    } catch (e) {
      logger.warn(`[Utils] Error parseando JSON: ${e.message}`);
      return defaultValue;
    }
  }

  /**
   * Trunca un texto a un máximo de caracteres
   */
  static truncate(text, maxLength = 100) {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Valida un rango numérico
   */
  static validateRange(value, min, max, defaultValue) {
    const num = Number(value);
    if (isNaN(num)) return defaultValue;
    return Math.max(min, Math.min(max, num));
  }

  /**
   * Carga un archivo JSON de forma segura
   * @param {string} filePath - Ruta del archivo
   * @param {object} defaultValue - Valor por defecto si no existe o hay error
   * @returns {object} Objeto parseado o valor por defecto
   */
  static loadJsonFile(filePath, defaultValue = {}) {
    const fs = require('fs');
    try {
      if (!fs.existsSync(filePath)) {
        return defaultValue;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      logger.warn(`[Utils] Error cargando ${filePath}: ${e.message}`);
      return defaultValue;
    }
  }

  /**
   * Guarda un objeto como JSON en un archivo
   * @param {string} filePath - Ruta del archivo
   * @param {object} obj - Objeto a guardar
   * @returns {boolean} true si fue exitoso
   */
  static saveJsonFile(filePath, obj) {
    const fs = require('fs');
    try {
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
      return true;
    } catch (e) {
      logger.warn(`[Utils] Error guardando ${filePath}: ${e.message}`);
      return false;
    }
  }
}

module.exports = Utils;
