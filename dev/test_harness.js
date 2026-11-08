// dev/test_harness.js — drives the game from the browser console for logic tests.
// Load it in the running game (served by dev/server.js) with:
//   await (await fetch('/dev/test_harness.js')).text().then(eval)
// It steps frames by hand, so it also works while the window is hidden.
(() => {
  SceneManager.isGameActive = () => true;
  const H = (window.HT = {});
  H.step = (n = 1) => { for (let i = 0; i < n; i++) SceneManager.updateMain(); return SceneManager._scene && SceneManager._scene.constructor.name; };
  H.run = async (frames, chunk = 10) => { for (let i = 0; i < frames; i += chunk) { H.step(chunk); await new Promise((r) => setTimeout(r, 0)); } };
  H.press = async (key, hold = 2) => { Input._currentState[key] = true; await H.run(hold, 1); Input._currentState[key] = false; await H.run(6, 1); };
  H.until = async (fn, max = 3000) => { for (let i = 0; i < max; i += 5) { if (fn()) return i; await H.run(5, 5); } return -1; };
  H.phase = () => $gameSystem.isBattlePhase() + "/" + $gameSystem.isSubBattlePhase();
  H.unit = (name) => $gameMap.events().map((e) => [e, $gameSystem.EventToUnit(e.eventId())])
    .find(([e, u]) => u && u[1].name() === name);
  H.menu = () => { const w = SceneManager._scene._mapSrpgActorCommandWindow; return w && w.isOpen() && w._list ? w._list.map((c) => (c.enabled ? "" : "~") + c.name) : null; };
  H.help = () => SceneManager._scene._helpWindow._text;
  H.state = () => {
    const ev = $gameTemp.activeEvent(); const u = ev && $gameSystem.EventToUnit(ev.eventId());
    return { phase: H.phase(), active: u ? `${u[1].name()}@${ev.posX()},${ev.posY()}` : null,
      turn: u ? u[1].honTurn() : null, cd: u ? u[1].honCooldowns() : null, menu: H.menu(), errors: HoN.errors.slice() };
  };
  // Render the current frame and save it as dev/screenshots/<name>.png (needs dev/server.js).
  H.shot = async (name) => {
    const url = SceneManager.snap().canvas.toDataURL("image/png");
    return (await fetch(`/dev/shot/${name}.png`, { method: "POST", body: url })).text();
  };
  // Title -> new game -> battle prepare -> first player turn.
  H.startBattle = async () => {
    await H.until(() => H.step(0) === "Scene_Title" && SceneManager._scene._commandWindow && SceneManager._scene._commandWindow.isOpen(), 4000);
    SceneManager._scene.commandNewGame();
    await H.until(() => H.step(0) === "Scene_Menu" || (H.step(0) === "Scene_Map" && $gameSystem.isBattlePhase() === "actor_phase"), 4000);
    if (H.step(0) === "Scene_Menu") await H.press("ok"); // "Ready" in battle prepare
    return H.until(() => H.step(0) === "Scene_Map" && H.phase() === "actor_phase/normal" && !$gameMap.isEventRunning(), 4000);
  };
  // Select the unit standing on (x, y) and open its menu.
  H.select = async (x, y) => { $gamePlayer.locate(x, y); await H.press("ok"); await H.run(20); return H.state(); };
  // Choose a menu entry by name.
  H.choose = async (name) => {
    const w = SceneManager._scene._mapSrpgActorCommandWindow;
    await H.until(() => w.isOpen() && w.active, 300);
    const i = w._list.findIndex((c) => c.name === name);
    if (i < 0) throw new Error(`"${name}" is not in the menu: ${H.menu()}`);
    w.select(i); await H.press("ok"); await H.run(15); return H.phase();
  };
  // End every hero's turn (closing whatever menu is open) until the enemy phase starts.
  H.endHeroTurn = async () => {
    for (let guard = 0; guard < 20 && $gameSystem.isBattlePhase() === "actor_phase"; guard++) {
      if ($gameSystem.isSubBattlePhase() === "actor_command_window") { await H.choose("Encerrar"); await H.run(20); continue; }
      const next = HoN.allUnits().find((u) => u.isActor() && u.canInput());
      if (!next) break;
      await H.select(next.event().posX(), next.event().posY());
    }
    return H.until(() => $gameSystem.isBattlePhase() === "enemy_phase", 2000);
  };
  // Let the enemy phase play out (skipping messages) until the heroes' turn is back.
  H.untilHeroTurn = async () => {
    const t = await H.until(() => {
      if ($gameMessage.isBusy()) Input._currentState.ok = !Input._currentState.ok;
      return H.phase() === "actor_phase/normal" && !$gameMap.isEventRunning() && H.step(0) === "Scene_Map";
    }, 30000);
    Input._currentState.ok = false;
    return t;
  };
  // Confirm a cell (move destination or target) and wait until the menu is back or the turn moved on.
  H.confirmAt = async (x, y) => {
    $gamePlayer.locate(x, y); await H.press("ok");
    await H.until(() => !$gameSystem.srpgWaitMoving() && !$gameMap.isEventRunning() &&
      ["actor_command_window", "normal"].includes($gameSystem.isSubBattlePhase()) && H.step(0) === "Scene_Map", 4000);
    await H.run(30); return H.state();
  };
})();
