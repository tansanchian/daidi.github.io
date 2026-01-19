/***********************
 * 锄大地 Session Tracker
 * Static app (GitHub Pages)
 * Hash routes:
 *  - #/                  Home
 *  - #/session/<id>      Session
 *  - #/session/<id>/game Game timer
 ***********************/

const LS_KEY = "chodaidi_sessions_v2";

/** ---------- Storage ---------- **/
function loadSessions() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveSessions(sessions) {
  localStorage.setItem(LS_KEY, JSON.stringify(sessions));
}
function resetAll() {
  localStorage.removeItem(LS_KEY);
}

/** ---------- Utils ---------- **/
function uid() {
  return Math.random().toString(36).slice(2, 10) + "_" + Date.now().toString(36);
}
function clampInt(v, min = 0, max = 9999) {
  const n = parseInt(String(v ?? "0"), 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
function clampMoney(v) {
  const n = Number.parseFloat(String(v ?? "0"));
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100) / 100;
}
function formatMoney(n) {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}
function nowStamp() {
  return new Date().toLocaleString();
}
function $(sel) {
  return document.querySelector(sel);
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[m]));
}

/** ---------- Modal ---------- **/
const modalOverlay = $("#modalOverlay");
const modalTitle = $("#modalTitle");
const modalBody = $("#modalBody");
const modalFooter = $("#modalFooter");
const modalClose = $("#modalClose");

let modalOnClose = null;

function openModal({ title, bodyHtml, footerHtml, onClose }) {
  modalOnClose = typeof onClose === "function" ? onClose : null;

  modalTitle.textContent = title || "Modal";
  modalBody.innerHTML = bodyHtml || "";
  modalFooter.innerHTML = footerHtml || "";
  modalOverlay.classList.remove("hidden");
  modalOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal() {
  // run optional onClose if provided
  if (modalOnClose) {
    const fn = modalOnClose;
    modalOnClose = null;
    fn();
  } else {
    modalOnClose = null;
  }

  modalOverlay.classList.add("hidden");
  modalOverlay.setAttribute("aria-hidden", "true");
  modalBody.innerHTML = "";
  modalFooter.innerHTML = "";
  document.body.classList.remove("modal-open");
}

modalClose.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeModal();
});
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

/** ---------- App State ---------- **/
let sessions = loadSessions();
const app = $("#app");

$("#btnHome").addEventListener("click", () => {
  location.hash = "#/";
});
$("#btnReset").addEventListener("click", () => {
  openModal({
    title: "Reset All Data?",
    bodyHtml: `<p class="p">This will delete all sessions and history on this device.</p>`,
    footerHtml: `
      <button class="btn ghost" id="mCancel">Cancel</button>
      <button class="btn danger" id="mConfirm">Yes, Reset</button>
    `
  });
  $("#mCancel").onclick = closeModal;
  $("#mConfirm").onclick = () => {
    resetAll();
    sessions = [];
    closeModal();
    location.hash = "#/";
    render();
  };
});

