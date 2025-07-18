const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// MIME types для статических файлов
const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Создаем HTTP сервер для статических файлов
const server = http.createServer((req, res) => {
  // Добавляем CORS заголовки
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Обработка preflight OPTIONS запросов
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url);
  let pathname = parsedUrl.pathname;

  // Если запрос к корню, отдаем index.html
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath);
  const mimeType = mimeTypes[ext] || "text/plain";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }

    res.writeHead(200, { "Content-Type": mimeType });
    res.end(data);
  });
});

// Создаем WebSocket сервер на том же HTTP сервере
const wss = new WebSocket.Server({
  server,
  // Оптимизации для продакшена
  perMessageDeflate: {
    // Сжатие сообщений для экономии трафика
    threshold: 1024,
    concurrencyLimit: 10,
    memLevel: 7,
  },
});

// Игровое состояние
const gameState = {
  players: new Map(),
  rooms: new Map(),
  queue: [], // Очередь для поиска игры
  nextPlayerId: 1,
  nextRoomId: 1,
};

// Определяем настройки в зависимости от среды
const isProduction = process.env.NODE_ENV === "production" || process.env.PORT;

// Класс комнаты для игры
class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.gameStarted = false;
    this.lastUpdate = Date.now();
    // Динамический tick rate в зависимости от среды
    this.tickRate = isProduction ? 30 : 60; // 30 FPS для продакшена, 60 для локальной разработки
    this.tickInterval = 1000 / this.tickRate;
    this.gameLoop = null;

    // Адаптивная оптимизация пинга
    this.latencyHistory = [];
    this.avgLatency = 0;
    this.optimizedTickRate = this.tickRate;
    this.lastOptimization = Date.now();
  }

  addPlayer(playerId, ws) {
    if (this.players.size >= 2) return false;

    this.players.set(playerId, {
      id: playerId,
      ws: ws,
      ready: false,
      fighter: null,
      x: 0,
      y: 0,
      velocityY: 0,
      isJumping: false,
      health: 100,
      facing: true,
      attacking: false,
      blocking: false,
      bullets: [],
      shootCooldown: 0,
      attackTimer: 0,
      lastInputTime: Date.now(),
    });

    console.log(`Player ${playerId} joined room ${this.id}`);
    return true;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    if (this.players.size === 0) {
      this.stopGame();
    }
  }

  broadcast(message, excludePlayer = null) {
    const data = JSON.stringify(message);
    this.players.forEach((player) => {
      if (
        player.id !== excludePlayer &&
        player.ws.readyState === WebSocket.OPEN
      ) {
        player.ws.send(data);
      }
    });
  }

  sendToPlayer(playerId, message) {
    const player = this.players.get(playerId);
    if (player && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  }

  startGame() {
    if (this.players.size !== 2 || this.gameStarted) return;

    this.gameStarted = true;
    this.lastUpdate = Date.now();

    // Устанавливаем стартовые позиции игроков на основе их персонажей
    const playersArray = Array.from(this.players.values());
    const CANVAS_WIDTH = 640;
    const CANVAS_HEIGHT = 360;
    const PLAYER_WIDTH = 70;
    const PLAYER_HEIGHT = 70;
    const GROUND_Y = CANVAS_HEIGHT - 50;

    playersArray.forEach((player, index) => {
      if (player.fighter === "dowand") {
        player.x = CANVAS_WIDTH / 4 - PLAYER_WIDTH / 2;
        player.facing = true;
      } else if (player.fighter === "ewon") {
        player.x = (CANVAS_WIDTH * 3) / 4 - PLAYER_WIDTH / 2;
        player.facing = false;
      }
      player.y = GROUND_Y - PLAYER_HEIGHT;
      player.health = 100;
    });

    // Отправляем начальное состояние игры
    this.broadcast({
      type: "gameStart",
      players: playersArray.map((p) => ({
        id: p.id,
        fighter: p.fighter,
        x: p.x,
        y: p.y,
        health: p.health,
      })),
    });

    // Запускаем игровой цикл
    this.gameLoop = setInterval(() => {
      this.updateGame();
    }, this.tickInterval);

    console.log(`Game started in room ${this.id}`);
  }

  stopGame() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    this.gameStarted = false;
  }

  updateGame() {
    const now = Date.now();
    const deltaTime = now - this.lastUpdate;
    this.lastUpdate = now;

    // Адаптивная оптимизация tick rate каждые 10 секунд
    if (now - this.lastOptimization > 10000 && this.latencyHistory.length > 0) {
      this.avgLatency =
        this.latencyHistory.reduce((a, b) => a + b, 0) /
        this.latencyHistory.length;

      // Оптимизируем tick rate на основе среднего пинга
      if (this.avgLatency > 200) {
        this.optimizedTickRate = Math.max(15, this.tickRate - 5); // Снижаем до 15 FPS минимум
      } else if (this.avgLatency < 100) {
        this.optimizedTickRate = Math.min(
          this.tickRate,
          this.optimizedTickRate + 2
        ); // Увеличиваем постепенно
      }

      // Обновляем интервал если tick rate изменился
      if (this.optimizedTickRate !== this.tickRate) {
        clearInterval(this.gameLoop);
        this.tickInterval = 1000 / this.optimizedTickRate;
        this.gameLoop = setInterval(() => {
          this.updateGame();
        }, this.tickInterval);

        // console.log(
        //   `Room ${this.id}: Optimized tick rate to ${
        //     this.optimizedTickRate
        //   } FPS (avg latency: ${this.avgLatency.toFixed(2)}ms)`
        // );
      }

      this.latencyHistory = []; // Очищаем историю
      this.lastOptimization = now;
    }

    // Обновляем физику игроков на сервере
    this.updatePlayerPhysics();

    // Обновляем пули перед отправкой состояния
    this.updateBullets();

    // Собираем все пули от всех игроков (только активные)
    let allBullets = [];
    this.players.forEach((player) => {
      if (player.bullets && player.bullets.length > 0) {
        // Отправляем только основные свойства пуль для экономии трафика
        const simplifiedBullets = player.bullets.map((bullet) => ({
          id: bullet.id,
          x: Math.round(bullet.x), // Округляем для экономии трафика
          y: Math.round(bullet.y),
          ownerId: bullet.ownerId,
        }));
        allBullets = allBullets.concat(simplifiedBullets);
      }
    });

    // Собираем оптимизированное состояние всех игроков
    const gameUpdate = {
      type: "gameUpdate",
      timestamp: now,
      players: Array.from(this.players.values()).map((player) => ({
        id: player.id,
        // Округляем координаты для экономии трафика
        x: Math.round(player.x),
        y: Math.round(player.y),
        velocityY: Math.round(player.velocityY * 10) / 10, // Округляем до 1 знака
        isJumping: player.isJumping,
        facing: player.facing,
        attacking: player.attacking,
        blocking: player.blocking,
        health: player.health,
        fighter: player.fighter,
      })),
      bullets: allBullets,
    };

    // Отправляем обновление всем игрокам
    this.broadcast(gameUpdate);
  }

  // Новый метод для обновления физики игроков
  updatePlayerPhysics() {
    // Скорректированная гравитация для 20 FPS (была 0.8 для 60 FPS)
    const GRAVITY = 1.5; // Увеличиваем для компенсации меньшей частоты обновлений
    const CANVAS_WIDTH = 640;
    const CANVAS_HEIGHT = 360;
    const PLAYER_WIDTH = 70;
    const PLAYER_HEIGHT = 70;
    const GROUND_Y = CANVAS_HEIGHT - 50;

    for (const [playerId, player] of this.players) {
      // Применяем гравитацию
      player.velocityY += GRAVITY;
      player.y += player.velocityY;

      // Проверяем приземление
      if (player.y + PLAYER_HEIGHT >= GROUND_Y) {
        player.y = GROUND_Y - PLAYER_HEIGHT;
        player.velocityY = 0;
        player.isJumping = false;
      }

      // Ограничиваем позицию по горизонтали
      if (player.x < 0) player.x = 0;
      if (player.x + PLAYER_WIDTH > CANVAS_WIDTH)
        player.x = CANVAS_WIDTH - PLAYER_WIDTH;

      // Ограничиваем позицию по вертикали (не улетать вверх за экран)
      if (player.y < 0) player.y = 0;
    }
  }

  handlePlayerInput(playerId, input) {
    const player = this.players.get(playerId);
    if (!player) return;

    // Обновляем время последнего ввода для анти-чита
    player.lastInputTime = Date.now();

    // Применяем ввод игрока
    if (input.movement) {
      player.x = Math.max(0, Math.min(640 - 70, input.movement.x));
      player.y = Math.max(0, Math.min(360 - 70, input.movement.y));
      player.velocityY = input.movement.velocityY || 0;
      player.isJumping = input.movement.isJumping || false;
      player.facing = input.movement.facing;
    }

    if (input.actions) {
      // Обрабатываем атаки на сервере
      if (input.actions.attacking && !player.attacking) {
        player.attacking = input.actions.attacking;
        // Скорректированный таймер атаки для 20 FPS (было 30 для 60 FPS)
        player.attackTimer = 10; // ~0.5 секунды при 20 FPS

        // Проверяем попадание по другому игроку
        this.checkMeleeHit(playerId, input.actions.attacking);
      } else if (!input.actions.attacking) {
        player.attacking = false;
        player.attackTimer = 0;
      }

      player.blocking = input.actions.blocking;
    }

    if (input.health !== undefined) {
      player.health = Math.max(0, Math.min(100, input.health));
    }

    // Обрабатываем создание новых пуль на сервере
    if (input.newBullet) {
      if (player.shootCooldown <= 0) {
        const bullet = {
          id: Date.now() + Math.random(), // Уникальный ID пули
          x: input.newBullet.x,
          y: input.newBullet.y,
          velocityX: input.newBullet.velocityX,
          velocityY: input.newBullet.velocityY,
          ownerId: playerId,
          timestamp: Date.now(),
        };

        if (!player.bullets) player.bullets = [];
        player.bullets.push(bullet);
        // Скорректированный кулдаун стрельбы для 20 FPS (было 30 для 60 FPS)
        player.shootCooldown = 10; // ~0.5 секунды при 20 FPS

        // console.log(
        //   `Player ${playerId} shot bullet at ${bullet.x}, ${bullet.y}`
        // );
      }
    }

    // Обновляем пули и проверяем коллизии
    this.updateBullets();

    // Убираем избыточный broadcast - данные будут отправлены в основном игровом цикле
    // Это существенно снижает пинг, убирая дублирующие сообщения
    // this.broadcast(
    //   {
    //     type: "playerInput",
    //     playerId: playerId,
    //     input: input,
    //     timestamp: Date.now(),
    //   },
    //   playerId
    // );
  }

  // Новый метод для проверки попаданий атак ближнего боя
  checkMeleeHit(attackerId, attackType) {
    const attacker = this.players.get(attackerId);
    if (!attacker) return;

    // Находим цель (другого игрока)
    let target = null;
    for (const [id, player] of this.players) {
      if (id !== attackerId) {
        target = player;
        break;
      }
    }

    if (!target) return;

    // Константы для расчета попаданий
    const ARM_STRIKE_RANGE_X = 80;
    const ARM_STRIKE_RANGE_Y = 40;
    const LEG_STRIKE_RANGE_X = 70;
    const LEG_STRIKE_RANGE_Y = 50;
    const ARM_STRIKE_DAMAGE = 15;
    const LEG_STRIKE_DAMAGE = 20;
    const BLOCK_DAMAGE_REDUCTION = 0.5;
    const KNOCKBACK_FORCE = 15;

    let rangeX, rangeY, damage;
    if (attackType === "arm") {
      rangeX = ARM_STRIKE_RANGE_X;
      rangeY = ARM_STRIKE_RANGE_Y;
      damage = ARM_STRIKE_DAMAGE;
    } else if (attackType === "leg") {
      rangeX = LEG_STRIKE_RANGE_X;
      rangeY = LEG_STRIKE_RANGE_Y;
      damage = LEG_STRIKE_DAMAGE;
    } else {
      return;
    }

    // Рассчитываем область атаки
    const attackX = attacker.facing ? attacker.x + 70 : attacker.x - rangeX; // 70 - ширина игрока
    const attackY = attacker.y + 25; // примерная высота атаки

    // Проверяем попадание
    if (
      attackX < target.x + 70 &&
      attackX + rangeX > target.x &&
      attackY < target.y + 70 &&
      attackY + rangeY > target.y
    ) {
      // Попадание!
      let actualDamage = damage;
      let blocked = false;

      if (target.blocking) {
        // Полная блокировка урона
        actualDamage = 0;
        blocked = true;
      }

      target.health -= actualDamage;
      if (target.health < 0) target.health = 0;

      // Применяем отбрасывание (даже при блоке, но меньше)
      const knockbackForce = blocked ? KNOCKBACK_FORCE * 0.3 : KNOCKBACK_FORCE;
      if (attacker.facing) {
        target.x += knockbackForce;
      } else {
        target.x -= knockbackForce;
      }

      // Ограничиваем позицию в пределах экрана
      target.x = Math.max(0, Math.min(640 - 70, target.x));

      // console.log(
      //   `Player ${attackerId} ${blocked ? "blocked by" : "hit"} player ${
      //     target.id
      //   } for ${actualDamage} damage. Health: ${target.health}`
      // );

      // Отправляем событие попадания
      this.broadcast({
        type: "playerHit",
        attackerId: attackerId,
        targetId: target.id,
        damage: actualDamage,
        targetHealth: target.health,
        blocked: blocked,
        knockback: attacker.facing ? knockbackForce : -knockbackForce,
      });
    }
  }

  // Новый метод для обновления пуль и проверки коллизий
  updateBullets() {
    const BULLET_DAMAGE = 10;
    const BLOCK_DAMAGE_REDUCTION = 0.5;
    const KNOCKBACK_FORCE = 15;

    for (const [playerId, player] of this.players) {
      if (!player.bullets) continue;

      // Обновляем позиции пуль независимо от игроков
      for (let i = player.bullets.length - 1; i >= 0; i--) {
        const bullet = player.bullets[i];

        // Увеличиваем скорость пуль для компенсации меньшей частоты обновлений (20 FPS вместо 60 FPS)
        bullet.x += bullet.velocityX * 3; // Умножаем на 3 для компенсации разницы в FPS
        bullet.y += bullet.velocityY * 3;

        // Удаляем пули, вылетевшие за экран
        if (
          bullet.x < -20 ||
          bullet.x > 660 ||
          bullet.y < -20 ||
          bullet.y > 380
        ) {
          player.bullets.splice(i, 1);
          // console.log(`Bullet ${bullet.id} removed (out of bounds)`);
          continue;
        }

        // Проверяем коллизию с другими игроками
        let hitDetected = false;
        for (const [targetId, target] of this.players) {
          if (targetId === playerId) continue; // Не проверяем столкновение со стрелком

          // Проверяем попадание (учитываем размер пули 10x5)
          if (
            bullet.x < target.x + 70 &&
            bullet.x + 10 > target.x &&
            bullet.y < target.y + 70 &&
            bullet.y + 5 > target.y
          ) {
            // Попадание пули!
            let actualDamage = BULLET_DAMAGE;
            let blocked = false;

            if (target.blocking) {
              // Полная блокировка урона от пули
              actualDamage = 0;
              blocked = true;
            }

            target.health -= actualDamage;
            if (target.health < 0) target.health = 0;

            // Применяем отбрасывание (даже при блоке, но меньше)
            const knockbackForce = blocked
              ? KNOCKBACK_FORCE * 0.2
              : KNOCKBACK_FORCE;
            const knockback =
              bullet.velocityX > 0 ? knockbackForce : -knockbackForce;
            target.x += knockback;
            target.x = Math.max(0, Math.min(640 - 70, target.x));

            // console.log(
            //   `Bullet ${bullet.id} from player ${playerId} ${
            //     blocked ? "blocked by" : "hit"
            //   } player ${targetId} for ${actualDamage} damage. Health: ${
            //     target.health
            //   }`
            // );

            // Отправляем событие попадания пули
            this.broadcast({
              type: "bulletHit",
              shooterId: playerId,
              targetId: targetId,
              damage: actualDamage,
              targetHealth: target.health,
              blocked: blocked,
              knockback: knockback,
              bulletId: bullet.id,
            });

            // Удаляем пулю
            player.bullets.splice(i, 1);
            hitDetected = true;
            break;
          }
        }

        if (hitDetected) continue;
      }

      // Уменьшаем кулдауны
      if (player.shootCooldown > 0) {
        player.shootCooldown--;
      }
      if (player.attackTimer > 0) {
        player.attackTimer--;
        if (player.attackTimer <= 0) {
          player.attacking = false;
        }
      }
    }
  }

  // Добавляем метод для сбора статистики пинга
  addLatencyData(latency) {
    this.latencyHistory.push(latency);
    // Ограничиваем размер истории
    if (this.latencyHistory.length > 20) {
      this.latencyHistory.shift();
    }
  }
}

