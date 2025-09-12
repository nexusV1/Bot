const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const fs = require("fs")

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

// Rayos divinos (admin otorga manualmente con comando)
let rayosDivinos = {
  Omega: 70,
  Purgatorio: 20,
  Dios: 0
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
    printQRInTerminal: true // Activar QR code como alternativa
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
      const pairingCode = await sock.requestPairingCode("542915268762")
      console.log("🎯 CÓDIGO DE EMPAREJAMIENTO: " + pairingCode)
      console.log("💬 Usa este código en WhatsApp para vincular el bot a tu cuenta\n")
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

    // Asegurar compatibilidad con usuarios existentes
    if (!user.ultimoEntrenamiento) {
      user.ultimoEntrenamiento = 0
    }

    let user = usuarios[senderId]

    // #menu - Ultra stylish menu
    if (body.startsWith("#menu") || body.startsWith("#help")) {
      const menu = `╔══════════════════════════════╗
║    🌟 IMPERIO TRIPLE X 🌟     ║
║        DOMINA SIEMPRE         ║
╚══════════════════════════════╝

⚡ ═══════ COMANDOS ÉPICOS ═══════ ⚡

🎮 BÁSICOS:
├ #menu - Mostrar este menú épico
├ #registrar [nombre] - Cambia tu nombre
├ #perfil - Tu perfil de guerrero
└ #rank - Top 10 guerreros

💪 ENTRENAMIENTO:
├ #entrenar - Entrena tu poder (1 min cooldown)
└ #daily - Recompensa diaria épica

⚔️ COMBATE:
├ #duelo @usuario - Duelo épico
└ #s - Crear sticker épico (responde a foto/video)

🏆 RANGOS DISPONIBLES:
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

╔══════════════════════════════╗
║     💫 CREADO POR: L 💫      ║
║   Imperio Triple X Domina    ║
╚══════════════════════════════╝`

      await sock.sendMessage(chatId, { text: menu })
    }

    // #registrar - Custom name registration
    if (body.startsWith("#registrar ")) {
      const nombreNuevo = body.split(" ").slice(1).join(" ").trim()
      if (!nombreNuevo || nombreNuevo.length < 2) {
        await sock.sendMessage(chatId, { text: "❌ ¡Usa un nombre válido!\n💡 Ejemplo: #registrar Mi Nombre Épico" })
        return
      }
      
      if (nombreNuevo.length > 25) {
        await sock.sendMessage(chatId, { text: "❌ ¡Nombre muy largo! Máximo 25 caracteres." })
        return
      }

      user.nombre = nombreNuevo
      guardarBD()
      await sock.sendMessage(chatId, { text: `🎉 ¡ÉPICO! Tu nuevo nombre es: *${nombreNuevo}*\n⚡ ¡Ahora eres más poderoso que nunca!` })
    }

    // #s - Sticker creation
    if (body.startsWith("#s")) {
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
      
      if (!quotedMsg) {
        await sock.sendMessage(chatId, { text: "❌ ¡Responde a una foto o video con #s!\n🎨 ¡Crea tu sticker épico del Imperio!" })
        return
      }

      const imageMsg = quotedMsg.imageMessage || quotedMsg.videoMessage
      if (!imageMsg) {
        await sock.sendMessage(chatId, { text: "❌ ¡Solo puedo crear stickers de fotos o videos!\n🖼️ Responde a una imagen con #s" })
        return
      }

      try {
        // Download the media
        const mediaKey = quotedMsg.imageMessage || quotedMsg.videoMessage
        const stickerName = `${user.nombre} - Imperio Triple X Domina Neko Caerá`
        
        await sock.sendMessage(chatId, {
          sticker: { url: imageMsg.url },
          packName: "Imperio Triple X",
          authorName: stickerName
        })
        
        await sock.sendMessage(chatId, { text: "🎨 ¡STICKER ÉPICO CREADO!\n👑 Imperio Triple X Domina Siempre" })
      } catch (error) {
        await sock.sendMessage(chatId, { text: "❌ Error creando el sticker\n🔥 ¡Inténtalo de nuevo, guerrero!" })
      }
    }

    // #entrenar - Enhanced with cooldown
    if (body.startsWith("#entrenar")) {
      const ahora = Date.now()
      const cooldown = 60000 // 1 minuto en milisegundos
      const tiempoRestante = user.ultimoEntrenamiento + cooldown - ahora
      
      if (tiempoRestante > 0) {
        const segundos = Math.ceil(tiempoRestante / 1000)
        await sock.sendMessage(chatId, { 
          text: `⏰ ¡Descansa, guerrero!\n🔥 Podrás entrenar en *${segundos}* segundos\n💪 ¡El poder requiere paciencia!` 
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
        text: `⚡ ¡ENTRENAMIENTO ÉPICO COMPLETADO! ⚡\n\n🔥 +${exp} de poder ganado\n💪 Poder total: ${user.poder}\n🏆 Rango: ${rango} ${clasificacion}\n\n👑 ¡Imperio Triple X Domina!` 
      })
    }

    // #daily - Enhanced daily rewards
    if (body.startsWith("#daily")) {
      let ahora = Date.now()
      if (ahora - user.ultimaDaily < 86400000) {
        const horasRestantes = Math.ceil((86400000 - (ahora - user.ultimaDaily)) / 3600000)
        await sock.sendMessage(chatId, { 
          text: `⏳ ¡Ya reclamaste tu recompensa diaria!\n🕐 Vuelve en ${horasRestantes} horas\n💎 ¡Las mejores recompensas te esperan!` 
        })
      } else {
        let recompensa = Math.floor(Math.random() * 2000) + 1000
        user.poder += recompensa
        user.nivel = Math.floor(user.poder / 1000) + 1
        user.ultimaDaily = ahora
        guardarBD()
        
        const { rango, clasificacion } = obtenerRangoClasificacion(user.poder)
        await sock.sendMessage(chatId, { 
          text: `🎉 ¡DAILY ÉPICO RECLAMADO! 🎉\n\n💰 +${recompensa} de poder ganado\n⚡ Poder total: ${user.poder}\n🏆 Rango: ${rango} ${clasificacion}\n\n🌟 ¡Imperio Triple X Recompensa!` 
        })
      }
    }

    // #perfil - Enhanced epic profile
    if (body.startsWith("#perfil")) {
      let { rango, clasificacion } = obtenerRangoClasificacion(user.poder)
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

      let perfil = `╔═══════════════════════════════╗
║        👑 PERFIL ÉPICO 👑        ║
║     Imperio Triple X Domina     ║
╚═══════════════════════════════╝

🎭 **GUERRERO:** ${user.nombre}
📊 **NIVEL:** ${user.nivel}
⚡ **PODER:** ${user.poder.toLocaleString()}
${rangoEmoji} **RANGO:** ${rango}
🏅 **CLASIFICACIÓN:** ${clasificacion}
🏆 **POSICIÓN GLOBAL:** #${posicion}
⚔️ **RAYO DIVINO:** ${user.rayo || "🚫 Ninguno"}

╔═══════════════════════════════╗
║     💫 Imperio Triple X 💫     ║
║        Domina Siempre         ║
╚═══════════════════════════════╝`

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

    // #rank - Enhanced epic ranking
    if (body.startsWith("#rank")) {
      let top = Object.values(usuarios).sort((a, b) => b.poder - a.poder).slice(0, 10)
      let ranking = `╔═══════════════════════════════╗
║      🏆 TOP 10 GUERREROS 🏆     ║
║     Imperio Triple X Domina     ║
╚═══════════════════════════════╝

`
      
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"]
      
      top.forEach((u, i) => {
        let { rango, clasificacion } = obtenerRangoClasificacion(u.poder)
        let medal = medals[i] || `${i + 1}️⃣`
        ranking += `${medal} **${u.nombre}**\n   ⚡ ${u.poder.toLocaleString()} | 🏅 ${rango} ${clasificacion}\n\n`
      })
      
      ranking += `╔═══════════════════════════════╗
║     💫 Imperio Triple X 💫     ║
║        Domina Siempre         ║
╚═══════════════════════════════╝`
      
      await sock.sendMessage(chatId, { text: ranking })
    }

    // #duelo - Enhanced epic duel
    if (body.startsWith("#duelo")) {
      // Buscar objetivo en mentions o parsearlo del texto
      let enemigoId = null
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
      
      if (mentionedJid) {
        enemigoId = mentionedJid
      } else {
        let partes = body.split(" ")
        if (partes.length < 2) {
          await sock.sendMessage(chatId, { text: "❌ Usa: #duelo @usuario (mencionando al usuario)\n⚔️ ¡Desafía a un guerrero del Imperio!" })
          return
        }
        enemigoId = partes[1].replace("@", "") + "@s.whatsapp.net"
      }
      
      // Validaciones
      if (enemigoId === senderId) {
        await sock.sendMessage(chatId, { text: "❌ ¡No puedes duelarte contra ti mismo!\n💪 Busca un oponente digno, guerrero" })
        return
      }
      
      if (!usuarios[enemigoId]) {
        await sock.sendMessage(chatId, { text: "❌ Ese usuario no existe en el Imperio\n🎮 Debe usar algún comando primero" })
        return
      }

      let enemigo = usuarios[enemigoId]
      
      // Epic battle simulation
      const battleText = `⚔️ ¡DUELO ÉPICO INICIADO! ⚔️\n\n🔥 ${user.nombre} (${user.poder.toLocaleString()}⚡)\n        VS\n🔥 ${enemigo.nombre} (${enemigo.poder.toLocaleString()}⚡)\n\n⏳ Las espadas chocan...`
      
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

        const resultText = `🏆 ¡RESULTADO DEL DUELO ÉPICO! 🏆\n\n👑 **GANADOR:** ${ganador.nombre}\n💰 **RECOMPENSA:** +${recompensa.toLocaleString()} poder\n⚡ **PODER TOTAL:** ${ganador.poder.toLocaleString()}\n🏅 **NUEVO RANGO:** ${rangoGanador} ${clasifGanador}\n\n💔 **DERROTADO:** ${perdedor.nombre}\n\n╔═══════════════════════════════╗\n║   🌟 Imperio Triple X Domina 🌟  ║\n║        Gloria Eterna!         ║\n╚═══════════════════════════════╝`

        await sock.sendMessage(chatId, { 
          text: resultText,
          mentions: [ganadorId, perdedorId]
        })
      }, 3000)
    }
  })
}

startBot()
