//=============================================================================
// HoN_States.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc [v0.1] Heroes of Nowhere - states: durations, passives, params, tags, counters, scripts.
 * @author Heroes of Nowhere
 * @base HoN_Core
 * @orderAfter HoN_Core
 * @orderBefore HoN_Actions
 *
 * @help
 * ============================================================================
 * Durations
 * ============================================================================
 * In an SRPG battle, a state with "Auto-removal: Turn End" counts down at the
 * START of its applier's side's turn, and ends when it reaches 0:
 *   - a 1-turn debuff applied by an enemy lasts through the player's whole
 *     turn and ends when the enemies' next turn begins;
 *   - a 1-turn buff applied by a hero lasts through the enemy turn and ends
 *     when the heroes' next turn begins.
 * States nobody applied (events, passives) count on their owner's side.
 *
 * ============================================================================
 * State tags
 * ============================================================================
 *   <tags: buff, atkPlus>     labels used by scripts and other tags
 *   <keepOnDeath>             not removed when the unit falls
 *   <params>                  parameter changes while the state is on:
 *   ATK: +1                     one line per parameter
 *   DEF: a.mat                  (MHP MMP ATK DEF MAT MDF AGI LUK; formulas
 *   </params>                    allowed, a = the unit with the state)
 *   <moveBonus: formula>      extra Velocidade; "counter" = this state's counter
 *   <survive>                 a fatal hit leaves the unit at 1 HP (only if it
 *                             has more than 1 HP)
 *   <survive:once>            same, then the state is removed
 *   <passiveCondition>        for states given passively: return true/false
 *   ...                       to decide whether it's active right now
 *   </passiveCondition>
 *
 * ============================================================================
 * Passive states (actors, classes, skills, equipment, enemies)
 * ============================================================================
 *   <passiveState: 5>  or  <passiveState: 5, 7>
 *   Always on while the source is there (and its <passiveCondition> passes).
 *   Passive states don't count down and can't be removed by effects.
 *
 * ============================================================================
 * State scripts  <script:EVENT> ... </script>
 * ============================================================================
 * The unit that has the state ("owner"):
 *   add, remove          state added / removed (any reason)
 *   expire               removed because its duration ran out
 *   turnStart, turnEnd   start / end of the owner's side turn
 *   battleStart          start of each battle scene
 *   actionStart          owner starts an action
 *   actionEnd            owner finishes an action
 *       this = the owner;  a = user = target = the owner
 *
 * The owner uses an action:
 *   useStart             before the action affects each target
 *   dealDamage           before damage - change `value` to change the damage
 *   afterDealDamage      after damage
 *   useEnd               after the action is done with each target
 * The owner is targeted:
 *   targeted             before the action affects the owner
 *   takeDamage           before damage - change `value`
 *   afterTakeDamage      after damage
 *   targetedEnd          after the action is done with the owner
 *       this = the action (this.isPhysical(), this.isHpEffect() ...)
 *       a = user = the one acting;  b = target = the one being hit
 *
 * Always available: origin (who applied the state), state, stateId, value.
 *
 * ============================================================================
 * Script helpers on every unit
 * ============================================================================
 *   getStateCounter(id) setStateCounter(id, n) addStateCounter(id, n)
 *   hasStateTag('buff')          removeStatesWithTag('buff')
 *   (Yanfly's isStateCategoryAffected / removeStateCategoryAll still work.)
 */

var Imported = Imported || {};
Imported.HoN_States = "0.1";

(() => {
    "use strict";

    const PARAM_IDS = { MHP: 0, MMP: 1, ATK: 2, DEF: 3, MAT: 4, MDF: 5, AGI: 6, LUK: 7 };

    //=========================================================================
    // Compiling state scripts
    //=========================================================================
    const STATE_PRELUDE =
        "var user = a, subject = a, attacker = a, target = b, defender = b, skill = item;" +
        "var v = $gameVariables._data, s = $gameSwitches._data;\n";

    const _compileScript = HoN.compileScript;
    HoN.compileScript = function(kind, event, code, label) {
        if (kind !== "State") return _compileScript.call(this, kind, event, code, label);
        try {
            const fn = new Function("a", "b", "item", "value", "HoN", "origin", "state", "stateId",
                STATE_PRELUDE + code + "\nreturn value;");
            fn.label = label;
            fn.code = code;
            return fn;
        } catch (e) {
            HoN.reportError(label + " (syntax)", e, code);
            return null;
        }
    };

    // Runs one state script. Returns the (possibly changed) value.
    HoN.runStateScript = function(fn, self, a, b, item, value, origin, state) {
        if (!fn) return value;
        try {
            const result = fn.call(self, a, b, item, value, HoN, origin, state, state.id);
            return result === undefined ? value : result;
        } catch (e) {
            HoN.reportError(fn.label, e, fn.code);
            return value;
        }
    };

    //=========================================================================
    // Reading the tags
    //=========================================================================
    const _parseNotes = HoN.parseNotes;
    HoN.parseNotes = function(obj, kind) {
        _parseNotes.call(this, obj, kind);
        const hon = obj.hon;
        const note = obj.note || "";
        const label = `${kind} ${obj.id} ${obj.name}`;
        const flat = note
            .replace(/<script:\s*\w+\s*>[\s\S]*?<\/script>/gi, "")
            .replace(/<(showScript|requireScript|passiveCondition|params)>[\s\S]*?<\/\1>/gi, "");

        // passive states (any kind of object)
        hon.passiveStates = [];
        for (const m of flat.matchAll(/<passiveState:\s*([^>]+)>/gi)) {
            for (const id of m[1].split(",")) if (Number(id)) hon.passiveStates.push(Number(id));
        }
        if (kind !== "State") return;

        const tagsMatch = flat.match(/<tags:\s*([^>]+)>/i);
        hon.tags = tagsMatch ? tagsMatch[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
        hon.keepOnDeath = /<keepOnDeath>/i.test(flat);
        const survive = flat.match(/<survive(?::\s*(\w+))?>/i);
        hon.survive = survive ? (survive[1] ? survive[1].toLowerCase() : "always") : null;

        const move = flat.match(/<moveBonus:\s*([^>]+)>/i);
        if (move) {
            const expr = move[1].trim().replace(/\bcounter\b/g, `a.getStateCounter(${obj.id})`);
            hon.moveBonus = HoN.compileExpression(expr, `${label} <moveBonus>`);
        }

        hon.params = [];
        const params = note.match(/<params>([\s\S]*?)<\/params>/i);
        if (params) {
            for (const line of params[1].split(/[\r\n]+/)) {
                const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*;?\s*$/);
                if (!m) continue;
                const paramId = PARAM_IDS[m[1].toUpperCase()];
                if (paramId === undefined) {
                    HoN.reportError(`${label} <params>`, new Error(`unknown parameter "${m[1]}"`));
                    continue;
                }
                const expr = m[2].replace(/\bcounter\b/g, `a.getStateCounter(${obj.id})`);
                hon.params.push({ paramId, fn: HoN.compileExpression(expr, `${label} <params> ${m[1]}`) });
            }
        }

        const cond = note.match(/<passiveCondition>([\s\S]*?)<\/passiveCondition>/i);
        if (cond) hon.passiveCondition = HoN.compile(cond[1], `${label} <passiveCondition>`);
    };

    //=========================================================================
    // Counters (a number stored on a state while it's on the unit)
    //=========================================================================
    Game_BattlerBase.prototype.getStateCounter = function(stateId) {
        return (this._honCounters && this._honCounters[stateId]) || 0;
    };
    Game_BattlerBase.prototype.setStateCounter = function(stateId, value) {
        if (!this._honCounters) this._honCounters = {};
        this._honCounters[stateId] = Number(value) || 0;
    };
    Game_BattlerBase.prototype.addStateCounter = function(stateId, value) {
        this.setStateCounter(stateId, this.getStateCounter(stateId) + (Number(value) || 0));
    };
    Game_BattlerBase.prototype.removeStateCounter = function(stateId) {
        if (this._honCounters) delete this._honCounters[stateId];
    };

    //=========================================================================
    // Tags
    //=========================================================================
    Game_BattlerBase.prototype.hasStateTag = function(tag) {
        tag = String(tag).toLowerCase();
        return this.states().some((s) => s.hon && s.hon.tags && s.hon.tags.includes(tag));
    };
    Game_BattlerBase.prototype.removeStatesWithTag = function(tag) {
        tag = String(tag).toLowerCase();
        for (const id of this._states.slice()) {
            const s = $dataStates[id];
            if (s && s.hon && s.hon.tags.includes(tag)) this.removeState(id);
        }
    };
    Game_BattlerBase.prototype.isStateCategoryAffected = Game_BattlerBase.prototype.hasStateTag;
    Game_BattlerBase.prototype.removeStateCategoryAll = Game_BattlerBase.prototype.removeStatesWithTag;

    //=========================================================================
    // Origin: who applied each state
    //=========================================================================
    HoN.currentSubject = null; // set while an action is being applied

    const actingUnit = () => {
        if (HoN.currentSubject) return HoN.currentSubject;
        const event = $gameTemp && $gameTemp.activeEvent();
        const arr = event && $gameSystem.EventToUnit(event.eventId());
        return arr ? arr[1] : null;
    };

    Game_BattlerBase.prototype.honSetOrigin = function(stateId, battler) {
        if (!this._honOrigins) this._honOrigins = {};
        battler = battler || this;
        this._honOrigins[stateId] = {
            ref: battler.isActor() ? ["a", battler.actorId()] : ["e", battler.srpgEventId ? battler.srpgEventId() : 0],
            side: HoN.teamOf(battler),
        };
    };
    Game_BattlerBase.prototype.honOrigin = function(stateId) {
        const o = this._honOrigins && this._honOrigins[stateId];
        if (!o) return this;
        if (o.ref[0] === "a") return $gameActors.actor(o.ref[1]) || this;
        const arr = o.ref[1] && $gameSystem.EventToUnit(o.ref[1]);
        return arr && arr[1] ? arr[1] : this;
    };
    Game_BattlerBase.prototype.honOriginSide = function(stateId) {
        const o = this._honOrigins && this._honOrigins[stateId];
        return o ? o.side : HoN.teamOf(this);
    };
    Game_BattlerBase.prototype.stateOrigin = Game_BattlerBase.prototype.honOrigin; // Yanfly name

    //=========================================================================
    // Passive states
    //=========================================================================
    Game_BattlerBase.prototype.honPassiveSources = function() {
        if (this.isActor()) {
            return [this.actor(), this.currentClass(), ...this.equips(), ...this.skills()].filter(Boolean);
        }
        if (this.isEnemy()) return [this.enemy()];
        return [];
    };

    Game_BattlerBase.prototype.honPassiveStateIds = function() {
        if (this._honPassiveBusy || !$dataStates) return [];
        if (this._honPassiveCache && this._honPassiveFrame === Graphics.frameCount) return this._honPassiveCache;
        this._honPassiveBusy = true;
        const ids = [];
        try {
            for (const src of this.honPassiveSources()) {
                for (const id of (src.hon && src.hon.passiveStates) || []) {
                    const state = $dataStates[id];
                    if (!state || ids.includes(id) || this._states.includes(id)) continue;
                    const cond = state.hon && state.hon.passiveCondition;
                    if (cond && !HoN.run(cond, this, null, state, 0, false)) continue;
                    ids.push(id);
                }
            }
        } finally {
            this._honPassiveBusy = false;
        }
        this._honPassiveCache = ids;
        this._honPassiveFrame = Graphics.frameCount;
        return ids;
    };

    // Anything that can change a passive condition clears the cache.
    const _refresh = Game_BattlerBase.prototype.refresh;
    Game_BattlerBase.prototype.refresh = function() {
        this._honPassiveCache = null;
        _refresh.call(this);
        this._honPassiveCache = null;
    };

    const _states = Game_BattlerBase.prototype.states;
    Game_BattlerBase.prototype.states = function() {
        const list = _states.call(this);
        const passive = this.honPassiveStateIds();
        return passive.length ? list.concat(passive.map((id) => $dataStates[id])) : list;
    };

    const _isStateAffected = Game_BattlerBase.prototype.isStateAffected;
    Game_BattlerBase.prototype.isStateAffected = function(stateId) {
        return _isStateAffected.call(this, stateId) || this.honPassiveStateIds().includes(stateId);
    };

    //=========================================================================
    // Parameters from <params>
    //=========================================================================
    const _paramPlus = Game_BattlerBase.prototype.paramPlus;
    Game_BattlerBase.prototype.paramPlus = function(paramId) {
        let value = _paramPlus.call(this, paramId);
        if (!this._honParamBusy) this._honParamBusy = [];
        if (this._honParamBusy[paramId]) return value; // e.g. DEF: a.def would loop
        this._honParamBusy[paramId] = true;
        try {
            for (const state of this.states()) {
                for (const p of (state.hon && state.hon.params) || []) {
                    if (p.paramId === paramId) value += Number(HoN.run(p.fn, this, null, state, 0, 0)) || 0;
                }
            }
        } finally {
            this._honParamBusy[paramId] = false;
        }
        return value;
    };

    //=========================================================================
    // Movement from <moveBonus>
    //=========================================================================
    for (const cls of [Game_Actor, Game_Enemy]) {
        const _srpgMove = cls.prototype.srpgMove;
        cls.prototype.srpgMove = function() {
            let n = _srpgMove.call(this);
            for (const state of this.states()) {
                if (state.hon && state.hon.moveBonus) {
                    n += Number(HoN.run(state.hon.moveBonus, this, null, state, 0, 0)) || 0;
                }
            }
            return Math.max(Math.floor(n), 0);
        };
    }

    //=========================================================================
    // Battler events: add / remove / expire / turn / battle / action
    //=========================================================================
    const fireOne = (battler, state, event) => {
        const fn = state && state.hon && state.hon.scripts[event];
        if (fn) HoN.runStateScript(fn, battler, battler, battler, null, 0, battler.honOrigin(state.id), state);
    };
    HoN.fireStates = function(battler, event) {
        for (const state of battler.states()) fireOne(battler, state, event);
    };

    const _addState = Game_Battler.prototype.addState;
    Game_Battler.prototype.addState = function(stateId) {
        const addable = this.isStateAddable(stateId);
        _addState.call(this, stateId);
        if (addable && this._states.includes(stateId)) {
            this.honSetOrigin(stateId, actingUnit());
            fireOne(this, $dataStates[stateId], "add");
        }
    };

    HoN._expiring = false;
    const _removeState = Game_Battler.prototype.removeState;
    Game_Battler.prototype.removeState = function(stateId) {
        const had = this._states.includes(stateId);
        _removeState.call(this, stateId);
        if (had && !this._states.includes(stateId)) {
            const state = $dataStates[stateId];
            fireOne(this, state, "remove");
            if (HoN._expiring) fireOne(this, state, "expire");
        }
    };

    const _eraseState = Game_BattlerBase.prototype.eraseState;
    Game_BattlerBase.prototype.eraseState = function(stateId) {
        _eraseState.call(this, stateId);
        this.removeStateCounter(stateId);
        if (this._honOrigins) delete this._honOrigins[stateId];
    };

    // <keepOnDeath>
    const _die = Game_BattlerBase.prototype.die;
    Game_BattlerBase.prototype.die = function() {
        const kept = this._states.filter((id) => $dataStates[id].hon && $dataStates[id].hon.keepOnDeath)
            .map((id) => ({ id, turns: this._stateTurns[id], counter: this._honCounters && this._honCounters[id],
                origin: this._honOrigins && this._honOrigins[id] }));
        _die.call(this);
        for (const k of kept) {
            if (!this._states.includes(k.id)) this._states.push(k.id);
            this._stateTurns[k.id] = k.turns;
            if (k.counter !== undefined) this.setStateCounter(k.id, k.counter);
            if (k.origin) { this._honOrigins = this._honOrigins || {}; this._honOrigins[k.id] = k.origin; }
        }
        if (kept.length) this.sortStates();
    };

    const _onBattleStart = Game_Battler.prototype.onBattleStart;
    Game_Battler.prototype.onBattleStart = function(advantageous) {
        _onBattleStart.call(this, advantageous);
        HoN.fireStates(this, "battlestart");
    };

    //=========================================================================
    // Durations: count down at the start of the applier's side's turn
    //=========================================================================
    HoN.allUnits = function() {
        const list = [];
        for (const event of $gameMap.events()) {
            if (event.isErased()) continue;
            const arr = $gameSystem.EventToUnit(event.eventId());
            if (arr && arr[1] && (arr[0] === "actor" || arr[0] === "enemy")) list.push(arr[1]);
        }
        return list;
    };

    HoN.tickStates = function(side) {
        for (const unit of HoN.allUnits()) {
            for (const id of unit._states.slice()) {
                const state = $dataStates[id];
                if (state.autoRemovalTiming !== 2 || unit.honOriginSide(id) !== side) continue;
                if (unit._stateTurns[id] > 0) unit._stateTurns[id]--;
                if (unit._stateTurns[id] <= 0) {
                    HoN._expiring = true;
                    try { unit.removeState(id); } finally { HoN._expiring = false; }
                }
            }
            if (HoN.teamOf(unit) === side) HoN.fireStates(unit, "turnstart");
        }
    };

    // Gear counts "Turn End" states once per round, after the enemy phase.
    const _updateSrpgStateTurns = Game_BattlerBase.prototype.updateSrpgStateTurns;
    Game_BattlerBase.prototype.updateSrpgStateTurns = function(timing) {
        if (timing === 2 && $gameSystem.isSRPGMode()) return;
        _updateSrpgStateTurns.call(this, timing);
    };

    const _srpgStartActorTurn = Game_System.prototype.srpgStartActorTurn;
    Game_System.prototype.srpgStartActorTurn = function() {
        HoN.tickStates("actor");
        _srpgStartActorTurn.call(this);
    };
    const _srpgStartEnemyTurn = Game_System.prototype.srpgStartEnemyTurn;
    Game_System.prototype.srpgStartEnemyTurn = function() {
        HoN.tickStates("enemy");
        _srpgStartEnemyTurn.call(this);
    };

    // turnEnd scripts: at the end of the round, for everyone.
    const _onTurnEnd = Game_Battler.prototype.onTurnEnd;
    Game_Battler.prototype.onTurnEnd = function() {
        _onTurnEnd.call(this);
        if ($gameSystem.isSRPGMode()) HoN.fireStates(this, "turnend");
    };

    // actionStart / actionEnd for the unit that acts.
    const _srpgBattleStart = Scene_Map.prototype.srpgBattleStart;
    Scene_Map.prototype.srpgBattleStart = function(userArray, targetArray) {
        if (userArray && userArray[1]) HoN.fireStates(userArray[1], "actionstart");
        return _srpgBattleStart.call(this, userArray, targetArray);
    };
    const _srpgAfterAction = Scene_Map.prototype.srpgAfterAction;
    Scene_Map.prototype.srpgAfterAction = function() {
        const event = $gameTemp.activeEvent();
        const arr = event && $gameSystem.EventToUnit(event.eventId());
        if (arr && arr[1] && arr[1]._honPending) HoN.fireStates(arr[1], "actionend");
        _srpgAfterAction.call(this);
    };

    //=========================================================================
    // Action events
    //=========================================================================
    HoN.fireActionStates = function(action, event, owner, a, b, value) {
        for (const state of owner.states()) {
            const fn = state.hon && state.hon.scripts[event];
            if (fn) value = HoN.runStateScript(fn, action, a, b, action.item(), value, owner.honOrigin(state.id), state);
        }
        return value;
    };

    const _apply = Game_Action.prototype.apply;
    Game_Action.prototype.apply = function(target) {
        const subject = this.subject();
        const previous = HoN.currentSubject;
        HoN.currentSubject = subject;
        try {
            HoN.fireActionStates(this, "usestart", subject, subject, target, 0);
            HoN.fireActionStates(this, "targeted", target, subject, target, 0);
            _apply.call(this, target);
            HoN.fireActionStates(this, "targetedend", target, subject, target, 0);
            HoN.fireActionStates(this, "useend", subject, subject, target, 0);
        } finally {
            HoN.currentSubject = previous;
        }
    };

    const _executeDamage = Game_Action.prototype.executeDamage;
    Game_Action.prototype.executeDamage = function(target, value) {
        const subject = this.subject();
        value = HoN.fireActionStates(this, "dealdamage", subject, subject, target, value);
        value = HoN.fireActionStates(this, "takedamage", target, subject, target, value);
        // <survive>
        let spent = null;
        if (this.isHpEffect() && value > 0 && value >= target.hp && target.hp > 1) {
            const state = target.states().find((s) => s.hon && s.hon.survive);
            if (state) {
                value = target.hp - 1;
                if (state.hon.survive === "once") spent = state.id;
            }
        }
        _executeDamage.call(this, target, value);
        if (spent) target.removeState(spent);
        value = HoN.fireActionStates(this, "aftertakedamage", target, subject, target, value);
        HoN.fireActionStates(this, "afterdealdamage", subject, subject, target, value);
    };
})();