// Обработка WebSocket соединений
wss.on("connection", (ws, req) => {
  const playerId = gameState.nextPlayerId++;
  gameState.players.set(playerId, { id: playerId, ws: ws, roomId: null });

  console.log(`Player ${playerId} connected from ${req.socket.remoteAddress}`);

  // Отправляем ID игроку
  ws.send(
    JSON.stringify({
      type: "connected",
      playerId: playerId,
    })
  );

  // Обработка сообщений
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(playerId, message);
    } catch (error) {
      console.error("Error parsing message:", error);
    }
  });

  // Обработка отключения
  ws.on("close", () => {
    console.log(`Player ${playerId} disconnected`);
    const player = gameState.players.get(playerId);

    // Убираем игрока из очереди если он там был
    const queueIndex = gameState.queue.indexOf(playerId);
    if (queueIndex > -1) {
      gameState.queue.splice(queueIndex, 1);
      console.log(`Player ${playerId} removed from queue`);
    }

    if (player && player.roomId) {
      const room = gameState.rooms.get(player.roomId);
      if (room) {
        room.removePlayer(playerId);
        room.broadcast({
          type: "playerDisconnected",
          playerId: playerId,
        });

        // Удаляем комнату если она пустая
        if (room.players.size === 0) {
          gameState.rooms.delete(room.id);
          console.log(`Room ${room.id} deleted`);
        }
      }
    }

    gameState.players.delete(playerId);
  });

  // Heartbeat для поддержания соединения
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
});