/** ---------- Settlement Logic (YOUR RULES) ---------- **
Rules:
1) Winner = player with 0 remaining cards (exactly one winner)
2) Each non-winner pays winner: baseBet + remainingCards * betPerCard
   PLUS within non-winners, higher remaining pays lower remaining:
     if rB > rA: B pays (rB - rA) * betPerCard to A
3) Special combos:
   each combo earns reward FROM EACH other player
**/
function calcGameDeltas({ players, baseBet, betPerCard, rewardSF, rewardKK, stats }) {
  const ids = players.map(p => p.id);

  // Winner must exist and be unique (0 remaining)
  const winners = players.filter(p => clampInt(stats[p.id]?.remainingCards, 0, 100) === 0);
  if (winners.length !== 1) {
    return { error: "Need exactly ONE winner with 0 remaining cards." };
  }
  const winnerId = winners[0].id;

  const deltas = Object.fromEntries(ids.map(id => [id, 0]));

  const transfer = (fromId, toId, amount) => {
    const a = clampMoney(amount);
    if (a === 0) return;
    deltas[fromId] = clampMoney(deltas[fromId] - a);
    deltas[toId]   = clampMoney(deltas[toId] + a);
  };

  // 2) Each loser pays winner: baseBet + remainingCards * betPerCard
  for (const p of players) {
    const r = clampInt(stats[p.id]?.remainingCards, 0, 100);
    if (p.id === winnerId) continue;
    transfer(p.id, winnerId, baseBet + r * betPerCard);
  }

  // 2b) Among losers: higher remaining pays lower remaining diff * betPerCard
  const losers = players
    .filter(p => p.id !== winnerId)
    .map(p => ({ id: p.id, r: clampInt(stats[p.id]?.remainingCards, 0, 100) }));

  // pairwise i<j, pay from higher r to lower r
  for (let i = 0; i < losers.length; i++) {
    for (let j = i + 1; j < losers.length; j++) {
      const A = losers[i], B = losers[j];
      if (A.r === B.r) continue;
      if (A.r > B.r) transfer(A.id, B.id, (A.r - B.r) * betPerCard);
      else           transfer(B.id, A.id, (B.r - A.r) * betPerCard);
    }
  }

  // 3) Specials: each combo earns reward from each other player
  for (const p of players) {
    const sf = clampInt(stats[p.id]?.sfCount, 0, 50);
    const kk = clampInt(stats[p.id]?.kkCount, 0, 50);
    const earnPerOpponent = sf * rewardSF + kk * rewardKK;
    if (earnPerOpponent === 0) continue;

    for (const other of players) {
      if (other.id === p.id) continue;
      transfer(other.id, p.id, earnPerOpponent);
    }
  }

  // sanity sum (should be 0)
  const sum = clampMoney(ids.reduce((acc, id) => acc + deltas[id], 0));
  return { winnerId, deltas, sum };
}


/** ---------- Router ---------- **/
window.addEventListener("hashchange", render);

function parseRoute() {
  const h = location.hash.replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  // routes:
  // [] => home
  // ["session", id] => session
  // ["session", id, "game"] => game
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "session" && parts[1] && parts.length === 2) return { name: "session", id: parts[1] };
  if (parts[0] === "session" && parts[1] && parts[2] === "game") return { name: "game", id: parts[1] };
  return { name: "home" };
}

function getSession(id) {
  return sessions.find(s => s.id === id);
}
function updateSession(updated) {
  const idx = sessions.findIndex(s => s.id === updated.id);
  if (idx === -1) return;

  // Replace with a deep copy so nothing gets lost by reference weirdness
  sessions[idx] = JSON.parse(JSON.stringify(updated));
  saveSessions(sessions);
}


/** ---------- Views ---------- **/
function render() {
  const route = parseRoute();
  if (route.name === "home") return renderHome();
  if (route.name === "session") return renderSession(route.id);
  if (route.name === "game") return renderGame(route.id);
  return renderHome();
}

