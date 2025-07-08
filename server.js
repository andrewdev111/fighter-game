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
const wss = new WebSocket.Server({ server });

// Игровое состояние
const gameState = {
  players: new Map(),
  rooms: new Map(),
  queue: [], // Очередь для поиска игры
  nextPlayerId: 1,
  nextRoomId: 1,
};

// Класс комнаты для игры
class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.gameStarted = false;
    this.lastUpdate = Date.now();
    this.tickRate = 60; // 60 FPS для плавной игры
    this.tickInterval = 1000 / this.tickRate;
    this.gameLoop = null;
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

    // Обновляем пули перед отправкой состояния
    this.updateBullets();

    // Собираем все пули от всех игроков
    let allBullets = [];
    this.players.forEach((player) => {
      if (player.bullets && player.bullets.length > 0) {
        allBullets = allBullets.concat(player.bullets);
      }
    });

    // Собираем состояние всех игроков
    const gameUpdate = {
      type: "gameUpdate",
      timestamp: now,
      players: Array.from(this.players.values()).map((player) => ({
        id: player.id,
        movement: {
          x: player.x,
          y: player.y,
          facing: player.facing,
        },
        actions: {
          attacking: player.attacking,
          blocking: player.blocking,
        },
        health: player.health,
        fighter: player.fighter,
      })),
      bullets: allBullets, // Отправляем все пули отдельно
    };

    // Отправляем обновление всем игрокам
    this.broadcast(gameUpdate);
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
      player.facing = input.movement.facing;
    }

    if (input.actions) {
      // Обрабатываем атаки на сервере
      if (input.actions.attacking && !player.attacking) {
        player.attacking = input.actions.attacking;
        player.attackTimer = 30; // MELEE_ATTACK_DURATION

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
        player.shootCooldown = 30; // SHOOT_COOLDOWN

        console.log(
          `Player ${playerId} shot bullet at ${bullet.x}, ${bullet.y}`
        );
      }
    }

    // Обновляем пули и проверяем коллизии
    this.updateBullets();

    // Немедленно отправляем обновление другим игрокам для минимальной задержки
    this.broadcast(
      {
        type: "playerInput",
        playerId: playerId,
        input: input,
        timestamp: Date.now(),
      },
      playerId
    );
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
      if (target.blocking) {
        actualDamage *= 1 - BLOCK_DAMAGE_REDUCTION;
      }

      target.health -= actualDamage;
      if (target.health < 0) target.health = 0;

      // Применяем отбрасывание
      if (attacker.facing) {
        target.x += KNOCKBACK_FORCE;
      } else {
        target.x -= KNOCKBACK_FORCE;
      }

      // Ограничиваем позицию в пределах экрана
      target.x = Math.max(0, Math.min(640 - 70, target.x));

      console.log(
        `Player ${attackerId} hit player ${target.id} for ${actualDamage} damage. Health: ${target.health}`
      );

      // Отправляем событие попадания
      this.broadcast({
        type: "playerHit",
        attackerId: attackerId,
        targetId: target.id,
        damage: actualDamage,
        targetHealth: target.health,
        knockback: attacker.facing ? KNOCKBACK_FORCE : -KNOCKBACK_FORCE,
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

        // Двигаем пулю по её траектории
        bullet.x += bullet.velocityX;
        bullet.y += bullet.velocityY;

        // Удаляем пули, вылетевшие за экран
        if (
          bullet.x < -20 ||
          bullet.x > 660 ||
          bullet.y < -20 ||
          bullet.y > 380
        ) {
          player.bullets.splice(i, 1);
          console.log(`Bullet ${bullet.id} removed (out of bounds)`);
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
            if (target.blocking) {
              actualDamage *= 1 - BLOCK_DAMAGE_REDUCTION;
            }

            target.health -= actualDamage;
            if (target.health < 0) target.health = 0;

            // Применяем отбрасывание
            const knockback =
              bullet.velocityX > 0 ? KNOCKBACK_FORCE : -KNOCKBACK_FORCE;
            target.x += knockback;
            target.x = Math.max(0, Math.min(640 - 70, target.x));

            console.log(
              `Bullet ${bullet.id} from player ${playerId} hit player ${targetId} for ${actualDamage} damage. Health: ${target.health}`
            );

            // Отправляем событие попадания пули
            this.broadcast({
              type: "bulletHit",
              shooterId: playerId,
              targetId: targetId,
              damage: actualDamage,
              targetHealth: target.health,
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

// Heartbeat для проверки соединений
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // Каждые 30 секунд

// Очистка при завершении
wss.on("close", () => {
  clearInterval(heartbeat);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WebSocket сервер запущен на порту ${PORT}`);
  console.log(`Откройте http://localhost:${PORT} в браузере`);
});