// Функция обработки сообщений
function handleMessage(playerId, message) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  switch (message.type) {
    case "joinRoom":
      joinRoom(playerId, message.roomId);
      break;

    case "createRoom":
      createRoom(playerId);
      break;

    case "selectFighter":
      selectFighter(playerId, message.fighter);
      break;

    case "ready":
      setPlayerReady(playerId);
      break;

    case "playerInput":
      handlePlayerInput(playerId, message.input);
      break;

    case "ping":
      const latency = Date.now() - message.timestamp;

      // Собираем статистику пинга для оптимизации
      if (player.roomId) {
        const room = gameState.rooms.get(player.roomId);
        if (room) {
          room.addLatencyData(latency);
        }
      }

      player.ws.send(
        JSON.stringify({
          type: "pong",
          timestamp: message.timestamp,
          serverTime: Date.now(),
        })
      );
      break;

    case "joinQueue":
      joinQueue(playerId);
      break;

    case "leaveQueue":
      leaveQueue(playerId);
      break;

    case "leaveRoom":
      leaveRoom(playerId);
      break;

    case "getOnlineCount":
      sendOnlineCount(playerId);
      break;
  }
}

function createRoom(playerId) {
  const roomId = gameState.nextRoomId++;
  const room = new GameRoom(roomId);
  gameState.rooms.set(roomId, room);

  const player = gameState.players.get(playerId);
  player.roomId = roomId;

  room.addPlayer(playerId, player.ws);

  player.ws.send(
    JSON.stringify({
      type: "roomCreated",
      roomId: roomId,
    })
  );

  console.log(`Room ${roomId} created by player ${playerId}`);
}

