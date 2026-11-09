//=============================================================================
// HoN_Targeting.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc [v0.1] Heroes of Nowhere - who can be targeted: sides, taunt, invisibility, marked targets.
 * @author Heroes of Nowhere
 * @base HoN_States
 * @orderAfter HoN_Actions
 *
 * @help
 * ============================================================================
 * Rules
 * ============================================================================
 * A single-target skill can't pick a unit when:
 *   - the skill has <target: enemy> and the unit is on the user's side, or
 *     <target: ally> and the unit is on the other side
 *   - the unit is an opponent with a state tagged "invisible"
 *   - the user has a state tagged "taunt" and the unit isn't the one who
 *     applied it (the taunter)
 *   - the unit was marked for one of the user's states (a volley that can't
 *     hit the same unit twice), while the user still has that state
 * The same rules apply to the player's cursor and to enemy AI.
 * Area skills still hit everyone in the area.
 *
 * ============================================================================
 * Script helpers (names kept from SRPG_ActionTypes)
 * ============================================================================
 *   b.gotTaunted(stateId)              taunt b toward the unit acting now
 *   a.setAsInvalidTarget(stateId, b)   while a has stateId, a can't target b
 *   a.blindEnd(stateId)                forget those marks
 *   a.setAsCurrentTarget(b)            remember b (shaman links)
 *   a.clearCurrentTargets(stateId)     remove stateId from everyone remembered
 *   (b may be a battler or an event id.)
 */

var Imported = Imported || {};
Imported.HoN_Targeting = "0.1";