function renderHome() {
  app.innerHTML = `
    <div class="card section">
      <div class="h1">Create a new 锄大地 session</div>
      <p class="p">Set the betting rules once, then track game records and running balances.</p>

      <div class="hr"></div>

      <div class="grid two">
        <div>
          <label>Session name</label>
          <input id="sName" class="input" placeholder="e.g. Friday Night @ UTown" />
        </div>
        <div>
          <label>Player names (comma separated)</label>
          <input id="pNames" class="input" placeholder="A, B, C, D" value="Player A, Player B, Player C, Player D"/>
        </div>

        <div>
          <label>Base bet</label>
          <input id="baseBet" class="input" type="number" step="0.01" value="1" />
        </div>
        <div>
          <label>Bet per card</label>
          <input id="betPerCard" class="input" type="number" step="0.01" value="0.5" />
        </div>

        <div>
          <label>Reward per 同花顺</label>
          <input id="rewardSF" class="input" type="number" step="0.01" value="5" />
        </div>
        <div>
          <label>Reward per 金刚</label>
          <input id="rewardKK" class="input" type="number" step="0.01" value="10" />
        </div>
      </div>

      <div class="hr"></div>

      <div class="row">
        <button id="createSession" class="btn primary">Create Session</button>
      </div>
    </div>

    <div class="card section" style="margin-top:14px;">
      <div class="spread">
        <div>
          <div class="h2">Existing sessions</div>
          <p class="p">Stored on this device (localStorage).</p>
        </div>
      </div>

      <div class="hr"></div>

      <div id="sessionList"></div>
    </div>
  `;

  $("#createSession").onclick = () => {
    const name = ($("#sName").value || "Untitled Session").trim();
    const rawPlayers = ($("#pNames").value || "").split(",").map(s => s.trim()).filter(Boolean);
    const playerNames = rawPlayers.length >= 4 ? rawPlayers.slice(0,4) : ["Player A","Player B","Player C","Player D"];

    const session = {
      id: uid(),
      name,
      createdAt: nowStamp(),
      rules: {
        baseBet: clampMoney($("#baseBet").value),
        betPerCard: clampMoney($("#betPerCard").value),
        rewardSF: clampMoney($("#rewardSF").value),
        rewardKK: clampMoney($("#rewardKK").value),
      },
      players: playerNames.map((n, idx) => ({
        id: `p${idx+1}`,
        name: n,
        balance: 0,
      })),
      games: []
    };

    sessions.unshift(session);
    saveSessions(sessions);
    location.hash = `#/session/${session.id}`;
  };

  // List sessions
  const list = $("#sessionList");
  if (sessions.length === 0) {
    list.innerHTML = `<p class="p">No sessions yet. Create one above.</p>`;
  } else {
    list.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Session</th><th>Created</th><th>Rules</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map(s => `
            <tr>
              <td><strong>${escapeHtml(s.name)}</strong></td>
              <td>${escapeHtml(s.createdAt)}</td>
              <td>
                <span class="pill">Base ${s.rules.baseBet}</span>
                <span class="pill">/ Card ${s.rules.betPerCard}</span>
                <span class="pill">SF ${s.rules.rewardSF}</span>
                <span class="pill">KK ${s.rules.rewardKK}</span>
              </td>
              <td><button class="btn ghost" data-open="${s.id}">Open</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    list.querySelectorAll("button[data-open]").forEach(btn => {
      btn.onclick = () => location.hash = `#/session/${btn.dataset.open}`;
    });
  }
}

