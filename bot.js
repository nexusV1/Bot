const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require("@whiskeysockets/baileys")
const fs = require("fs")
const sharp = require("sharp")

// Base de datos
let usuarios = {}
if (fs.existsSync("usuarios.json")) {
  usuarios = JSON.parse(fs.readFileSync("usuarios.json"))
}
function guardarBD() {
  fs.writeFileSync("usuarios.json", JSON.stringify(usuarios, null, 2))
}

// Sistema de rangos (simplificado por poder, ajusta valores a gusto)
function obtenerRangoClasificacion(poder) {
  if (poder < 500) return { rango: "Callejero", clasificacion: "C" }
  if (poder < 1500) return { rango: "Callejero", clasificacion: "B" }
  if (poder < 2500) return { rango: "Callejero", clasificacion: "A" }

  if (poder < 4000) return { rango: "Héroe", clasificacion: "C" }
  if (poder < 6000) return { rango: "Héroe", clasificacion: "B" }
  if (poder < 8000) return { rango: "Héroe", clasificacion: "A" }

  if (poder < 11000) return { rango: "Continental", clasificacion: "B" }
  if (poder < 15000) return { rango: "Continental", clasificacion: "A" }
  if (poder < 20000) return { rango: "Continental", clasificacion: "S" }

  if (poder < 30000) return { rango: "Planetario", clasificacion: "D" }
  if (poder < 45000) return { rango: "Planetario", clasificacion: "C" }
  if (poder < 60000) return { rango: "Planetario", clasificacion: "B" }
  if (poder < 80000) return { rango: "Planetario", clasificacion: "A" }
  if (poder < 100000) return { rango: "Planetario", clasificacion: "S" }

  if (poder < 150000) return { rango: "Estelar", clasificacion: "B" }
  if (poder < 200000) return { rango: "Estelar", clasificacion: "A" }
  if (poder < 300000) return { rango: "Estelar", clasificacion: "S" }

  if (poder < 400000) return { rango: "Universal", clasificacion: "A" }
  if (poder < 500000) return { rango: "Universal", clasificacion: "S" }

  if (poder < 700000) return { rango: "Infinity", clasificacion: "A" }
  if (poder < 900000) return { rango: "Infinity", clasificacion: "S" }

  if (poder < 1200000) return { rango: "Celestial", clasificacion: "S" }
  if (poder < 1500000) return { rango: "Eterno", clasificacion: "S" }
  if (poder < 2000000) return { rango: "Sester", clasificacion: "B" }
  if (poder < 2500000) return { rango: "Sester", clasificacion: "A" }
  if (poder < 3000000) return { rango: "Sester", clasificacion: "S" }

  if (poder < 4000000) return { rango: "Eterniti", clasificacion: "S" }
  if (poder < 5000000) return { rango: "Eterniun", clasificacion: "C" }
  if (poder < 6000000) return { rango: "Eterniun", clasificacion: "B" }
  if (poder < 7000000) return { rango: "Eterniun", clasificacion: "A" }
  return { rango: "Eterniun", clasificacion: "S" }
}

// Rayos divinos y sistema de administración
let rayosDivinos = {
  Omega: 70,
  Purgatorio: 20,
  Dios: 0
}

// Administrador supremo
const ADMIN_SUPREMO = "5492915112379@s.whatsapp.net"

// Base de datos de admins supremos
let adminsSupremos = {}
if (fs.existsSync("admins.json")) {
  adminsSupremos = JSON.parse(fs.readFileSync("admins.json"))
}
function guardarAdmins() {
  fs.writeFileSync("admins.json", JSON.stringify(adminsSupremos, null, 2))
}

// Control de reconexión para evitar múltiples sockets
let isReconnecting = false
let currentSocket = null
let pairingRequested = false