function joinRoom(playerId, roomId) {
  const room = gameState.rooms.get(roomId);
  if (!room) {
    const player = gameState.players.get(playerId);
    player.ws.send(
      JSON.stringify({
        type: "error",
        message: "Room not found",
      })
    );
    return;
  }

  const player = gameState.players.get(playerId);
  player.roomId = roomId;

  if (room.addPlayer(playerId, player.ws)) {
    player.ws.send(
      JSON.stringify({
        type: "roomJoined",
        roomId: roomId,
        playersCount: room.players.size,
      })
    );

    room.broadcast(
      {
        type: "playerJoined",
        playerId: playerId,
        playersCount: room.players.size,
      },
      playerId
    );
  } else {
    player.ws.send(
      JSON.stringify({
        type: "error",
        message: "Room is full",
      })
    );
  }
}

function selectFighter(playerId, fighter) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  // Сохраняем выбор персонажа в общем состоянии игрока
  player.selectedFighter = fighter;

  // Если игрок в комнате, также обновляем состояние в комнате
  if (player.roomId) {
    const room = gameState.rooms.get(player.roomId);
    if (room) {
      const roomPlayer = room.players.get(playerId);
      if (roomPlayer) {
        roomPlayer.fighter = fighter;

        room.broadcast({
          type: "fighterSelected",
          playerId: playerId,
          fighter: fighter,
        });
      }
    }
  }

  console.log(`Player ${playerId} selected fighter: ${fighter}`);
}