function renderSession(id) {
  const session = getSession(id);
  if (!session) {
    app.innerHTML = `<div class="card section"><p class="p">Session not found.</p></div>`;
    return;
  }

  const { baseBet, betPerCard, rewardSF, rewardKK } = session.rules;

  app.innerHTML = `
    <div class="card section">
      <div class="spread">
        <div>
          <div class="h1">${escapeHtml(session.name)}</div>
          <p class="p">Created: ${escapeHtml(session.createdAt)}</p>
          <div class="row" style="margin-top:10px;">
            <span class="pill">Base: ${baseBet}</span>
            <span class="pill">Per card: ${betPerCard}</span>
            <span class="pill">同花顺: ${rewardSF}</span>
            <span class="pill">金刚: ${rewardKK}</span>
          </div>
        </div>
        <div class="row">
          <button id="editPlayers" class="btn ghost">Edit Players</button>
          <button id="startGame" class="btn success">Start New Game</button>
        </div>
      </div>

      <div class="hr"></div>

      <div class="h2">Players</div>
      <div class="player-grid" id="playerGrid"></div>
    </div>

    <div class="card section" style="margin-top:14px;">
      <div class="spread">
        <div>
          <div class="h2">Game Records</div>
          <p class="p">Each record shows delta for each player, and balances update automatically.</p>
        </div>
        <button id="clearGames" class="btn ghost danger">Clear Records</button>
      </div>
      <div class="hr"></div>
      <div id="gamesList"></div>
    </div>
  `;

  // Players UI
  const grid = $("#playerGrid");
  grid.innerHTML = session.players.map((p, idx) => {
    const bal = clampMoney(p.balance);
    const tone = bal > 0 ? "good" : bal < 0 ? "bad" : "neutral";
    return `
      <div class="player">
        <div class="avatar">${idx+1}</div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="balance">${formatMoney(bal)}</div>
        <div class="muted">
          <span class="pill ${tone}">${bal > 0 ? "Earn" : bal < 0 ? "Owe" : "Even"}</span>
        </div>
      </div>
    `;
  }).join("");

  // Start game
  $("#startGame").onclick = () => {
    // store start time on session
    session.currentGame = { startedAtMs: Date.now() };
    updateSession(session);
    location.hash = `#/session/${session.id}/game`;
  };

  // Edit players
  $("#editPlayers").onclick = () => {
    const body = `
      <p class="p" style="margin-bottom:10px;">Edit player names (balances remain).</p>
      <div class="grid two">
        ${session.players.map((p,i)=>`
          <div>
            <label>Player ${i+1}</label>
            <input class="input" id="pn_${p.id}" value="${escapeHtml(p.name)}" />
          </div>
        `).join("")}
      </div>
    `;
    openModal({
      title: "Edit Players",
      bodyHtml: body,
      footerHtml: `
        <button class="btn ghost" id="mCancel">Cancel</button>
        <button class="btn primary" id="mSave">Save</button>
      `
    });
    $("#mCancel").onclick = closeModal;
    $("#mSave").onclick = () => {
      session.players = session.players.map(p => ({
        ...p,
        name: ($("#pn_" + p.id).value || p.name).trim() || p.name
      }));
      updateSession(session);
      closeModal();
      renderSession(session.id);
    };
  };

  // Clear games
  $("#clearGames").onclick = () => {
    openModal({
      title: "Clear all records?",
      bodyHtml: `<p class="p">This will reset balances to 0 and remove all game history for this session.</p>`,
      footerHtml: `
        <button class="btn ghost" id="mCancel">Cancel</button>
        <button class="btn danger" id="mConfirm">Clear</button>
      `
    });
    $("#mCancel").onclick = closeModal;
    $("#mConfirm").onclick = () => {
      session.games = [];
      session.players = session.players.map(p => ({...p, balance: 0}));
      delete session.currentGame;
      updateSession(session);
      closeModal();
      renderSession(session.id);
    };
  };

  // Games list
  const gamesList = $("#gamesList");
  if (!session.games || session.games.length === 0) {
    gamesList.innerHTML = `<p class="p">No games recorded yet. Click “Start New Game”.</p>`;
  } else {
    gamesList.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>#</th><th>Time</th><th>Winner</th><th>Deltas</th>
          </tr>
        </thead>
        <tbody>
          ${session.games.slice().reverse().map((g, idx) => {
            const gameNo = session.games.length - idx;
            const winnerName = session.players.find(p => p.id === g.winnerId)?.name || "Winner";
            const deltasHtml = session.players.map(p => {
              const d = g.deltas[p.id] ?? 0;
              const cls = d > 0 ? "good" : d < 0 ? "bad" : "";
              return `<span class="pill ${cls}">${escapeHtml(p.name)} ${formatMoney(clampMoney(d))}</span>`;
            }).join(" ");
            return `
              <tr>
                <td><strong>${gameNo}</strong></td>
                <td>${escapeHtml(g.endedAt)}</td>
                <td>${escapeHtml(winnerName)}</td>
                <td>${deltasHtml}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  }
}

let timerInterval = null;

function renderGame(id) {
  const session = getSession(id);
  if (!session) {
    app.innerHTML = `<div class="card section"><p class="p">Session not found.</p></div>`;
    return;
  }

  const startedAtMs = session.currentGame?.startedAtMs ?? Date.now();
  session.currentGame = session.currentGame || { startedAtMs };
  updateSession(session);

  app.innerHTML = `
    <div class="card section">
      <div class="spread">
        <div>
          <div class="h1">Game in progress</div>
          <p class="p">${escapeHtml(session.name)}</p>
        </div>
        <div class="row">
          <button id="backToSession" class="btn ghost">Back</button>
        </div>
      </div>

      <div class="hr"></div>

      <div class="timer" id="timer">00:00</div>
      <p class="p" style="margin-top:8px;">Timer starts when you click “Start New Game”.</p>

      <div class="hr"></div>

      <div class="row">
        <button id="endGame" class="btn danger">End Game</button>
      </div>
    </div>
  `;

  $("#backToSession").onclick = () => {
    location.hash = `#/session/${session.id}`;
  };

  // Timer
  function renderTimer() {
    const elapsed = Math.max(0, Date.now() - startedAtMs);
    const sec = Math.floor(elapsed / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    $("#timer").textContent = `${mm}:${ss}`;
  }
  renderTimer();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(renderTimer, 250);

  $("#endGame").onclick = () => {
    // ✅ Do NOT end game here
    // ✅ Do NOT stop timer here
    // ✅ Just open the modal for data entry
    openModal({
      title: "End Game — Enter Results",
      bodyHtml: `
        <p class="p" style="margin-bottom:10px;">
          Enter results for each player.
          <br/>Rule: Winner must have <strong>0</strong> remaining cards (exactly one winner).
        </p>
  
        <div class="card section" style="background:rgba(0,0,0,.12); border-radius:16px;">
          <div class="grid" style="gap:10px;">
            ${session.players.map((p, i) => `
              <div class="card section" style="background:rgba(0,0,0,.10); border-radius:16px;">
                <div class="spread" style="margin-bottom:8px;">
                  <div><strong>${escapeHtml(p.name)}</strong></div>
                  <span class="pill">Player ${i + 1}</span>
                </div>
  
                <div class="grid two">
                  <div>
                    <label>Remaining cards</label>
                    <input class="input" type="number" min="0" max="52" step="1"
                          id="rem_${p.id}" value="3">
                  </div>
  
                  <div>
                    <label>同花顺 count</label>
                    <input class="input" type="number" min="0" max="50" step="1"
                          id="sf_${p.id}" value="0">
                  </div>
  
                  <div>
                    <label>金刚 count</label>
                    <input class="input" type="number" min="0" max="50" step="1"
                          id="kk_${p.id}" value="0">
                  </div>
  
                  <div>
                    <label>Notes (optional)</label>
                    <input class="input" id="note_${p.id}" placeholder="e.g. went out fast" />
                  </div>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
  
        <div class="hr"></div>
        <p class="p">
          Settlement rules:
          <br/>• Loser → Winner: <code>baseBet + remainingCards * betPerCard</code>
          <br/>• Among losers: higher remaining pays lower remaining:
            <code>(remainingDiff) * betPerCard</code>
          <br/>• Specials: each 同花顺 / 金刚 earns from each other player.
        </p>
      `,
      footerHtml: `
        <button class="btn ghost" id="mClose">Close</button>
        <button class="btn primary" id="mCompute">Save Record</button>
      `,
      onClose: null // ✅ closing the modal does NOTHING
    });
  
    $("#mClose").onclick = closeModal;
  
    $("#mCompute").onclick = () => {
      // ✅ ONLY HERE the game ends and record is saved
  
      const stats = {};
      for (const p of session.players) {
        stats[p.id] = {
          remainingCards: clampInt($("#rem_" + p.id).value, 0, 52),
          sfCount: clampInt($("#sf_" + p.id).value, 0, 50),
          kkCount: clampInt($("#kk_" + p.id).value, 0, 50),
          note: ($("#note_" + p.id).value || "").trim()
        };
      }
  
      const res = calcGameDeltas({
        players: session.players,
        baseBet: session.rules.baseBet,
        betPerCard: session.rules.betPerCard,
        rewardSF: session.rules.rewardSF,
        rewardKK: session.rules.rewardKK,
        stats
      });
  
      if (res.error) { alert(res.error); return; }
  
      // Apply balances
      session.players = session.players.map(p => ({
        ...p,
        balance: clampMoney((p.balance ?? 0) + (res.deltas[p.id] ?? 0))
      }));
  
      // Save game record
      session.games = session.games || [];
      session.games.push({
        id: uid(),
        startedAt: new Date(startedAtMs).toLocaleString(),
        endedAt: nowStamp(),
        durationSec: Math.floor((Date.now() - startedAtMs) / 1000),
        winnerId: res.winnerId,
        deltas: res.deltas,
        stats
      });
  
      // ✅ END GAME NOW
      delete session.currentGame;
      updateSession(session);
  
      // stop timer and go back
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
  
      closeModal();
      location.hash = `#/session/${session.id}`;
      render();
    };
  };
};  
/** ---------- Boot ---------- **/
  (function init() {
    if (!location.hash) location.hash = "#/";
    render();
  })();
