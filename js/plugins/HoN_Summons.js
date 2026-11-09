//=============================================================================
// HoN_Summons.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc [v0.1] Heroes of Nowhere - <summon> on skills, on top of SRPG_Summon_MZ.
 * @author Heroes of Nowhere
 * @base SRPG_Summon_MZ
 * @base HoN_States
 * @orderAfter HoN_Targeting
 *
 * @help
 * ============================================================================
 * Skill tags
 * ============================================================================
 *   <summon>
 *   actor: 120          who to summon (actor id; a copy, so it can appear many
 *                       times; it joins the summoner's side and isn't counted
 *                       for victory or defeat). Or "enemy: 5".
 *   at: target          target = the chosen cell, user = next to the summoner
 *   count: 1            how many (formula, a = summoner); extra ones go on the
 *                       nearest free cells
 *   animation: 194      played on each summoned unit
 *   level: a.level      optional
 *   </summon>
 *
 *   <script:summoned>   runs for each summoned unit: a = summoner, b = summoned
 *   b.addState(232);    e.g. the state that holds its lifespan
 *   </script>
 *
 * The summon happens once per action, after its effects. Summoned units act
 * on the turn they appear.
 *
 * ============================================================================
 * Ending a summon
 * ============================================================================
 *   user.honDesummon()  removes a summoned unit from the battle with a fade.
 *   Put it in the <script:remove> of the state that holds the lifespan, so the
 *   summon leaves when that state runs out.
 */

var Imported = Imported || {};
Imported.HoN_Summons = "0.1";

(() => {
    "use strict";
    const S = (HoN.Summons = {});
    const core = PluginManager.parameters("SRPG_core_MZ");
    const ENEMY_VAR = Number(core["existEnemyVarID"] || 2);
    const TEMPLATE_EVENT = 1; // blank template on the summon map

    //=========================================================================
    // Tags
    //=========================================================================
    const _parseNotes = HoN.parseNotes;
    HoN.parseNotes = function(obj, kind) {
        _parseNotes.call(this, obj, kind);
        const m = (obj.note || "").match(/<summon>([\s\S]*?)<\/summon>/i);
        if (!m) return;
        const label = `${kind} ${obj.id} ${obj.name} <summon>`;
        const field = (k) => { const f = m[1].match(new RegExp("^\\s*" + k + "\\s*:\\s*(.+?)\\s*$", "im")); return f ? f[1] : null; };
        const spec = {
            type: field("enemy") ? "enemy" : "guest",
            id: Number(field("enemy") || field("actor")),
            at: (field("at") || "target").toLowerCase(),
            count: HoN.compileExpression(field("count") || "1", label + " count"),
            animation: Number(field("animation") || 0),
            mode: field("mode") || "normal",
        };
        if (field("level")) spec.level = HoN.compileExpression(field("level"), label + " level");
        if (!spec.id) HoN.reportError(label, new Error("needs 'actor:' or 'enemy:'"));
        else obj.hon.summon = spec;
    };

    //=========================================================================
    // Where the player aimed (cell-target skills keep the cursor on the cell)
    //=========================================================================
    const _srpgBattleStart = Scene_Map.prototype.srpgBattleStart;
    Scene_Map.prototype.srpgBattleStart = function(userArray, targetArray) {
        const action = userArray[1] && userArray[1].currentAction();
        const item = action && action.item();
        if (item && item.hon && item.hon.summon) {
            const target = $gameTemp.targetEvent();
            const cell = item.meta.cellTarget || !target ? [$gamePlayer.posX(), $gamePlayer.posY()]
                : [target.posX(), target.posY()];
            $gameTemp._honSummonCell = cell;
        }
        return _srpgBattleStart.call(this, userArray, targetArray);
    };

    //=========================================================================
    // Summoning
    //=========================================================================
    // Free cells around (x, y), nearest first, the centre included.
    S.cellsAround = function(x, y, type) {
        const seen = new Set(), out = [];
        const queue = [[x, y]];
        while (queue.length && out.length < 40) {
            const [cx, cy] = queue.shift();
            const key = cx + "," + cy;
            if (seen.has(key) || !$gameMap.isValid(cx, cy)) continue;
            seen.add(key);
            if ($gameMap.canSummon(type === "guest" ? "actor" : type, TEMPLATE_EVENT, 0, cx, cy)) out.push([cx, cy]);
            if (Math.abs(cx - x) + Math.abs(cy - y) < 4) {
                for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) queue.push([cx + dx, cy + dy]);
            }
        }
        return out;
    };

    S.perform = function(summoner, item) {
        const spec = item.hon.summon;
        const userEvent = summoner.event();
        if (!userEvent) return [];
        const count = Math.max(1, Math.floor(Number(HoN.run(spec.count, summoner, null, item, 0, 1)) || 1));
        const level = spec.level ? Math.max(1, Math.floor(Number(HoN.run(spec.level, summoner, null, item, 0, 1)) || 1)) : undefined;
        let cells;
        if (spec.at === "user") {
            cells = S.cellsAround(userEvent.posX(), userEvent.posY(), spec.type);
        } else {
            const [x, y] = $gameTemp._honSummonCell || [$gamePlayer.posX(), $gamePlayer.posY()];
            cells = S.cellsAround(x, y, spec.type);
        }
        const interpreter = new Game_Interpreter();
        const made = [];
        for (const [x, y] of cells.slice(0, count)) {
            const eventId = $gameMap.nextEventId();
            interpreter.summon(spec.type, TEMPLATE_EVENT, spec.id, level, undefined, x, y, spec.mode);
            const arr = $gameSystem.EventToUnit(eventId);
            if (!arr || !arr[1]) continue;
            const unit = arr[1];
            unit._honSummoned = true;
            unit.SRPGActionTimesSet(); // fresh turn: it can act right away
            const previous = HoN.currentSubject;
            HoN.currentSubject = summoner; // states it gets count down on the summoner's side
            try {
                const fn = item.hon.scripts && item.hon.scripts.summoned;
                if (fn) HoN.run(fn, summoner, unit, item, 0);
            } finally {
                HoN.currentSubject = previous;
            }
            const event = $gameMap.event(eventId);
            if (spec.animation && event) $gameTemp.requestAnimation([event], spec.animation);
            made.push(unit);
        }
        $gameTemp._honSummonCell = null;
        if (HoN.refreshAuras) HoN.refreshAuras();
        return made;
    };

    const _applyGlobal = Game_Action.prototype.applyGlobal;
    Game_Action.prototype.applyGlobal = function() {
        _applyGlobal.call(this);
        const item = this.item();
        if (item && item.hon && item.hon.summon && $gameSystem.isSRPGMode()) S.perform(this.subject(), item);
    };

    //=========================================================================
    // Ending a summon
    //=========================================================================
    // Like Gear's removeUnit, but for summons: the unit is detached from its
    // event (an erased event that still had a living unit would keep Gear's
    // turn waiting for it), and summoned heroes were never counted as party.
    Game_Battler.prototype.honDesummon = function() {
        const event = this.event && this.event();
        if (!event || event.isErased()) return;
        if (HoN.Field && HoN.Field.spawnGhost) HoN.Field.spawnGhost(event);
        $gameSystem.setEventToUnit(event.eventId(), "null", null);
        event.setType("");
        event.erase();
        if (this.isEnemy()) $gameVariables.setValue(ENEMY_VAR, $gameVariables.value(ENEMY_VAR) - 1);
    };
})();