function setPlayerReady(playerId) {
  const player = gameState.players.get(playerId);
  if (!player || !player.roomId) return;

  const room = gameState.rooms.get(player.roomId);
  if (!room) return;

  const roomPlayer = room.players.get(playerId);
  if (roomPlayer) {
    roomPlayer.ready = true;

    room.broadcast({
      type: "playerReady",
      playerId: playerId,
    });

    // Проверяем, готовы ли все игроки
    const allReady = Array.from(room.players.values()).every((p) => p.ready);
    if (allReady && room.players.size === 2) {
      room.startGame();
    }
  }
}

function handlePlayerInput(playerId, input) {
  const player = gameState.players.get(playerId);
  if (!player || !player.roomId) return;

  const room = gameState.rooms.get(player.roomId);
  if (!room) return;

  room.handlePlayerInput(playerId, input);
}

// Функции для системы очереди
function joinQueue(playerId) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  // Проверяем, что игрок не в комнате и не в очереди
  if (player.roomId || gameState.queue.includes(playerId)) {
    player.ws.send(
      JSON.stringify({
        type: "error",
        message: "Already in game or queue",
      })
    );
    return;
  }

  // Добавляем в очередь
  gameState.queue.push(playerId);
  player.queueTime = Date.now();

  console.log(
    `Player ${playerId} joined queue. Queue size: ${gameState.queue.length}`
  );

  // Отправляем подтверждение
  player.ws.send(
    JSON.stringify({
      type: "queueJoined",
      position: gameState.queue.length,
    })
  );

  // Проверяем, можно ли создать матч
  tryCreateMatch();
}

