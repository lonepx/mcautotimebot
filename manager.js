// manager.js (Multi-Process / Multi-Bot Manager)
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const fs = require('fs-extra') // fs-extra: ensureDir va ishlash qulayligi uchun
const path = require('path')
const si = require('systeminformation')
const moment = require('moment-timezone')
const { v4: uuidv4 } = require('uuid')
const { fork } = require('child_process') // Multi-Process uchun

/* ====== CONFIG ====== */
const CONFIG = {
  webPort: 3000,
  logsDir: path.join(__dirname, 'logs'),
  dbPath: path.join(__dirname, 'data.json'),
  autoReconnectMs: 10000,
  statsIntervalMs: 2000, 
  timeZone: 'Asia/Tashkent'
}

/* ========== PREP ========== */
let io = null
const activeBots = new Map() // Ishlayotgan botlar (key: botId, value: { process, config, status })
let allBotConfigs = [] // data.json dagi barcha botlar
global.tempWarningSent = false // Harorat haqida ogohlantirishni faqat bir marta yuborish uchun

// ========== DB (data.json) Functions ==========
async function readBotConfigs() {
  try {
    await fs.ensureFile(CONFIG.dbPath) // Agar bo'lmasa, faylni yaratadi
    const data = await fs.readFile(CONFIG.dbPath, 'utf8')
    allBotConfigs = data ? JSON.parse(data) : []
    serverLog(`Ma'lumotlar bazasidan ${allBotConfigs.length} ta bot topildi.`)
  } catch (e) {
    serverLog('data.json o\'qishda xatolik: ' + e.message, 'ERROR')
    allBotConfigs = []
  }
}

async function saveBotConfigs() {
  try {
    await fs.writeFile(CONFIG.dbPath, JSON.stringify(allBotConfigs, null, 2))
    serverLog('Bot konfiguratsiyalari data.json ga saqlandi.')
  } catch (e) {
    serverLog('data.json ga yozishda xatolik: ' + e.stack, 'ERROR')
  }
}

// ========== Logging & Status ==========
function serverLog(line, level = 'INFO') {
  const ts = moment().tz(CONFIG.timeZone).format('YYYY-MM-DD HH:mm:ss')
  console.log(`[${ts}] [${level}] ${line}`)
}

function updateBotStatus(botId, status) {
  const botInstance = activeBots.get(botId)
  if (botInstance) {
    botInstance.status = status
    // Faqat statusni yangilaymiz, butun configni emas
    io.emit('bot:status', { botId, status })
  }
}

