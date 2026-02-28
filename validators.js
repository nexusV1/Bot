/**
 * @file validators.js
 * Validadores centralizados para comandos del bot
 */

const logger = require('./logger');

/**
 * Valida que un usuario exista y esté registrado
 * @param {Object} usuarios - Objeto de usuarios
 * @param {string} userId - ID del usuario a validar
 * @param {string} chatId - ID del chat (para respuesta)
 * @param {Object} sock - Socket para enviar mensajes
 * @param {Object} msg - Mensaje original
 * @returns {Promise<boolean|Object>} Usuario si válido, false si no
 */
async function validateUserExists(usuarios, userId, chatId, sock, msg) {
  if (!usuarios[userId]) {
    await sock.sendMessage(chatId, { 
      text: '❌ No estás registrado. Usa #registrar [nombre] para comenzar.' 
    }, { quoted: msg });
    logger.warn(`[Validator] Usuario no encontrado: ${userId}`);
    return false;
  }
  return usuarios[userId];
}

/**
 * Valida que un usuario tenga suficiente dinero
 * @param {Object} usuario - Objeto del usuario
 * @param {number} cantidad - Cantidad requerida
 * @param {string} chatId - ID del chat
 * @param {Object} sock - Socket
 * @param {Object} msg - Mensaje original
 * @returns {Promise<boolean>}
 */
async function validateMoney(usuario, cantidad, chatId, sock, msg) {
  if ((usuario.dinero || 0) < cantidad) {
    const faltante = cantidad - (usuario.dinero || 0);
    await sock.sendMessage(chatId, { 
      text: `❌ No tienes suficiente dinero. Te faltan $${faltante.toLocaleString()}` 
    }, { quoted: msg });
    logger.warn(`[Validator] Dinero insuficiente para ${usuario.nombre}`);
    return false;
  }
  return true;
}

/**
 * Valida que un usuario tenga suficientes items
 * @param {Object} usuario - Objeto del usuario
 * @param {string} itemId - ID del item
 * @param {number} cantidad - Cantidad requerida
 * @param {string} chatId - ID del chat
 * @param {Object} sock - Socket
 * @param {Object} msg - Mensaje original
 * @returns {Promise<boolean>}
 */
async function validateInventoryItem(usuario, itemId, cantidad, chatId, sock, msg) {
  const tengo = usuario.inventario?.[itemId] || 0;
  if (tengo < cantidad) {
    await sock.sendMessage(chatId, { 
      text: `❌ No tienes suficientes ${itemId}. Tienes ${tengo}, necesitas ${cantidad}` 
    }, { quoted: msg });
    logger.warn(`[Validator] Item insuficiente: ${usuario.nombre} necesita ${itemId}`);
    return false;
  }
  return true;
}

/**
 * Valida que un usuario tenga nivel suficiente
 * @param {Object} usuario - Objeto del usuario
 * @param {number} nivelRequerido - Nivel mínimo
 * @param {string} chatId - ID del chat
 * @param {Object} sock - Socket
 * @param {Object} msg - Mensaje original
 * @returns {Promise<boolean>}
 */
async function validateLevel(usuario, nivelRequerido, chatId, sock, msg) {
  const nivelActual = usuario.nivel || 1;
  if (nivelActual < nivelRequerido) {
    await sock.sendMessage(chatId, { 
      text: `❌ Necesitas nivel ${nivelRequerido}. Tu nivel actual: ${nivelActual}` 
    }, { quoted: msg });
    logger.warn(`[Validator] Nivel insuficiente: ${usuario.nombre}`);
    return false;
  }
  return true;
}

/**
 * Valida que un usuario tenga poder suficiente
 * @param {Object} usuario - Objeto del usuario
 * @param {number} poderRequerido - Poder mínimo
 * @param {string} chatId - ID del chat
 * @param {Object} sock - Socket
 * @param {Object} msg - Mensaje original
 * @returns {Promise<boolean>}
 */
async function validatePower(usuario, poderRequerido, chatId, sock, msg) {
  const poderActual = usuario.poder || 0;
  if (poderActual < poderRequerido) {
    await sock.sendMessage(chatId, { 
      text: `❌ Necesitas ${poderRequerido} de poder. Tu poder actual: ${poderActual}` 
    }, { quoted: msg });
    logger.warn(`[Validator] Poder insuficiente: ${usuario.nombre}`);
    return false;
  }
  return true;
}

/**
 * Valida cooldown de comando
 * @param {Object} usuario - Objeto del usuario
 * @param {string} commandKey - Clave del comando (ej: 'lastWork', 'lastBoss')
 * @param {number} cooldownMs - Cooldown en milisegundos
 * @param {string} chatId - ID del chat
 * @param {Object} sock - Socket
 * @param {Object} msg - Mensaje original
 * @returns {Promise<boolean>}
 */
async function validateCooldown(usuario, commandKey, cooldownMs, chatId, sock, msg) {
  const ahora = Date.now();
  const ultimaVez = usuario[commandKey] || 0;
  const tiempoTranscurrido = ahora - ultimaVez;

  if (tiempoTranscurrido < cooldownMs) {
    const tiempoFaltante = Math.ceil((cooldownMs - tiempoTranscurrido) / 1000);
    const minutos = Math.floor(tiempoFaltante / 60);
    const segundos = tiempoFaltante % 60;
    
    let tiempoTexto = '';
    if (minutos > 0) tiempoTexto += `${minutos}m `;
    tiempoTexto += `${segundos}s`;

    await sock.sendMessage(chatId, { 
      text: `⏳ Espera ${tiempoTexto} antes de intentar de nuevo.` 
    }, { quoted: msg });
    logger.warn(`[Validator] Cooldown activo: ${usuario.nombre}`);
    return false;
  }
  return true;
}

/**
 * Valida que el parámetro sea un número válido
 * @param {string} param - Parámetro a validar
 * @param {string} chatId - ID del chat
 * @param {Object} sock - Socket
 * @param {Object} msg - Mensaje original
 * @returns {Promise<number|false>}
 */
async function validateNumber(param, chatId, sock, msg) {
  const num = parseInt(param);
  if (isNaN(num) || num <= 0) {
    await sock.sendMessage(chatId, { 
      text: '❌ Debes ingresar un número válido mayor a 0' 
    }, { quoted: msg });
    return false;
  }
  return num;
}

/**
 * Valida que un usuario tenga una facción
 * @param {Object} usuario - Objeto del usuario
 * @param {string} chatId - ID del chat
 * @param {Object} sock - Socket
 * @param {Object} msg - Mensaje original
 * @returns {Promise<boolean>}
 */
async function validateFaction(usuario, chatId, sock, msg) {
  if (!usuario.faccion) {
    await sock.sendMessage(chatId, { 
      text: '❌ No perteneces a ninguna facción. Usa #joinfaction [id]' 
    }, { quoted: msg });
    return false;
  }
  return true;
}

module.exports = {
  validateUserExists,
  validateMoney,
  validateInventoryItem,
  validateLevel,
  validatePower,
  validateCooldown,
  validateNumber,
  validateFaction
};