function leaveQueue(playerId) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  const index = gameState.queue.indexOf(playerId);
  if (index > -1) {
    gameState.queue.splice(index, 1);
    console.log(
      `Player ${playerId} left queue. Queue size: ${gameState.queue.length}`
    );

    player.ws.send(
      JSON.stringify({
        type: "queueLeft",
      })
    );
  }
}

function tryCreateMatch() {
  if (gameState.queue.length >= 2) {
    // Берем первых двух игроков из очереди
    const player1Id = gameState.queue.shift();
    const player2Id = gameState.queue.shift();

    const player1 = gameState.players.get(player1Id);
    const player2 = gameState.players.get(player2Id);

    // Проверяем, что оба игрока все еще подключены
    if (
      !player1 ||
      player1.ws.readyState !== WebSocket.OPEN ||
      !player2 ||
      player2.ws.readyState !== WebSocket.OPEN
    ) {
      // Если один из игроков отключился, возвращаем другого в очередь
      if (player1 && player1.ws.readyState === WebSocket.OPEN) {
        gameState.queue.unshift(player1Id);
      }
      if (player2 && player2.ws.readyState === WebSocket.OPEN) {
        gameState.queue.unshift(player2Id);
      }
      return;
    }

    // Создаем комнату для матча
    const roomId = gameState.nextRoomId++;
    const room = new GameRoom(roomId);
    gameState.rooms.set(roomId, room);

    // Добавляем игроков в комнату
    player1.roomId = roomId;
    player2.roomId = roomId;

    room.addPlayer(player1Id, player1.ws);
    room.addPlayer(player2Id, player2.ws);

    // Получаем игроков из комнаты и используем их предварительный выбор персонажей
    const roomPlayer1 = room.players.get(player1Id);
    const roomPlayer2 = room.players.get(player2Id);

    // Устанавливаем персонажей из предварительного выбора или используем значения по умолчанию
    if (roomPlayer1) {
      roomPlayer1.fighter = player1.selectedFighter || "dowand";
      roomPlayer1.ready = true;
    }
    if (roomPlayer2) {
      roomPlayer2.fighter = player2.selectedFighter || "ewon";
      roomPlayer2.ready = true;
    }

    // Автоматически запускаем игру для быстрого матча
    room.startGame();

    // Уведомляем игроков о найденном матче
    const matchData = {
      type: "matchFound",
      roomId: roomId,
    };

    player1.ws.send(
      JSON.stringify({
        ...matchData,
        opponent: player2Id,
      })
    );

    player2.ws.send(
      JSON.stringify({
        ...matchData,
        opponent: player1Id,
      })
    );

    console.log(
      `Match created: Room ${roomId}, Players ${player1Id} vs ${player2Id}`
    );
  }
}