async function startBot() {
  // Limpiar socket anterior si existe
  if (currentSocket) {
    currentSocket.ev.removeAllListeners()
    currentSocket.end()
  }
  
  // Resetear flag de emparejamiento para nueva sesión
  pairingRequested = false
  
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false
  })
  
  currentSocket = sock

  sock.ev.on("creds.update", saveCreds)

  // Manejo de conexión y código de emparejamiento
  // Solicitar código de emparejamiento una sola vez
  if (!sock.authState.creds.registered && !pairingRequested) {
    pairingRequested = true
    console.log("\n🔗 Generando código de emparejamiento...")
    console.log("📱 Ve a WhatsApp > Configuración > Dispositivos vinculados > Vincular dispositivo")
    console.log("💡 Cuando te pida el código, úsalo para vincular este bot\n")
    
    try {
      // Esperar un momento para estabilizar conexión
      await new Promise(resolve => setTimeout(resolve, 2000))
      const pairingCode = await sock.requestPairingCode("5492915112379")
      console.log("🎯 CÓDIGO DE EMPAREJAMIENTO: " + pairingCode)
      console.log("💬 Usa este código en WhatsApp para vincular el bot a tu cuenta\n")
      console.log("📝 PASOS:")
      console.log("1. Abre WhatsApp en tu teléfono")
      console.log("2. Ve a Configuración > Dispositivos vinculados")
      console.log("3. Toca 'Vincular dispositivo'")
      console.log("4. Ingresa el código: " + pairingCode)
    } catch (error) {
      console.log("❌ Error generando código:", error.message)
      pairingRequested = false // Permitir reintentar
    }
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      console.log("❌ Conexión cerrada debido a:", lastDisconnect?.error)
      
      if (statusCode === 401) {
        console.log("🔐 Sesión expirada, limpiando autenticación...")
        pairingRequested = false // Permitir nueva solicitud de código
      } else if (!isReconnecting) {
        console.log("🔄 Reconectando...")
        isReconnecting = true
        setTimeout(() => {
          isReconnecting = false
          startBot()
        }, 3000)
      }
    } else if (connection === "open") {
      console.log("✅ ¡Bot conectado exitosamente a WhatsApp!")
      isReconnecting = false
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const chatId = msg.key.remoteJid
    const senderId = msg.key.participant || chatId
    
    // Ignorar mensajes de sistema/estado
    if (chatId.includes("status@broadcast") || chatId.includes("@newsletter")) return
    
    const body = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption ||
                 msg.message.videoMessage?.caption
    if (!body) return
    
    // Solo responder a comandos que empiecen con #
    if (!body.startsWith("#")) return

    // Registrar usuario (por remitente, no por chat)
    if (!usuarios[senderId]) {
      usuarios[senderId] = {
        nombre: senderId.split("@")[0],
        nivel: 1,
        poder: 100,
        rayo: null,
        ultimaDaily: 0,
        ultimoEntrenamiento: 0
      }
      guardarBD()
    }

    let user = usuarios[senderId]

    // Asegurar compatibilidad con usuarios existentes
    if (!user.ultimoEntrenamiento) {
      user.ultimoEntrenamiento = 0
    }

    // #menu - Menu mejorado
    if (body.startsWith("#menu") || body.startsWith("#help")) {
      const menu = `╔════════════════════════════╗
║        🤖 BOT MENU 🤖       ║
╚════════════════════════════╝

📋 COMANDOS BÁSICOS:
├ #menu - Mostrar este menú
├ #registrar [nombre] - Cambiar nombre
├ #perfil - Ver perfil
├ #rank - Top 10 usuarios
├ #info - Información del grupo

💪 ENTRENAMIENTO:
├ #entrenar - Entrenar poder (1 min cooldown)
└ #daily - Recompensa diaria

⚔️ COMBATE:
├ #duelo @usuario - Duelo
└ #s - Crear sticker (responder a foto)

🏆 RANGOS:
🥉 Callejero C/B/A
🥈 Héroe C/B/A  
🥇 Continental B/A/S
🌍 Planetario D/C/B/A/S
⭐ Estelar B/A/S
🌌 Universal A/S
♾️ Infinity A/S
👑 Celestial S
🔥 Eterno S
💎 Sester B/A/S
🌟 Eterniti S
⚡ Eterniun C/B/A/S
🌪️ Rayo Divino Purgatorio
🌊 Rayo Divino Omega
⚡ Dios

╔════════════════════════════╗
║       Creado por: L        ║
╚════════════════════════════╝`

      await sock.sendMessage(chatId, { text: menu })
    }

    // #registrar - Cambiar nombre
    if (body.startsWith("#registrar ")) {
      const nombreNuevo = body.split(" ").slice(1).join(" ").trim()
      if (!nombreNuevo || nombreNuevo.length < 2) {
        await sock.sendMessage(chatId, { text: "❌ Usa un nombre válido\n💡 Ejemplo: #registrar Mi Nombre" })
        return
      }
      
      if (nombreNuevo.length > 25) {
        await sock.sendMessage(chatId, { text: "❌ Nombre muy largo. Máximo 25 caracteres." })
        return
      }

      user.nombre = nombreNuevo
      guardarBD()
      await sock.sendMessage(chatId, { text: `✅ Tu nuevo nombre es: *${nombreNuevo}*` })
    }

    // #s - Crear sticker
    if (body.startsWith("#s")) {
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
      
      if (!quotedMsg) {
        await sock.sendMessage(chatId, { text: "❌ Responde a una foto con #s\n🎨 Para crear un sticker" })
        return
      }

      const imageMsg = quotedMsg.imageMessage
      if (!imageMsg) {
        await sock.sendMessage(chatId, { text: "❌ Solo puedo crear stickers de fotos\n🖼️ Responde a una imagen con #s" })
        return
      }

      try {
        // Construir mensaje completo para descargar
        const quotedMsgFull = {
          key: {
            remoteJid: chatId,
            id: msg.message.extendedTextMessage.contextInfo.stanzaId,
            participant: msg.message.extendedTextMessage.contextInfo.participant
          },
          message: quotedMsg
        }
        
        // Descargar el contenido
        const buffer = await downloadMediaMessage(quotedMsgFull, 'buffer', {})
        
        // Convertir imagen a webp para sticker válido
        const stickerBuffer = await sharp(buffer)
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp()
          .toBuffer()
        
        await sock.sendMessage(chatId, {
          sticker: stickerBuffer
        })
        
        await sock.sendMessage(chatId, { text: "✅ Sticker creado correctamente" })
      } catch (error) {
        console.log("Error creando sticker:", error)
        await sock.sendMessage(chatId, { text: "❌ Error creando el sticker\nInténtalo de nuevo" })
      }
    }

    // #entrenar - Entrenar con cooldown
    if (body.startsWith("#entrenar")) {
      const ahora = Date.now()
      const cooldown = 60000 // 1 minuto en milisegundos
      const tiempoRestante = user.ultimoEntrenamiento + cooldown - ahora
      
      if (tiempoRestante > 0) {
        const segundos = Math.ceil(tiempoRestante / 1000)
        await sock.sendMessage(chatId, { 
          text: `⏰ Descansa\n🔥 Podrás entrenar en *${segundos}* segundos` 
        })
        return
      }
      
      let exp = Math.floor(Math.random() * 500) + 200
      user.poder += exp
      user.nivel = Math.floor(user.poder / 1000) + 1
      user.ultimoEntrenamiento = ahora
      guardarBD()

      const { rango, clasificacion } = obtenerRangoClasificacion(user.poder)
      await sock.sendMessage(chatId, { 
        text: `⚡ Entrenamiento completado\n\n🔥 +${exp} de poder ganado\n💪 Poder total: ${user.poder}\n🏆 Rango: ${rango} ${clasificacion}` 
      })
    }

    // #daily - Recompensa diaria
    if (body.startsWith("#daily")) {
      let ahora = Date.now()
      if (ahora - user.ultimaDaily < 86400000) {
        const horasRestantes = Math.ceil((86400000 - (ahora - user.ultimaDaily)) / 3600000)
        await sock.sendMessage(chatId, { 
          text: `⏳ Ya reclamaste tu recompensa diaria\n🕐 Vuelve en ${horasRestantes} horas` 
        })
      } else {
        let recompensa = Math.floor(Math.random() * 2000) + 1000
        user.poder += recompensa
        user.nivel = Math.floor(user.poder / 1000) + 1
        user.ultimaDaily = ahora
        guardarBD()
        
        const { rango, clasificacion } = obtenerRangoClasificacion(user.poder)
        await sock.sendMessage(chatId, { 
          text: `🎉 Daily reclamado\n\n💰 +${recompensa} de poder ganado\n⚡ Poder total: ${user.poder}\n🏆 Rango: ${rango} ${clasificacion}` 
        })
      }
    }

    // #perfil - Ver perfil
    if (body.startsWith("#perfil")) {
      // Verificar si es el admin supremo
      if (senderId === ADMIN_SUPREMO) {
        user.rayo = "Dios"
        user.poder = Math.max(user.poder, 10000000) // Asegurar poder mínimo
        guardarBD()
      }
      
      let { rango, clasificacion } = obtenerRangoClasificacion(user.poder)
      
      // Override para rangos especiales
      if (senderId === ADMIN_SUPREMO) {
        rango = "Dios"
        clasificacion = "???"
      }
      
      let top = Object.values(usuarios).sort((a, b) => b.poder - a.poder)
      let posicion = top.findIndex(u => u === user) + 1
      
      // Determinar emoji de rango
      let rangoEmoji = "🥉"
      if (rango.includes("Héroe")) rangoEmoji = "🥈"
      else if (rango.includes("Continental")) rangoEmoji = "🥇"
      else if (rango.includes("Planetario")) rangoEmoji = "🌍"
      else if (rango.includes("Estelar")) rangoEmoji = "⭐"
      else if (rango.includes("Universal")) rangoEmoji = "🌌"
      else if (rango.includes("Infinity")) rangoEmoji = "♾️"
      else if (rango.includes("Celestial")) rangoEmoji = "👑"
      else if (rango.includes("Eterno")) rangoEmoji = "🔥"
      else if (rango.includes("Sester")) rangoEmoji = "💎"
      else if (rango.includes("Eterniti")) rangoEmoji = "🌟"
      else if (rango.includes("Eterniun")) rangoEmoji = "⚡"
      else if (rango.includes("Dios")) rangoEmoji = "⚡"

      let perfil = `╔════════════════════════════╗
║         👤 PERFIL 👤        ║
╚════════════════════════════╝

👤 **Usuario:** ${user.nombre}
📊 **Nivel:** ${user.nivel}
⚡ **Poder:** ${user.poder.toLocaleString()}
${rangoEmoji} **Rango:** ${rango}
🏅 **Clasificación:** ${clasificacion}
🏆 **Posición Global:** #${posicion}
⚔️ **Rayo Divino:** ${user.rayo || "🚫 Ninguno"}`

      // Try to get profile picture
      try {
        const profilePic = await sock.profilePictureUrl(senderId, 'image')
        await sock.sendMessage(chatId, {
          image: { url: profilePic },
          caption: perfil
        })
      } catch (error) {
        // If no profile picture, send text only
        await sock.sendMessage(chatId, { text: perfil })
      }
    }

    // #rank - Top 10 usuarios
    if (body.startsWith("#rank")) {
      let top = Object.values(usuarios).sort((a, b) => b.poder - a.poder).slice(0, 10)
      let ranking = `╔════════════════════════════╗
║        🏆 TOP 10 🏆       ║
╚════════════════════════════╝

`
      
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
      
      top.forEach((u, i) => {
        let { rango, clasificacion } = obtenerRangoClasificacion(u.poder)
        let medal = medals[i] || `${i + 1}️⃣`
        ranking += `${medal} **${u.nombre}**\n   ⚡ ${u.poder.toLocaleString()} | 🏅 ${rango} ${clasificacion}\n\n`
      })
      
      await sock.sendMessage(chatId, { text: ranking })
    }

    // #duelo - Duelo
    if (body.startsWith("#duelo")) {
      // Buscar objetivo en mentions o parsearlo del texto
      let enemigoId = null
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
      
      if (mentionedJid) {
        enemigoId = mentionedJid
      } else {
        let partes = body.split(" ")
        if (partes.length < 2) {
          await sock.sendMessage(chatId, { text: "❌ Usa: #duelo @usuario\n⚔️ Menciona al usuario" })
          return
        }
        enemigoId = partes[1].replace("@", "") + "@s.whatsapp.net"
      }
      
      // Validaciones
      if (enemigoId === senderId) {
        await sock.sendMessage(chatId, { text: "❌ No puedes duelarte contra ti mismo" })
        return
      }
      
      if (!usuarios[enemigoId]) {
        await sock.sendMessage(chatId, { text: "❌ Ese usuario no existe\n🎮 Debe usar algún comando primero" })
        return
      }

      let enemigo = usuarios[enemigoId]
      
      const battleText = `⚔️ Duelo iniciado\n\n🔥 ${user.nombre} (${user.poder.toLocaleString()}⚡)\n        VS\n🔥 ${enemigo.nombre} (${enemigo.poder.toLocaleString()}⚡)\n\n⏳ Combatiendo...`
      
      await sock.sendMessage(chatId, { 
        text: battleText,
        mentions: [senderId, enemigoId]
      })
      
      // Wait for dramatic effect
      setTimeout(async () => {
        let ganador = Math.random() > 0.5 ? user : enemigo
        let perdedor = ganador === user ? enemigo : user
        let ganadorId = ganador === user ? senderId : enemigoId
        let perdedorId = perdedor === user ? senderId : enemigoId

        let recompensa = Math.floor(Math.random() * 1500) + 500
        ganador.poder += recompensa
        ganador.nivel = Math.floor(ganador.poder / 1000) + 1
        guardarBD()
        
        const { rango: rangoGanador, clasificacion: clasifGanador } = obtenerRangoClasificacion(ganador.poder)

        const resultText = `🏆 Resultado del duelo\n\n👑 **Ganador:** ${ganador.nombre}\n💰 **Recompensa:** +${recompensa.toLocaleString()} poder\n⚡ **Poder total:** ${ganador.poder.toLocaleString()}\n🏅 **Nuevo rango:** ${rangoGanador} ${clasifGanador}\n\n💔 **Derrotado:** ${perdedor.nombre}`

        await sock.sendMessage(chatId, { 
          text: resultText,
          mentions: [ganadorId, perdedorId]
        })
      }, 3000)
    }
    // #info - Información del grupo
    if (body.startsWith("#info")) {
      const ahora = new Date()
      const hora = ahora.toLocaleTimeString('es-ES')
      const fecha = ahora.toLocaleDateString('es-ES')
      
      let nombreGrupo = "Chat privado"
      let cantidadBots = 1
      let cantidadAdmins = Object.keys(adminsSupremos).length
      
      // Si es un grupo, obtener información
      if (chatId.includes("@g.us")) {
        try {
          const groupInfo = await sock.groupMetadata(chatId)
          nombreGrupo = groupInfo.subject
        } catch (error) {
          nombreGrupo = "Grupo"
        }
      }
      
      const info = `📊 **INFORMACIÓN**\n\n🏷️ **Grupo:** ${nombreGrupo}\n🕐 **Hora:** ${hora}\n📅 **Fecha:** ${fecha}\n🤖 **Bots:** ${cantidadBots}\n👑 **Admins Supremos:** ${cantidadAdmins}`
      
      await sock.sendMessage(chatId, { text: info })
    }
    
    // Comandos de admin supremo
    if (senderId === ADMIN_SUPREMO) {
      // #dar_rayo_purgatorio
      if (body.startsWith("#dar_rayo_purgatorio")) {
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentionedJid) {
          await sock.sendMessage(chatId, { text: "❌ Menciona al usuario" })
          return
        }
        
        if (!usuarios[mentionedJid]) {
          await sock.sendMessage(chatId, { text: "❌ Usuario no encontrado" })
          return
        }
        
        usuarios[mentionedJid].rayo = "Purgatorio"
        usuarios[mentionedJid].poder = Math.max(usuarios[mentionedJid].poder, 5000000)
        guardarBD()
        
        await sock.sendMessage(chatId, { 
          text: `🌪️ Rayo Divino Purgatorio otorgado a ${usuarios[mentionedJid].nombre}`,
          mentions: [mentionedJid]
        })
      }
      
      // #dar_rayo_omega
      if (body.startsWith("#dar_rayo_omega")) {
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentionedJid) {
          await sock.sendMessage(chatId, { text: "❌ Menciona al usuario" })
          return
        }
        
        if (!usuarios[mentionedJid]) {
          await sock.sendMessage(chatId, { text: "❌ Usuario no encontrado" })
          return
        }
        
        usuarios[mentionedJid].rayo = "Omega"
        usuarios[mentionedJid].poder = Math.max(usuarios[mentionedJid].poder, 8000000)
        guardarBD()
        
        await sock.sendMessage(chatId, { 
          text: `🌊 Rayo Divino Omega otorgado a ${usuarios[mentionedJid].nombre}`,
          mentions: [mentionedJid]
        })
      }
      
      // #dar_admin_supremo
      if (body.startsWith("#dar_admin_supremo")) {
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentionedJid) {
          await sock.sendMessage(chatId, { text: "❌ Menciona al usuario" })
          return
        }
        
        adminsSupremos[mentionedJid] = {
          nombre: usuarios[mentionedJid]?.nombre || mentionedJid.split("@")[0],
          otorgadoPor: "Administrador Supremo",
          fecha: new Date().toLocaleDateString('es-ES')
        }
        guardarAdmins()
        
        await sock.sendMessage(chatId, { 
          text: `👑 Admin Supremo otorgado a ${adminsSupremos[mentionedJid].nombre}`,
          mentions: [mentionedJid]
        })
      }
      
      // #dar_rayo_dios
      if (body.startsWith("#dar_rayo_dios")) {
        const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        if (!mentionedJid) {
          await sock.sendMessage(chatId, { text: "❌ Menciona al usuario" })
          return
        }
        
        if (!usuarios[mentionedJid]) {
          await sock.sendMessage(chatId, { text: "❌ Usuario no encontrado" })
          return
        }
        
        usuarios[mentionedJid].rayo = "Dios"
        usuarios[mentionedJid].poder = Math.max(usuarios[mentionedJid].poder, 10000000)
        guardarBD()
        
        await sock.sendMessage(chatId, { 
          text: `⚡ Rayo Divino Dios otorgado a ${usuarios[mentionedJid].nombre}`,
          mentions: [mentionedJid]
        })
      }
    }
  })
}

startBot()
