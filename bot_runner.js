// bot_runner.js
const mineflayer = require('mineflayer')
const fs = require('fs-extra')
const path = require('path')
const moment = require('moment-timezone')

let config = null
let bot = null
let botStatus = { state: 'connecting', message: 'Ishga tushirilmoqda...' }

// Log fayllari
const logFiles = {}

// Qayta ulanishni cheklash
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5 // 5 marta urinishdan so'ng to'xtaydi

// Log Faylga Yozish Funksiyasi
async function logToFile(type, line) {
  if (!config) return; // Konfig yuklanmagan bo'lsa
  const ts = moment().tz(config.timeZone).format('YYYY-MM-DD HH:mm:ss')
  const fullLine = `[${ts}] ${line}`
  
  try {
    const logPath = path.join(config.logsDir, config.id, `${type}_${moment().format('YYYYMMDD')}.log`)
    await fs.appendFile(logPath, fullLine + '\n')
  } catch (e) {
    process.send({ type: 'error', data: `Log yozishda xato: ${e.message}` })
  }
}

// Jarayonlararo aloqa funksiyasi (Parent jarayonga yuborish)
function updateStatus(state, message, startTime = null) {
  // Agar startTime null bo'lsa, avvalgisini saqlab qolish (masalan, captcha paytida)
  const newStartTime = startTime !== null ? startTime : (botStatus.startTime || null);
  botStatus = { state, message, startTime: newStartTime }
  process.send({ type: 'statusUpdate', data: botStatus })
}

function sendLog(line, pos = 'CONSOLE') {
  if (pos === 'CHAT' || pos === 'WHISPER' || pos === 'SYSTEM' || pos === 'ACTION_BAR') {
    logToFile('chat', line)
  } else {
    logToFile('console', line)
  }
  process.send({ type: 'log', data: { pos, line } })
}

function startBot() {
  sendLog(`BOT: Ulanish urinish - ${config.username} -> ${config.serverHost}:${config.serverPort}`)
  updateStatus('connecting', `Ulanilmoqda... ${config.serverHost}`)

  // *** YANGI O'ZGARISH ***
  // Mineflayer options ob'yektini tayyorlash
  const botOptions = {
    host: config.serverHost,
    port: config.serverPort,
    username: config.username
    // 'version: false' olib tashlandi. Mineflayer o'zi aniqlasin.
  };

  // Agar 'localAddress' configda ko'rsatilgan bo'lsa, uni options'ga qo'shish
  if (config.localAddress && config.localAddress.trim() !== '') {
    botOptions.localAddress = config.localAddress.trim();
    sendLog(`BOT: Maxsus lokal IP (${botOptions.localAddress}) orqali ulanilmoqda.`);
  } else {
    sendLog(`BOT: Standart (avtomatik) lokal IP orqali ulanilmoqda.`);
  }

  // O'zgartirilgan options bilan botni yaratish
  bot = mineflayer.createBot(botOptions);
  // **********************

  // Bot Eventlari
  bot.once('spawn', () => {
    reconnectAttempts = 0 // Muvaffaqiyatli ulanish! Hisoblagichni nolga qaytarish.
    sendLog('BOT: spawn (o‘yinga tushdi).')
    updateStatus('online', 'O\'yinda', Date.now()) // Uptime hisoblash boshlanadi

    // AVTOMATIK LOGIN
    if (config.autoLogin && config.password) {
        sendLog('BOT: Avtomatik login yuborilmoqda...')
        // Ba'zi serverlar spawn'dan keyin biroz vaqt talab qiladi
        setTimeout(() => {
            bot.chat(`/login ${config.password}`)
        }, 1500)
    }
  })

  bot.on('message', (jsonMsg, position) => {
    try {
      const text = jsonMsg.toString().trim()
      if (!text) return; // Bo'sh xabarlarni e'tiborsiz qoldirish

      const posName = position === 2 ? 'ACTION_BAR' : (position === 1 ? 'SYSTEM' : 'CHAT')
      sendLog(`RECV (${posName}): ${text}`, posName)

      const lowerText = text.toLowerCase();

      // Agar server qaytadan login so'rasa (masalan, lobbyga tushib qolsa)
      if (config.autoLogin && config.password && (lowerText.includes('/login') || lowerText.includes('/register'))) {
           sendLog('BOT: Server login so\'radi, qayta yuborilmoqda...')
           setTimeout(() => bot.chat(`/login ${config.password}`), 2000)
      }
      
      // Oddiy Captcha aniqlash
      if (lowerText.includes('captcha') || lowerText.includes('kodni tering')) {
          sendLog('BOT: Captcha so\'rovi aniqlandi. Iltimos, GUIdan hal qiling.', 'SYSTEM')
          updateStatus('captcha', 'Captcha kutilmoqda...') // startTime o'zgarmaydi
      }

    } catch (e) {
      sendLog('ERROR in message handler: ' + e.message)
    }
  })

  bot.on('kicked', (reason) => {
    sendLog(`KICKED: ${reason && reason.toString ? reason.toString() : reason}`)
    stopBot(true) // Qayta ulanishni so'rash
  })

  bot.on('error', (err) => {
    sendLog(`ERROR: ${err && err.stack ? err.stack : err}`)
    stopBot(true)
  })

  bot.on('end', () => {
    sendLog('END: Sessiya tugadi.')
    stopBot(true) // Qayta ulanishni so'rash
  })
}

