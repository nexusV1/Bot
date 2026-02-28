/**
 * @file data-manager.js
 * Gestor centralizado de datos con validación y backups
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class DataManager {
  constructor(dataDir = '.') {
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, 'backups');
    this._ensureBackupDir();
    logger.info('[DataManager] Inicializado');
  }

  /**
   * Crea el directorio de backups si no existe
   * @private
   */
  _ensureBackupDir() {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      logger.info(`[DataManager] Directorio de backups creado: ${this.backupDir}`);
    }
  }

  /**
   * Carga datos desde archivo JSON con validación
   * @param {string} filename - Nombre del archivo
   * @param {Object} defaultValue - Valor por defecto si hay error
   * @returns {Object} Datos cargados o valor por defecto
   */
  loadJSON(filename, defaultValue = {}) {
    const filepath = path.join(this.dataDir, filename);
    
    try {
      if (!fs.existsSync(filepath)) {
        logger.warn(`[DataManager] Archivo no encontrado: ${filename}`);
        return defaultValue;
      }

      const data = fs.readFileSync(filepath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Validación básica
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Datos no son un objeto válido');
      }

      logger.info(`[DataManager] Archivo cargado: ${filename} (${Object.keys(parsed).length} entradas)`);
      return parsed;
    } catch (error) {
      logger.error(`[DataManager] Error cargando ${filename}: ${error.message}`);
      
      // Intentar cargar backup más reciente
      const backup = this._loadLatestBackup(filename);
      if (backup) {
        logger.warn(`[DataManager] Usando backup para ${filename}`);
        return backup;
      }

      return defaultValue;
    }
  }

  /**
   * Guarda datos con backup automático
   * @param {string} filename - Nombre del archivo
   * @param {Object} data - Datos a guardar
   * @param {boolean} createBackup - Si crear backup antes de guardar
   * @returns {boolean} Éxito de la operación
   */
  saveJSON(filename, data, createBackup = true) {
    const filepath = path.join(this.dataDir, filename);

    try {
      // Crear backup si el archivo existe
      if (createBackup && fs.existsSync(filepath)) {
        this._createBackup(filepath);
      }

      // Escribir datos
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(filepath, json, 'utf8');
      
      logger.info(`[DataManager] Archivo guardado: ${filename}`);
      return true;
    } catch (error) {
      logger.error(`[DataManager] Error guardando ${filename}: ${error.message}`);
      return false;
    }
  }

  /**
   * Crea backup del archivo
   * @private
   */
  _createBackup(filepath) {
    try {
      const filename = path.basename(filepath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(this.backupDir, `${filename}.${timestamp}.bak`);
      
      fs.copyFileSync(filepath, backupPath);
      logger.info(`[DataManager] Backup creado: ${backupPath}`);

      // Limpiar backups antiguos (mantener últimos 10)
      this._cleanOldBackups(filename);
    } catch (error) {
      logger.error(`[DataManager] Error creando backup: ${error.message}`);
    }
  }

  /**
   * Carga el backup más reciente
   * @private
   */
  _loadLatestBackup(filename) {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith(filename))
        .sort()
        .reverse();

      if (files.length === 0) {
        logger.warn(`[DataManager] No hay backups para ${filename}`);
        return null;
      }

      const backupPath = path.join(this.backupDir, files[0]);
      const data = fs.readFileSync(backupPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      logger.error(`[DataManager] Error cargando backup: ${error.message}`);
      return null;
    }
  }

  /**
   * Limpia backups antiguos
   * @private
   */
  _cleanOldBackups(filename, keep = 10) {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith(filename))
        .sort()
        .reverse();

      if (files.length > keep) {
        for (let i = keep; i < files.length; i++) {
          const oldBackup = path.join(this.backupDir, files[i]);
          fs.unlinkSync(oldBackup);
          logger.info(`[DataManager] Backup antiguo eliminado: ${files[i]}`);
        }
      }
    } catch (error) {
      logger.error(`[DataManager] Error limpiando backups: ${error.message}`);
    }
  }

  /**
   * Valida integridad de datos
   * @param {Object} data - Datos a validar
   * @param {Array<string>} requiredFields - Campos requeridos
   * @returns {boolean}
   */
  validateData(data, requiredFields = []) {
    if (!data || typeof data !== 'object') {
      logger.warn('[DataManager] Datos no son un objeto válido');
      return false;
    }

    for (const field of requiredFields) {
      if (!(field in data)) {
        logger.warn(`[DataManager] Campo requerido faltante: ${field}`);
        return false;
      }
    }

    return true;
  }

  /**
   * Limpia datos corruptos
   * @param {Object} data - Datos a limpiar
   * @returns {Object} Datos limpios
   */
  cleanData(data) {
    try {
      const cleaned = JSON.parse(JSON.stringify(data));
      
      // Eliminar referencias circulares y valores inválidos
      Object.keys(cleaned).forEach(key => {
        if (cleaned[key] === undefined || cleaned[key] === null) {
          delete cleaned[key];
        }
        if (typeof cleaned[key] === 'number' && isNaN(cleaned[key])) {
          delete cleaned[key];
        }
      });

      logger.info('[DataManager] Datos limpiados');
      return cleaned;
    } catch (error) {
      logger.error(`[DataManager] Error limpiando datos: ${error.message}`);
      return data;
    }
  }
}

module.exports = DataManager;