function sendOnlineCount(playerId) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  const onlineCount = gameState.players.size;
  const queueCount = gameState.queue.length;

  player.ws.send(
    JSON.stringify({
      type: "onlineStats",
      onlineCount: onlineCount,
      queueCount: queueCount,
    })
  );
}

function leaveRoom(playerId) {
  const player = gameState.players.get(playerId);
  if (!player) return;

  if (player.roomId) {
    const room = gameState.rooms.get(player.roomId);
    if (room) {
      room.removePlayer(playerId);
      room.broadcast({
        type: "playerDisconnected",
        playerId: playerId,
      });

      // Удаляем комнату если она пустая
      if (room.players.size === 0) {
        gameState.rooms.delete(room.id);
        console.log(`Room ${room.id} deleted`);
      }
    }
    player.roomId = null;
  }

  // Сбрасываем состояние игрока
  if (player) {
    player.selectedFighter = null;
    delete player.ready;
    delete player.fighter;
    delete player.x;
    delete player.y;
    delete player.health;
    delete player.facing;
    delete player.attacking;
    delete player.blocking;
    delete player.bullets;
    delete player.shootCooldown;
    delete player.attackTimer;
    delete player.lastInputTime;
  }

  player.ws.send(
    JSON.stringify({
      type: "roomLeft",
    })
  );

  console.log(`Player ${playerId} left room and state reset`);
}

// Оптимизированный heartbeat для продакшена
const heartbeatInterval = isProduction ? 30000 : 15000; // 30 сек для продакшена, 15 для локальной разработки
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, heartbeatInterval);

// Очистка при завершении
wss.on("close", () => {
  clearInterval(heartbeat);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WebSocket сервер запущен на порту ${PORT}`);
  console.log(`Откройте http://localhost:${PORT} в браузере`);
  if (isProduction) {
    console.log("Продакшен режим: оптимизации для пинга активированы");
  }
});