(() => {
    "use strict";
    const T = (HoN.Targeting = {});

    const eventIdOf = (x) => (typeof x === "number" ? x : x && x.srpgEventId ? x.srpgEventId() : 0);
    const unitOfEvent = (eventId) => {
        const arr = eventId && $gameSystem.EventToUnit(eventId);
        return arr && (arr[0] === "actor" || arr[0] === "enemy") ? arr[1] : null;
    };

    //=========================================================================
    // The rule
    //=========================================================================
    // Side a skill aims at: its <target> tag, or else its database scope.
    T.wantedSide = function(item) {
        if (item.meta && item.meta.target) return String(item.meta.target).trim();
        if (item.meta && item.meta.anyTarget) return "";
        if ([1, 2, 3, 4, 5, 6].includes(item.scope)) return "enemy";
        if ([7, 8, 9, 10, 12, 13].includes(item.scope)) return "ally";
        return "";
    };

    T.reason = function(user, target, item) {
        if (!user || !target || !item || user === target) return null;
        const opponent = HoN.isOpponent(user, target);
        const want = T.wantedSide(item);
        if (want === "enemy" && !opponent) return "Escolha um inimigo.";
        if (want === "ally" && opponent) return "Escolha um aliado.";
        if (opponent) {
            if (target.hasStateTag("invisible")) return "Alvo invisível.";
            // a taunt only binds while the taunter is still standing on the map
            const taunts = user.states().filter((s) => {
                if (!(s.hon && s.hon.tags && s.hon.tags.includes("taunt"))) return false;
                const taunter = user.honOrigin(s.id);
                const event = taunter && taunter !== user && taunter.event && taunter.event();
                return event && !event.isErased() && taunter.isAlive();
            });
            if (taunts.length && !taunts.some((s) => user.honOrigin(s.id) === target)) {
                return "Provocado: só pode atacar quem o provocou.";
            }
        }
        const marks = user._honMarks || [];
        const tid = eventIdOf(target);
        if (marks.some(([stateId, eventId]) => eventId === tid && user.isStateAffected(stateId))) {
            return "Este alvo já foi atingido.";
        }
        return null;
    };

    T.canTarget = (user, target, item) => !T.reason(user, target, item);

    //=========================================================================
    // Player: confirming a unit as the target
    //=========================================================================
    const isAreaSkill = () => $gameTemp.isSkillAoE && $gameTemp.isSkillAoE();

    const _startMapEvent = Game_Player.prototype.startMapEvent;
    Game_Player.prototype.startMapEvent = function(x, y, triggers, normal) {
        if ($gameSystem.isSRPGMode() && $gameSystem.isSubBattlePhase() === "actor_target" &&
            !$gameMap.isEventRunning() && triggers.includes(0) && !isAreaSkill()) {
            const userEvent = $gameTemp.activeEvent();
            const user = userEvent && unitOfEvent(userEvent.eventId());
            const action = user && user.currentAction();
            const targetEvent = $gameMap.eventsXy(x, y).find((e) => !e.isErased() && unitOfEvent(e.eventId()));
            const target = targetEvent && unitOfEvent(targetEvent.eventId());
            const reason = target && action && T.reason(user, target, action.item());
            if (reason) {
                SoundManager.playBuzzer();
                T.say(reason);
                return;
            }
        }
        _startMapEvent.call(this, x, y, triggers, normal);
    };

    // A short line in the battle log window explaining a refused target.
    T.say = function(text) {
        const log = SceneManager._scene && SceneManager._scene._logWindow;
        if (!log) return;
        log.clear();
        log.addText(text);
        log.show();
        T._sayTimer = 90;
    };
    const _sceneUpdate = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _sceneUpdate.call(this);
        if (T._sayTimer > 0 && --T._sayTimer === 0 && this._logWindow && $gameSystem.isSubBattlePhase() === "actor_target") {
            this._logWindow.clear();
            this._logWindow.hide();
        }
    };

    //=========================================================================
    // AI: never consider a forbidden target
    //=========================================================================
    const aiAction = (battler) => battler && battler.currentAction() && battler.currentAction().item();

    const filterEvents = function(battler, events) {
        const item = aiAction(battler);
        if (!item) return events;
        return events.filter((e) => {
            const unit = e && unitOfEvent(e.eventId());
            return !unit || T.canTarget(battler, unit, item);
        });
    };

    const _makeCanAttack = Scene_Map.prototype.srpgMakeCanAttackTargets;
    Scene_Map.prototype.srpgMakeCanAttackTargets = function(battler, targetType) {
        return filterEvents(battler, _makeCanAttack.call(this, battler, targetType));
    };
    const _makeFromRoute = Scene_Map.prototype.srpgMakeCanAttackTargetsFromBestSearchRoute;
    Scene_Map.prototype.srpgMakeCanAttackTargetsFromBestSearchRoute = function(event, battler, targetType) {
        const list = _makeFromRoute.call(this, event, battler, targetType);
        const kept = filterEvents(battler, list);
        return kept.length ? kept : list; // still walk somewhere sensible
    };
    // SRPG_AIControl scores every candidate; a score of 0 means "not this one".
    if (Game_CharacterBase.prototype.targetScore) {
        const _targetScore = Game_CharacterBase.prototype.targetScore;
        Game_CharacterBase.prototype.targetScore = function(user, action, pos) {
            const unit = unitOfEvent(this.eventId && this.eventId());
            if (unit && action && action.item() && !T.canTarget(user, unit, action.item())) return 0;
            return _targetScore.call(this, user, action, pos);
        };
    }

    //=========================================================================
    // Script helpers
    //=========================================================================
    Game_BattlerBase.prototype.gotTaunted = function(stateId, eventId) {
        this.removeStatesWithTag("taunt");
        const taunter = unitOfEvent(eventId);
        const previous = HoN.currentSubject;
        if (taunter) HoN.currentSubject = taunter;
        try { this.addState(stateId); } finally { HoN.currentSubject = previous; }
    };
    Game_BattlerBase.prototype.tauntEnd = function() {}; // taunts end with their state now

    Game_BattlerBase.prototype.setAsInvalidTarget = function(stateId, target) {
        if (!this._honMarks) this._honMarks = [];
        this._honMarks.push([stateId, eventIdOf(target)]);
    };
    Game_BattlerBase.prototype.blindEnd = function(stateId) {
        if (this._honMarks) this._honMarks = this._honMarks.filter(([s]) => s !== stateId);
    };
    Game_BattlerBase.prototype.checkIfTargetValid = function(eventId) {
        const target = unitOfEvent(eventId);
        const action = this.currentAction && this.currentAction();
        return !target || !action || T.canTarget(this, target, action.item());
    };

    Game_BattlerBase.prototype.setAsCurrentTarget = function(target) {
        if (!Array.isArray(this._honLinked)) this._honLinked = [];
        const id = eventIdOf(target);
        if (id && !this._honLinked.includes(id)) this._honLinked.push(id);
    };
    Game_BattlerBase.prototype.clearCurrentTargets = function(stateId) {
        for (const id of this._honLinked || []) {
            const unit = unitOfEvent(id);
            if (unit && stateId) unit.removeState(stateId);
        }
        this._honLinked = [];
    };
})();