// Uptime hisoboti uchun yordamchi funksiya (serverda hisoblash)
function formatUptime(startTime) {
    if (!startTime) return '0s';
    const totalSeconds = Math.floor((Date.now() - startTime) / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    let str = '';
    if (days > 0) str += `${days}k `;
    if (hours > 0) str += `${hours}s `;
    if (minutes > 0) str += `${minutes}d `;
    str += `${seconds}s`;
    return str.trim();
}

// ========== Bot Management (Forking) ==========

function startBot(botId) {
  if (activeBots.has(botId)) {
    serverLog(`Bot ${botId} allaqachon ishlamoqda.`, 'WARN')
    return
  }
  
  const config = allBotConfigs.find(b => b.id === botId)
  if (!config) {
    serverLog(`Bot ${botId} topilmadi.`, 'ERROR')
    return
  }
  
  serverLog(`BOT: ${config.name} uchun child process ishga tushirilmoqda.`)
  updateBotStatus(botId, { state: 'connecting', message: 'Jarayon ishga tushmoqda...' })

  // Child process (Bolak jarayon) yaratish
  const child = fork(path.join(__dirname, 'bot_runner.js'))

  const botInstance = {
    process: child,
    config,
    status: { state: 'connecting', message: 'Jarayon ishga tushmoqda...' }
  }
  activeBots.set(botId, botInstance)

  // Child process'ga konfiguratsiyani yuborish
  // *** MUHIM: Bu yerda config to'liq yuboriladi, shu jumladan yangi 'localAddress' ham ***
  child.send({ type: 'start', data: { ...config, logsDir: CONFIG.logsDir, timeZone: CONFIG.timeZone, autoReconnectMs: CONFIG.autoReconnectMs } })

  // Child process'dan kelgan xabarlarni tinglash
  child.on('message', async (msg) => {
    const data = msg.data
    
    switch (msg.type) {
      case 'statusUpdate':
        // Uptime'ni hisoblash uchun startTime ni o'zimiz (manager) saqlaymiz
        if (data.state === 'online') {
            config.lastStart = moment().tz(CONFIG.timeZone).toISOString()
        }
        updateBotStatus(botId, data)
        await saveBotConfigs()
        io.emit('bot:configUpdate', config) // Start/Stop vaqtini yangilash
        break;
      case 'log':
        // loglar to'g'ridan-to'g'ri klientga yuboriladi, log yozish runner da
        io.emit(`bot:log`, { botId, line: data.line, pos: data.pos || 'CONSOLE' })
        break;
      case 'error':
        serverLog(`[BOT ERROR ${config.name}] ${data}`, 'CHILD_ERR')
        io.emit(`bot:log`, { botId, line: `[MANAGER] Kutilmagan xato: ${data}`, pos: 'SYSTEM' })
        break;
      case 'exit':
        serverLog(`[BOT ${config.name}] Jarayon to'xtatildi (Normal Exit).`)
        cleanupBot(botId, false)
        break;
    }
  })
  
  // Jarayon kutilmaganda to'xtasa (crash)
  child.on('exit', (code, signal) => {
    if (activeBots.has(botId)) { // Agar hali ham aktiv botlar ro'yxatida bo'lsa
      serverLog(`[BOT ${config.name}] Kutilmagan EXIT: Code ${code}, Signal ${signal}`, 'CRASH')
      cleanupBot(botId, true) // Qayta ulanishni so'rash
    }
  })
}

async function cleanupBot(botId, isReconnect = false) {
  const botInstance = activeBots.get(botId)
  if (!botInstance) return
  
  const { config } = botInstance
  
  // Active botlar ro'yxatidan o'chiramiz
  activeBots.delete(botId)

  // config.lastStop ni yangilash va klientga yuborish
  config.lastStop = moment().tz(CONFIG.timeZone).toISOString()
  await saveBotConfigs()
  io.emit('bot:configUpdate', config) 

  if (isReconnect) {
    serverLog(`BOT: ${config.name} ${CONFIG.autoReconnectMs/1000}s ichida qayta ulanadi.`)
    updateBotStatus(botId, { state: 'connecting', message: `Qayta ulanmoqda... (${CONFIG.autoReconnectMs/1000}s)` })
    setTimeout(() => startBot(botId), CONFIG.autoReconnectMs)
  } else {
    updateBotStatus(botId, { state: 'offline', message: 'To\'xtatildi.' })
  }
}

function stopBot(botId, isReconnect = false) {
  const botInstance = activeBots.get(botId)
  if (!botInstance) return

  // 1. Child process'ga to'xtash buyrug'ini yuborish
  botInstance.process.send({ type: 'stop' })
  // 2. Agar 5 soniyadan keyin to'xtamasa, uni majburan o'ldirish
  setTimeout(() => {
    if (activeBots.has(botId)) {
        serverLog(`BOT: ${botInstance.config.name} majburiy to'xtatildi (Kill).`, 'WARN')
        botInstance.process.kill('SIGKILL')
        cleanupBot(botId, isReconnect)
    }
  }, 5000);
}

// ========== Web (Express + socket.io) ==========
const app = express()
const server = http.createServer(app)
io = new Server(server)

app.use(express.static(path.join(__dirname))) // index.html ni taqdim etish

io.on('connection', (socket) => {
  serverLog('WEB: GUI ulandi.')
  
  // Yangi ulanuvchiga barcha botlar ro'yxatini va joriy holatini yuborish
  const allBotsWithStatus = allBotConfigs.map(config => {
    const activeInstance = activeBots.get(config.id)
    const status = activeInstance ? activeInstance.status : { state: 'offline', message: 'Kutmoqda...' }
    // Uptime'ni manager hisoblaydi
    if (status.state === 'online' && status.startTime) {
        status.uptime = formatUptime(status.startTime)
    } else {
        status.uptime = '0s'
    }
    // *** MUHIM: Bu yerda 'config' o'z ichiga 'localAddress'ni ham oladi ***
    return { ...config, status }
  })
  socket.emit('bots:list', allBotsWithStatus)

  // Uptime ni har soniyada yangilab turish
  const uptimeInterval = setInterval(() => {
    activeBots.forEach((instance, botId) => {
        if (instance.status.state === 'online' && instance.status.startTime) {
            io.emit('bot:uptime', { 
                botId: botId, 
                uptime: formatUptime(instance.status.startTime) 
            })
        }
    })
  }, 1000)

  socket.on('disconnect', () => {
    clearInterval(uptimeInterval)
  })

  // --- Bot Boshqaruvi (GUI) ---
  socket.on('bot:add', async (config) => {
    // *** MUHIM: 'config' bu yerda 'localAddress'ni o'z ichiga oladi ***
    const newBot = {
      ...config, id: uuidv4(), lastStart: null, lastStop: null
    }
    allBotConfigs.push(newBot)
    await saveBotConfigs()
    
    const newBotWithStatus = { ...newBot, status: { state: 'offline', message: 'Kutmoqda...' } }
    io.emit('bot:added', newBotWithStatus) 
  })

  socket.on('bot:remove', async (botId) => {
    if (activeBots.has(botId)) stopBot(botId, false) 
    allBotConfigs = allBotConfigs.filter(b => b.id !== botId)
    await saveBotConfigs()
    io.emit('bot:removed', botId)
  })
  
  socket.on('bot:start', startBot)
  socket.on('bot:stop', (botId) => stopBot(botId, false))

  // Qo'lda buyruqlar
  socket.on('bot:login', (botId) => sendCommandToBot(botId, `/login ${allBotConfigs.find(b=>b.id===botId)?.password}`))
  socket.on('bot:anarxiya', (botId) => sendCommandToBot(botId, '/anarxiya'))
  socket.on('bot:sendCommand', ({ botId, cmd }) => sendCommandToBot(botId, cmd))
  socket.on('bot:solveCaptcha', ({ botId, code }) => sendCommandToBot(botId, code))
})

function sendCommandToBot(botId, cmd) {
    const instance = activeBots.get(botId)
    if (instance && instance.process) {
        instance.process.send({ type: 'command', data: cmd })
    } else {
        serverLog(`Buyruq yuborishda xatolik: Bot ${botId} ishlamayapti.`, 'ERROR')
    }
}

// ========== System Stats & Temp ==========
setInterval(async () => {
  try {
    const [cpu, mem, temp] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.cpuTemperature() // Haroratni olish
    ])
    
    // Haroratni topish uchun yaxshiroq mantiq
    let cpuTemp = 'N/A';
    if (temp.main && temp.main > 0) {
        cpuTemp = temp.main.toFixed(1);
    } else if (temp.cores && temp.cores.length > 0) {
        const validCoreTemps = temp.cores.filter(c => c > 0);
        if (validCoreTemps.length > 0) {
            // Yadrolar bo'yicha o'rtachasini hisoblash
            const avgCoreTemp = validCoreTemps.reduce((a, b) => a + b, 0) / validCoreTemps.length;
            cpuTemp = avgCoreTemp.toFixed(1);
        }
    }
    
    if (cpuTemp === 'N/A' && !global.tempWarningSent) {
        serverLog('CPU haroratini aniqlab bo\'lmadi. Sensorlarga kirish huquqi yo\'q bo\'lishi mumkin. (Linuxda "sudo" yoki Windowsda "Administrator" huquqida ishga tushiring)', 'WARN')
        global.tempWarningSent = true; // Xabarni faqat bir marta ko'rsatish
    }

    const stats = {
      time: moment().tz(CONFIG.timeZone).format('HH:mm:ss'),
      cpu: cpu.currentLoad,
      mem: {
        used: (mem.used / 1024 / 1024 / 1024).toFixed(2),
        total: (mem.total / 1024 / 1024 / 1024).toFixed(2),
        percent: (mem.used / mem.total) * 100
      },
      cpuTemp: cpuTemp
    }
    io.emit('system:stats', stats)
  } catch (e) {
    serverLog('Statistika olishda xatolik: ' + e.message, 'ERROR')
  }
}, CONFIG.statsIntervalMs)


// ========== Start Server ==========
async function startServer() {
  await fs.ensureDir(CONFIG.logsDir)
  await readBotConfigs()
  server.listen(CONFIG.webPort, () => {
    console.log(`=================================================`)
    console.log(`  MC Bot Manager GUI (v3.0 - Multi-Process)`)
    console.log(`  Manzil: http://localhost:${CONFIG.webPort}`)
    console.log(`=================================================`)
  })
}

startServer()

// Graceful shutdown
process.on('SIGINT', () => {
  serverLog('SIGINT: Barcha botlar to‘xtatilmoqda...')
  for (const botId of activeBots.keys()) {
    // Child process'ni yopish
    activeBots.get(botId).process.kill('SIGINT') 
  }
  setTimeout(() => process.exit(0), 1000) // 1 sek kuting va yoping
})