function stopBot(isReconnect = false) {
  if (bot) {
      try {
        bot.removeAllListeners()
        bot.quit()
      } catch (e) {
        sendLog('Bot.quit() xatolik: ' + e.message, 'ERROR')
      } finally {
        bot = null
      }
  }

  // Parent jarayonga holatni o'zgartirishni so'rash
  if (isReconnect) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        sendLog(`BOT: Qayta ulanish urinishlari soni (${MAX_RECONNECT_ATTEMPTS}) oshib ketdi. To'xtatilmoqda.`, 'ERROR')
        updateStatus('offline', 'Qayta ulanishda xatolik.')
        // Menejerga jarayon tugaganini aytish, u qayta ishga tushirmaydi (isReconnect=false)
        process.send({ type: 'exit', data: null }) 
        return;
    }
    reconnectAttempts++;
    sendLog(`BOT: Qayta ulanish urinishi ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} (${config.autoReconnectMs / 1000}s)`)
    updateStatus('connecting', `Qayta ulanmoqda... (Urinish ${reconnectAttempts})`)
    setTimeout(startBot, config.autoReconnectMs)
  } else {
    updateStatus('offline', 'Foydalanuvchi tomonidan to\'xtatildi.')
    // Qaytish xabarini yuborish
    process.send({ type: 'exit', data: null })
  }
}


// Parent jarayonidan keladigan xabarlarni tinglash
process.on('message', async (msg) => {
  if (msg.type === 'start') {
    config = msg.data
    // Log papkasini yaratish
    await fs.ensureDir(path.join(config.logsDir, config.id))
    reconnectAttempts = 0; // Yangi start, hisoblagichni nolga qaytarish
    startBot()
  } else if (msg.type === 'stop') {
    stopBot(false)
  } else if (msg.type === 'command' && bot && bot.chat) {
    const cmd = msg.data
    bot.chat(cmd)
    sendLog(`SENT: ${cmd}`)
    
    // Agar captcha yuborilgan bo'lsa, holatni "online" ga qaytarish
    if (botStatus.state === 'captcha') {
        updateStatus('online', 'O\'yinda')
    }
  } else if (msg.type === 'command' && !bot) {
    sendLog('ERROR: Bot ulanmagan, buyruq yuborilmadi.')
  }
})

// Jarayon kutilmaganda to'xtasa
process.on('exit', (code) => {
    if (code !== 0 && code !== null) {
        process.send({ type: 'error', data: `Jarayon kutilmaganda to'xtadi (Exit Code: ${code})` })
    }
    // Avtomatik qayta ulanish mantig'i menejer jarayonida amalga oshiriladi (child.on('exit', ...))
});
